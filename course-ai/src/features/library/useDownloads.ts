import { listen } from "@tauri-apps/api/event";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { ipc, type DownloadBatchDoneEvent, type DownloadJob } from "@/lib/ipc";
import { qk } from "@/lib/queryKeys";
import { useDownloads } from "@/stores/downloads";

/**
 * 后台下载队列的全局接线：启动时用后端快照补齐、完成时刷新视频列表、
 * 一批下完后刷新处理队列。在 Home 实例化一次。
 *
 * 队列数据本身在 zustand（stores/downloads）里，列表与队列页直接读，
 * 不必经 shell 层层传。
 */
export function useDownloadsSync() {
  const queryClient = useQueryClient();
  const seed = useDownloads((s) => s.seed);
  const clearFinished = useDownloads((s) => s.clearFinished);
  const doneSeen = useRef<Set<string>>(new Set());

  useEffect(() => {
    let alive = true;
    void ipc.downloads
      .list()
      .then((jobs) => {
        if (alive) seed(jobs);
      })
      .catch(() => {
        // 后端旧版本/启动瞬间读不到队列：忽略，后续事件仍会填充。
      });
    return () => {
      alive = false;
    };
  }, [seed]);

  // 视频已经入库：马上刷新课程列表，占位行换成真实视频。
  // 在 store 外订阅，不用 hook 选 byId：进度事件一秒好几条，用 hook 会让挂着它的
  // Home 整棵树跟着每条进度重渲染，而这里只关心「变成 done」这一下。
  useEffect(() => {
    const seen = doneSeen.current;
    const refreshDone = (byId: Record<string, DownloadJob>) => {
      for (const job of Object.values(byId)) {
        if (job.status !== "done" || seen.has(job.id)) continue;
        seen.add(job.id);
        void queryClient.invalidateQueries({ queryKey: qk.videos.list(job.courseId) });
      }
    };
    refreshDone(useDownloads.getState().byId);
    return useDownloads.subscribe((state, previous) => {
      if (state.byId !== previous.byId) refreshDone(state.byId);
    });
  }, [queryClient]);

  // 一批全部下完：后端统一起流水线。清掉占位记录，让处理队列接上。
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    void listen<DownloadBatchDoneEvent>("download:batch-done", ({ payload }) => {
      clearFinished(payload.courseId);
      void queryClient.invalidateQueries({ queryKey: qk.videos.list(payload.courseId) });
      void queryClient.invalidateQueries({ queryKey: qk.processingVideos() });
    })
      .then((fn) => {
        unlisten = fn;
      })
      // 无 Tauri 运行时（测试/浏览器预览）里事件接口不可用；队列本身仍能靠快照工作。
      .catch(() => {});
    return () => unlisten?.();
  }, [clearFinished, queryClient]);
}
