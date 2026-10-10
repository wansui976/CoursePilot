import { listen } from "@tauri-apps/api/event";
import type { QueryClient } from "@tanstack/react-query";
import { qk } from "@/lib/queryKeys";

let started = false;

/**
 * 订阅在后台自动导入了新视频：刷新该课程的视频列表与订阅状态，课程库里立刻能看到。
 * 进度与完成提醒由处理流水线的 job 事件与系统通知负责。
 */
export function startSubscriptionListener(queryClient: QueryClient) {
  if (started) return;
  started = true;
  void listen<{ courseId: string }>("subscriptions-imported", (event) => {
    void queryClient.invalidateQueries({ queryKey: qk.videos.list(event.payload.courseId) });
    void queryClient.invalidateQueries({ queryKey: qk.subscriptions(event.payload.courseId) });
    void queryClient.invalidateQueries({ queryKey: qk.courses() });
  });
}
