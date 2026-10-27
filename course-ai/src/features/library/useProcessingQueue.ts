import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ipc } from "@/lib/ipc";
import { qk } from "@/lib/queryKeys";
import { humanizeError } from "@/lib/errors";
import { currentStage, overallProgress } from "@/lib/pipelineProgress";
import type { Video } from "@/lib/types";
import { useJobs, type JobUpdate } from "@/stores/jobs";

export type JobLoadState =
  | { status: "loading" }
  | { status: "ready" }
  | { status: "error"; error: unknown };

/** 怀疑队列项对应的视频已被删除时，先等这么久再向后端核实（给后端写好 failed 状态的时间）。 */
export const GONE_VERIFY_DELAY_MS = 2_000;

/** 后端对已删除/不存在的视频统一返回 `not found: video <id>`。 */
function isVideoGone(error: unknown) {
  const text = error instanceof Error ? error.message : String(error);
  return /not found:\s*video/i.test(text);
}

/**
 * 处理队列：排队/处理中的视频、各视频流水线任务的加载状态与进度估算，以及开始、
 * 取消、重试、移出等操作。后端各阶段完成时顺带刷新对应面板的缓存。
 *
 * 在 Home 实例化一次，队列页、课程库卡片与 rail 徽标共用同一份状态。
 */
export function useProcessingQueue({
  selectedCourseId,
}: {
  /** AI 产物完成时刷新当前课程的视频列表（has_* 标记）。 */
  selectedCourseId: string | null;
}) {
  const queryClient = useQueryClient();
  const jobsByVideo = useJobs((s) => s.byVideo);
  const setJob = useJobs((s) => s.setOne);
  const seedJob = useJobs((s) => s.seed);
  const resetJobs = useJobs((s) => s.resetVideo);
  const generatedAfterAsr = useRef<Set<string>>(new Set());
  const [queuedVideos, setQueuedVideos] = useState<Video[]>([]);
  // 队列卡片的 jobs 是独立 IPC 请求；没有这层状态时，失败会落成「没有阶段」并显示等待中。
  const [jobLoadStateByVideo, setJobLoadStateByVideo] = useState<
    Record<string, JobLoadState>
  >({});
  const jobRequestRef = useRef<Record<string, number>>({});
  const requestedJobIdsRef = useRef<Set<string>>(new Set());
  // 本机刚点「开始处理」的视频：给 active 列表一点时间把它算进去，别立刻当成已删除。
  const queuedAtRef = useRef<Record<string, number>>({});

  const {
    data: activeProcessingData,
    isSuccess: activeProcessingSuccess,
    isError: activeProcessingError,
    error: activeProcessingErrorObj,
    isLoading: activeProcessingLoading,
    refetch: refetchActiveProcessing,
  } = useQuery({
    queryKey: qk.processingVideos(),
    queryFn: ipc.pipeline.active,
  });
  const activeProcessingVideos = useMemo(
    () => activeProcessingData ?? [],
    [activeProcessingData],
  );

  const loadJobsForVideo = useCallback(
    (videoId: string) => {
      const requestId = (jobRequestRef.current[videoId] ?? 0) + 1;
      jobRequestRef.current[videoId] = requestId;
      setJobLoadStateByVideo((states) => ({
        ...states,
        [videoId]: { status: "loading" },
      }));
      void ipc.pipeline
        .jobs(videoId)
        .then((rows) => {
          if (jobRequestRef.current[videoId] !== requestId) return;
          rows.forEach((job) =>
            seedJob({
              video_id: job.video_id,
              job_id: job.id,
              stage: job.stage,
              status: job.status,
              progress: job.progress,
              message: job.message,
            }),
          );
          setJobLoadStateByVideo((states) => ({
            ...states,
            [videoId]: { status: "ready" },
          }));
        })
        .catch((error: unknown) => {
          if (jobRequestRef.current[videoId] !== requestId) return;
          setJobLoadStateByVideo((states) => ({
            ...states,
            [videoId]: { status: "error", error },
          }));
        });
    },
    [seedJob],
  );

  const retryJobsForVideo = useCallback(
    (videoId: string) => {
      requestedJobIdsRef.current.add(videoId);
      loadJobsForVideo(videoId);
    },
    [loadJobsForVideo],
  );

  const retryActiveProcessing = useCallback(async () => {
    // active 查询重试时同步清掉 jobs 的去重标记，否则同一批视频会继续显示旧错误。
    for (const video of activeProcessingVideos) {
      requestedJobIdsRef.current.delete(video.id);
    }
    const result = await refetchActiveProcessing();
    for (const video of result.data ?? activeProcessingVideos) {
      requestedJobIdsRef.current.add(video.id);
      loadJobsForVideo(video.id);
    }
  }, [activeProcessingVideos, loadJobsForVideo, refetchActiveProcessing]);

  useEffect(() => {
    if (activeProcessingSuccess) {
      setQueuedVideos((items) => {
        const known = new Set(items.map((item) => item.id));
        const recovered = activeProcessingVideos.filter((video) => !known.has(video.id));
        return recovered.length > 0 ? [...recovered, ...items] : items;
      });
    }
    const processing = new Map<string, Video>();
    [
      ...(activeProcessingSuccess ? activeProcessingVideos : []),
      ...queuedVideos,
    ].forEach((video) =>
      processing.set(video.id, video),
    );
    for (const video of processing.values()) {
      if (requestedJobIdsRef.current.has(video.id)) continue;
      requestedJobIdsRef.current.add(video.id);
      loadJobsForVideo(video.id);
    }
    for (const videoId of [...requestedJobIdsRef.current]) {
      if (!processing.has(videoId)) {
        requestedJobIdsRef.current.delete(videoId);
        delete jobRequestRef.current[videoId];
        setJobLoadStateByVideo((states) => {
          if (!(videoId in states)) return states;
          const next = { ...states };
          delete next[videoId];
          return next;
        });
      }
    }
  }, [activeProcessingSuccess, activeProcessingVideos, loadJobsForVideo, queuedVideos]);

  // 视频被删掉后，active 列表不再返回它，但本地队列状态不会自己消失；失败项继续留着，
  // 用户点「重试」只会一遍遍撞 NotFound。
  //
  // 但缓存里的 active 列表不能直接当证据：开始处理、处理失败时都没人刷新它，刚失败的
  // 视频本来就不在旧缓存里——按旧缓存清理，会把用户还没看到的错误连同「重试」一起吞掉。
  // 所以只把它当「嫌疑」：等后端把 failed 状态写好，再重新拉一次；新列表里确实没有
  // （失败的视频只要还在，active 一定会返回它）才清掉。刚点开始处理的有 10 秒宽限。
  const verifyingGoneRef = useRef<Set<string>>(new Set());
  const mountedRef = useRef(true);
  useEffect(
    () => () => {
      mountedRef.current = false;
    },
    [],
  );
  useEffect(() => {
    if (!activeProcessingSuccess) return;
    const activeIds = new Set(activeProcessingVideos.map((video) => video.id));
    const now = Date.now();
    const suspects = queuedVideos
      .filter((item) => {
        if (activeIds.has(item.id) || verifyingGoneRef.current.has(item.id)) return false;
        if (now - (queuedAtRef.current[item.id] ?? 0) < 10_000) return false;
        return Object.values(jobsByVideo[item.id] ?? {}).some((job) => job.status === "failed");
      })
      .map((item) => item.id);
    if (suspects.length === 0) return;
    // 计时器不随依赖变化清掉：jobsByVideo 随别的视频的进度事件不停变，清了就永远等不到。
    suspects.forEach((id) => verifyingGoneRef.current.add(id));
    window.setTimeout(() => {
      void refetchActiveProcessing().then((result) => {
        suspects.forEach((id) => verifyingGoneRef.current.delete(id));
        if (!mountedRef.current || !result.isSuccess) return;
        const fresh = new Set((result.data ?? []).map((video) => video.id));
        const gone = new Set(suspects.filter((id) => !fresh.has(id)));
        if (gone.size === 0) return;
        setQueuedVideos((items) => items.filter((item) => !gone.has(item.id)));
        for (const id of gone) {
          delete queuedAtRef.current[id];
          resetJobs(id);
        }
      });
    }, GONE_VERIFY_DELAY_MS);
  }, [
    activeProcessingSuccess,
    activeProcessingVideos,
    jobsByVideo,
    queuedVideos,
    refetchActiveProcessing,
    resetJobs,
  ]);

  // 课件抽取、文字识别、章节、摘要、笔记、出题、脑图全部由后端流水线作为可见任务
  // 自动续跑（见 pipeline::run_all / run_ai_followups），用户无需手动点「生成」。
  // 这里只负责在各任务完成时刷新对应面板。
  //
  // 这里**不能**再自己调一次课件抽取：课件抽取已经是后端流水线的一步，前端再补一次
  // 就是整段视频解码两遍；而且写课件页是「先清空该视频的所有页再重写」，第二遍会把
  // 第一遍连同已经认出来的页面文字一起抹掉。
  useEffect(() => {
    // 注意：以 jobsByVideo 为遍历源，而非 queuedVideoIds——这样视频处理完成
    // 出队后，后端续跑的 AI 任务完成时仍能刷新对应面板。
    Object.keys(jobsByVideo).forEach((videoId) => {
      const jobs = jobsByVideo[videoId];
      if (!jobs) return;
      // 文稿在 ASR 完成时已经落库。只在该阶段首次进入 done 时刷新一次视频列表，
      // 这样即使没有配置 LLM、后续 AI 任务全被取消，菜单也能拿到最新的 has_transcript。
      const asrKey = `${videoId}:asr`;
      if (jobs.asr?.status === "done" && !generatedAfterAsr.current.has(asrKey)) {
        generatedAfterAsr.current.add(asrKey);
        queryClient.invalidateQueries({ queryKey: qk.videos.all() });
      }
      for (const stage of ["slides", "slides_ocr"] as const) {
        const key = `${videoId}:${stage}`;
        if (jobs[stage]?.status === "done" && !generatedAfterAsr.current.has(key)) {
          generatedAfterAsr.current.add(key);
          queryClient.invalidateQueries({ queryKey: qk.slides(videoId) });
          // OCR 只补页面文字，不改变换页时间；只在 slides 真正重提取后重规划跳停顿。
          if (stage === "slides") {
            queryClient.invalidateQueries({ queryKey: qk.silenceSkips(videoId) });
          }
        }
      }
      // 后端各 AI 任务完成 → 刷新对应面板（各刷一次）。
      for (const stage of ["chapters", "summary", "notes", "quiz", "mindmap"] as const) {
        const key = `${videoId}:${stage}`;
        if (jobs[stage]?.status === "done" && !generatedAfterAsr.current.has(key)) {
          generatedAfterAsr.current.add(key);
          queryClient.invalidateQueries({ queryKey: qk.artifact(stage, videoId) });
          queryClient.invalidateQueries({ queryKey: qk.videos.list(selectedCourseId) });
        }
      }
    });
  }, [jobsByVideo, queryClient, selectedCourseId]);

  // 处理完成（asr 完成或被取消）后把视频移出处理队列；失败的保留以显示错误。
  // 留一点时间让用户看到 100% 再消失。后端续跑的 AI 任务在后台继续，不影响视频已可用。
  useEffect(() => {
    const timers: number[] = [];
    queuedVideos.forEach((video) => {
      const active = activeJobFor(video.id);
      if (active?.status === "done" || active?.status === "canceled") {
        timers.push(
          window.setTimeout(() => {
            setQueuedVideos((items) =>
              items.filter((item) => item.id !== video.id),
            );
          }, 1200),
        );
      }
    });
    return () => timers.forEach((timer) => window.clearTimeout(timer));
    // activeJobFor 只读 jobsByVideo，已在依赖里；它本身每次渲染重建，加进去反而每帧重跑。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobsByVideo, queuedVideos]);

  function startProcessing(video: Video) {
    const videoId = video.id;
    queuedAtRef.current[videoId] = Date.now();
    // 清掉这个视频的全部「已处理」标记：不仅 videoId，还有各 AI 阶段的
    // `${videoId}:${stage}`。否则重新处理后，阶段键仍在集合里，后端续跑的
    // 章节/摘要/笔记/出题/脑图完成时不会触发面板刷新，用户会看到旧内容。
    for (const key of [...generatedAfterAsr.current]) {
      if (key === videoId || key.startsWith(`${videoId}:`)) {
        generatedAfterAsr.current.delete(key);
      }
    }
    resetJobs(videoId);
    if (dismissProcessing.variables === videoId) dismissProcessing.reset();
    setQueuedVideos((items) => {
      const existing = items.some((item) => item.id === videoId);
      return existing
        ? items.map((item) => (item.id === videoId ? video : item))
        : [video, ...items];
    });
    void ipc.pipeline.process(videoId).catch((error) => {
      setJob({
        video_id: videoId,
        job_id: `start-${videoId}`,
        stage: "audio",
        status: "failed",
        progress: 0,
        message: humanizeError(error),
      });
    });
  }

  const dismissProcessing = useMutation({
    mutationFn: async (videoId: string) => {
      try {
        await ipc.pipeline.dismiss(videoId);
      } catch (error) {
        // 回收站清空后视频行已被彻底删掉，后端分不清这和传错 id，只能报 NotFound。
        // 对「移除」来说目的已经达到：队列项本来就该消失，不能留一条永远去不掉的红字。
        if (isVideoGone(error)) return;
        throw error;
      }
    },
    onSuccess: (_data, videoId) => {
      setQueuedVideos((items) => items.filter((item) => item.id !== videoId));
      queryClient.setQueryData<Video[]>(["processing-videos"], (items) =>
        items?.filter((item) => item.id !== videoId),
      );
      resetJobs(videoId);
      delete queuedAtRef.current[videoId];
    },
  });

  function removeQueuedVideo(videoId: string) {
    if (dismissProcessing.isPending) return;
    dismissProcessing.mutate(videoId);
  }

  // 批量「全部取消」：逐个取消运行中/排队中的任务（各自失败互不影响）。
  function cancelAllProcessing() {
    for (const video of queuedVideos) {
      const job = activeJobFor(video.id);
      const canCancel = job?.status === "running" || job?.status === "pending";
      if (canCancel) void ipc.pipeline.cancel(video.id);
    }
  }

  // 批量「全部重试」：逐个重新开始已失败的任务。
  function retryFailedAll() {
    for (const video of queuedVideos) {
      if (activeJobFor(video.id)?.status === "failed") startProcessing(video);
    }
  }

  function activeJobFor(videoId: string) {
    return currentStage(jobsByVideo[videoId] ?? {}) as JobUpdate | undefined;
  }

  /** 整条流水线的完成度：识别做完只是开头，后面还有课件与五个 AI 步骤。
   *  照后端报的算，不再按时间估：识别、纠错都有真进度了，估算一跑到真进度前头，
   *  下一条真进度一来进度条就往回跳。报不出进度的云端识别由后端按耗时往前爬。 */
  function pipelineProgressFor(videoId: string) {
    return overallProgress(jobsByVideo[videoId] ?? {});
  }

  const forgetQueuedVideo = useCallback((videoId: string) => {
    setQueuedVideos((items) => items.filter((item) => item.id !== videoId));
  }, []);

  return {
    queuedVideos,
    jobLoadStateByVideo,
    activeProcessingLoading,
    activeProcessingError,
    activeProcessingErrorObj,
    retryActiveProcessing,
    retryJobsForVideo,
    startProcessing,
    dismissProcessing,
    removeQueuedVideo,
    cancelAllProcessing,
    retryFailedAll,
    activeJobFor,
    pipelineProgressFor,
    forgetQueuedVideo,
  };
}

export type ProcessingQueue = ReturnType<typeof useProcessingQueue>;
