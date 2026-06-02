import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Check,
  ChevronLeft,
  CheckCircle2,
  Clock3,
  Download,
  Film,
  ListVideo,
  MoreHorizontal,
  Moon,
  Play,
  Settings,
  Sparkles,
  Sun,
  X,
} from "lucide-react";
import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { CourseSidebar } from "@/components/CourseSidebar";
import { ImportVideoButton } from "@/components/ImportVideoDialog";
import { SettingsPanel } from "@/components/SettingsDialog";
import { TabsPanel } from "@/components/TabsPanel";
import { VideoCover } from "@/components/VideoCover";
import { Button } from "@/components/ui/button";
import { VideoPlayer } from "@/components/VideoPlayer";
import { ipc } from "@/lib/ipc";
import { formatMs } from "@/lib/time";
import { usePlayer } from "@/stores/player";
import { useJobs, type JobUpdate } from "@/stores/jobs";

const statusMeta = {
  pending: {
    label: "待处理",
    className: "text-[var(--text-muted)] bg-[var(--border-faint)]",
  },
  processing: {
    label: "处理中",
    className: "text-[var(--status-warn)] bg-[var(--status-warn-bg)]",
  },
  done: {
    label: "已处理",
    className: "text-[var(--status-ok)] bg-[var(--status-ok-bg)]",
  },
  failed: { label: "处理失败", className: "text-red-600 bg-red-50" },
} as const;

const selectedStatusText = {
  pending: "待处理 · 尚未生成资料",
  processing: "处理中 · 正在生成资料",
  done: "已处理 · 资料已生成",
  failed: "处理失败 · 可重新处理",
} as const;

type ThemeMode = "dark" | "light";

const THEME_STORAGE_KEY = "course-ai-theme";
const PANEL_WIDTH_STORAGE_KEY = "course-ai-study-panel-width";

function readInitialTheme(): ThemeMode {
  if (typeof window === "undefined") return "light";
  return window.localStorage.getItem(THEME_STORAGE_KEY) === "dark"
    ? "dark"
    : "light";
}

function readPanelWidth() {
  if (typeof window === "undefined") return 480;
  const saved = Number(window.localStorage.getItem(PANEL_WIDTH_STORAGE_KEY));
  return Number.isFinite(saved) ? Math.min(720, Math.max(360, saved)) : 480;
}

export function Home() {
  const [selectedCourseId, setSelectedCourseId] = useState<string | null>(null);
  const [selectedVideoId, setSelectedVideoId] = useState<string | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [theme, setTheme] = useState<ThemeMode>(readInitialTheme);
  const [videoLink, setVideoLink] = useState("");
  const [openMenuVideoId, setOpenMenuVideoId] = useState<string | null>(null);
  const [renamingVideo, setRenamingVideo] = useState<{
    id: string;
    title: string;
  } | null>(null);
  const [queueOpen, setQueueOpen] = useState(false);
  const [queueTick, setQueueTick] = useState(0);
  const [queuedVideoIds, setQueuedVideoIds] = useState<string[]>([]);
  const [studyPanelWidth, setStudyPanelWidth] = useState(readPanelWidth);
  const queryClient = useQueryClient();
  const setVideo = usePlayer((s) => s.setVideo);
  const jobsByVideo = useJobs((s) => s.byVideo);
  const resetJobs = useJobs((s) => s.resetVideo);
  const generatedAfterAsr = useRef<Set<string>>(new Set());
  const isLightTheme = theme === "light";
  const themeToggleLabel = isLightTheme ? "切换到夜晚模式" : "切换到白天模式";

  const toggleTheme = () => {
    setTheme((current) => {
      const next = current === "light" ? "dark" : "light";
      window.localStorage.setItem(THEME_STORAGE_KEY, next);
      return next;
    });
  };

  const { data: videos = [] } = useQuery({
    queryKey: ["videos", selectedCourseId],
    queryFn: () => ipc.videos.list(selectedCourseId!),
    enabled: !!selectedCourseId,
  });
  const { data: courses = [] } = useQuery({
    queryKey: ["courses"],
    queryFn: ipc.courses.list,
  });
  const selectedCourse = courses.find(
    (course) => course.id === selectedCourseId,
  );
  const importLink = useMutation({
    mutationFn: () =>
      ipc.tools.importBilibili(selectedCourseId!, videoLink.trim()),
    onSuccess: () => {
      setVideoLink("");
      queryClient.invalidateQueries({ queryKey: ["videos", selectedCourseId] });
    },
  });

  const selectedVideo = videos.find((video) => video.id === selectedVideoId);
  const queuedVideos = queuedVideoIds
    .map((id) => videos.find((video) => video.id === id))
    .filter((video): video is NonNullable<typeof video> => Boolean(video));

  // asset 协议在 macOS WKWebView 下放大文件会「有画面没声音」；改用本地 HTTP
  // 媒体服务（带 Range）提供视频，拿到 http://127.0.0.1 的 URL 再播。
  const { data: mediaSrc } = useQuery({
    queryKey: ["media-url", selectedVideo?.id],
    queryFn: () => ipc.videos.mediaUrl(selectedVideo!.id),
    enabled: !!selectedVideo,
  });

  useEffect(() => {
    setVideo(selectedVideoId);
  }, [selectedVideoId, setVideo]);

  useEffect(() => {
    queuedVideoIds.forEach((videoId) => {
      const asrJob = jobsByVideo[videoId]?.asr;
      if (asrJob?.status !== "done" || generatedAfterAsr.current.has(videoId)) {
        return;
      }
      generatedAfterAsr.current.add(videoId);
      void Promise.allSettled([
        ipc.ai.generate(videoId, "summary"),
        ipc.ai.generate(videoId, "chapters"),
        ipc.ai.generate(videoId, "notes"),
        ipc.slides.extract(videoId),
      ]).then(() => {
        queryClient.invalidateQueries({ queryKey: ["videos", selectedCourseId] });
        queryClient.invalidateQueries({ queryKey: ["summary", videoId] });
        queryClient.invalidateQueries({ queryKey: ["chapters", videoId] });
        queryClient.invalidateQueries({ queryKey: ["notes", videoId] });
        queryClient.invalidateQueries({ queryKey: ["slides", videoId] });
      });
    });
  }, [jobsByVideo, queryClient, queuedVideoIds, selectedCourseId]);

  useEffect(() => {
    if (!queueOpen || queuedVideoIds.length === 0) return;
    const timer = window.setInterval(() => {
      setQueueTick((tick) => tick + 1);
    }, 2000);
    return () => window.clearInterval(timer);
  }, [queueOpen, queuedVideoIds.length]);

  function startProcessing(videoId: string) {
    generatedAfterAsr.current.delete(videoId);
    resetJobs(videoId);
    setQueuedVideoIds((ids) => (ids.includes(videoId) ? ids : [videoId, ...ids]));
    void ipc.pipeline.process(videoId);
  }

  async function saveRenamedVideo() {
    if (!renamingVideo) return;
    const title = renamingVideo.title.trim();
    if (!title) return;
    const current = videos.find((video) => video.id === renamingVideo.id);
    if (current && current.title === title) {
      setRenamingVideo(null);
      return;
    }
    await ipc.videos.updateTitle(renamingVideo.id, title);
    setRenamingVideo(null);
    await queryClient.invalidateQueries({ queryKey: ["videos", selectedCourseId] });
  }

  async function deleteVideo(videoId: string) {
    if (!window.confirm("确定删除这个视频及其学习资料吗？")) return;
    await ipc.videos.delete(videoId);
    setQueuedVideoIds((ids) => ids.filter((id) => id !== videoId));
    if (selectedVideoId === videoId) setSelectedVideoId(null);
    await queryClient.invalidateQueries({ queryKey: ["videos", selectedCourseId] });
  }

  function beginStudyPanelResize(event: ReactPointerEvent<HTMLDivElement>) {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = studyPanelWidth;
    const onMove = (move: PointerEvent) => {
      const next = Math.min(720, Math.max(360, startWidth - (move.clientX - startX)));
      setStudyPanelWidth(next);
      window.localStorage.setItem(PANEL_WIDTH_STORAGE_KEY, String(next));
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }

  function stageLabel(stage?: string) {
    if (stage === "audio") return "提取音频";
    if (stage === "asr") return "语音识别";
    return "等待中";
  }

  function displayProgress(job: JobUpdate | undefined) {
    if (!job) return 0;
    let progress = job.progress;
    if (
      job.stage === "asr" &&
      job.status === "running" &&
      progress >= 0.12 &&
      progress < 0.9 &&
      job.updatedAt
    ) {
      const elapsedMs = Date.now() - job.updatedAt + queueTick * 0;
      const estimated = progress + elapsedMs / 600_000;
      progress = Math.min(0.88, Math.max(progress, estimated));
    }
    return Math.max(0, Math.min(1, progress));
  }

  function activeJobFor(videoId: string) {
    const byStage = jobsByVideo[videoId] ?? {};
    const ordered = ["audio", "asr"].map((stage) => byStage[stage]).filter(Boolean);
    return (
      ordered.find((job) => job.status === "running") ??
      ordered.find((job) => job.status === "failed") ??
      ordered[ordered.length - 1]
    );
  }

  function renderProcessingQueue() {
    return (
      <div
        aria-label="处理队列面板"
        className="mt-3 flex max-h-64 flex-none flex-col overflow-hidden rounded-md border border-[var(--border-subtle)] bg-[var(--surface-panel)]"
      >
        <div className="flex items-center justify-between border-b border-[var(--border-subtle)] px-3 py-2">
          <span className="text-sm font-medium text-[var(--text-strong)]">
            处理队列
          </span>
          <span className="text-xs text-[var(--text-faint)]">
            {queuedVideos.length}
          </span>
        </div>
        {queuedVideos.length === 0 ? (
          <p className="px-3 py-3 text-xs text-[var(--text-faint)]">
            暂无正在处理的视频。
          </p>
        ) : (
          <div className="min-h-0 space-y-2 overflow-y-auto p-2">
            {queuedVideos.map((video) => {
              const active = activeJobFor(video.id);
              const progress = displayProgress(active);
              const percent = Math.floor(progress * 100);
              const message = active?.message || stageLabel(active?.stage);
              return (
                <div
                  key={video.id}
                  className="rounded border border-[var(--border-faint)] bg-[var(--surface-card)] px-2.5 py-2"
                >
                  <div className="truncate text-xs font-medium text-[var(--text-strong)]">
                    {video.title}
                  </div>
                  <div className="mt-1 flex items-center justify-between gap-2 text-xs">
                    <span
                      className={
                        active?.status === "failed"
                          ? "min-w-0 truncate text-red-500"
                          : "min-w-0 truncate text-[var(--text-muted)]"
                      }
                    >
                      {message}
                    </span>
                    <span className="shrink-0 tabular-nums text-[var(--text-muted)]">
                      {percent}%
                    </span>
                  </div>
                  <div className="mt-2 h-1 overflow-hidden rounded bg-[var(--surface-card-hover)]">
                    <div
                      className={
                        active?.status === "failed"
                          ? "h-full bg-red-500"
                          : "h-full bg-primary"
                      }
                      style={{ width: `${percent}%` }}
                    />
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    );
  }

  return (
    <div
      data-theme={theme}
      className="flex h-full overflow-hidden bg-[var(--surface-app)] text-[var(--text-strong)]"
    >
      <div className="flex min-h-0 flex-1 overflow-hidden">
        {selectedVideo ? (
          <aside className="flex h-full w-14 flex-shrink-0 flex-col items-center border-r border-[var(--border-subtle)] bg-[var(--surface-rail)] py-3">
            <button
              className="flex h-11 w-11 items-center justify-center rounded-md text-[var(--text-normal)] hover:bg-[var(--surface-card-hover)] hover:text-[var(--text-strong)]"
              onClick={() => setSelectedVideoId(null)}
              title="返回课程库"
              aria-label="返回课程库"
            >
              <ChevronLeft className="h-5 w-5" />
            </button>
            <div className="my-3 h-px w-8 bg-[var(--border-subtle)]" />
            <button
              className="flex h-11 w-11 items-center justify-center rounded-md bg-[var(--surface-card-active)] text-primary hover:bg-[var(--surface-card-hover)] hover:text-[var(--text-strong)]"
              onClick={() => setSelectedVideoId(null)}
              title="课程视频"
              aria-label="课程视频"
              aria-current="page"
            >
              <ListVideo className="h-5 w-5" />
            </button>
            <div className="flex-1" />
            <button
              className="flex h-11 w-11 items-center justify-center rounded-md text-[var(--text-normal)] hover:bg-[var(--surface-card-hover)] hover:text-[var(--text-strong)]"
              onClick={toggleTheme}
              title={themeToggleLabel}
              aria-label={themeToggleLabel}
            >
              {isLightTheme ? (
                <Moon className="h-5 w-5" />
              ) : (
                <Sun className="h-5 w-5" />
              )}
            </button>
            <button
              className="flex h-11 w-11 items-center justify-center rounded-md text-[var(--text-normal)] hover:bg-[var(--surface-card-hover)] hover:text-[var(--text-strong)]"
              onClick={() => setShowSettings(true)}
              title="设置"
              aria-label="设置"
            >
              <Settings className="h-5 w-5" />
            </button>
          </aside>
        ) : (
          <CourseSidebar
            selectedCourseId={selectedCourseId}
            onSelect={(id) => {
              setSelectedCourseId(id);
              setSelectedVideoId(null);
            }}
            onOpenSettings={() => setShowSettings(true)}
            onToggleTheme={toggleTheme}
            theme={theme}
            themeToggleLabel={themeToggleLabel}
            queueOpen={queueOpen}
            queueCount={queuedVideoIds.length}
            onToggleQueue={() => setQueueOpen((open) => !open)}
            queuePanel={renderProcessingQueue()}
          />
        )}
        <main className="flex min-w-0 flex-1">
          <div className="flex min-w-0 flex-1 flex-col bg-[var(--surface-app)]">
            {selectedVideo ? (
              <>
                <div className="flex min-h-24 items-center gap-3 border-b border-[var(--border-subtle)] bg-[var(--surface-header)] px-5 py-4">
                  <div className="min-w-0 flex-1">
                    <p className="mb-1 flex items-center gap-2 text-xs font-medium text-[var(--text-faint)]">
                      <Sparkles className="h-3.5 w-3.5 text-primary" />
                      学习工作台
                    </p>
                    <h1 className="truncate text-xl font-semibold text-[var(--text-strong)]">
                      {selectedVideo.title}
                    </h1>
                    <p className="mt-2 flex w-fit items-center gap-2 rounded-full bg-[var(--surface-card)] px-2.5 py-1 text-xs text-[var(--text-muted)]">
                      {selectedVideo.processed_status === "done" ? (
                        <CheckCircle2 className="h-3.5 w-3.5 text-emerald-400" />
                      ) : (
                        <Clock3 className="h-3.5 w-3.5 text-primary" />
                      )}
                      {selectedStatusText[selectedVideo.processed_status]}
                    </p>
                  </div>
                </div>
                <div className="min-h-0 flex-1">
                  {mediaSrc ? (
                    <VideoPlayer src={mediaSrc} videoId={selectedVideo.id} />
                  ) : (
                    <div className="flex h-full items-center justify-center bg-black text-sm text-white/40">
                      正在准备播放…
                    </div>
                  )}
                </div>
              </>
            ) : (
              <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
                <header className="flex flex-none flex-wrap items-center justify-between gap-4 border-b border-[var(--border-subtle)] bg-[var(--surface-header)] px-7 py-5">
                  <div className="min-w-0">
                    <h1 className="text-2xl font-semibold text-[var(--text-strong)]">
                      课程视频
                    </h1>
                    <p className="mt-1 text-sm text-[var(--text-muted)]">
                      {selectedCourse
                        ? `${selectedCourse.name} · ${videos.length} 个视频`
                        : "选择课程后导入或管理视频"}
                    </p>
                  </div>
                  {selectedCourseId && (
                    <div className="flex min-w-[320px] flex-1 flex-wrap items-center justify-end gap-2">
                      <ImportVideoButton
                        courseId={selectedCourseId}
                        showLinkImport={false}
                      />
                      <div className="flex min-w-[220px] max-w-[360px] flex-1 gap-1">
                        <input
                          aria-label="视频链接"
                          className="min-w-0 flex-1 rounded-md border border-[var(--border-subtle)] bg-[var(--surface-input)] px-3 py-1.5 text-xs text-[var(--text-strong)] outline-none placeholder:text-[var(--text-faint)] focus:border-primary/70"
                          placeholder="B 站 / 视频链接…"
                          value={videoLink}
                          onChange={(event) =>
                            setVideoLink(event.target.value)
                          }
                        />
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={!videoLink.trim() || importLink.isPending}
                          onClick={() => importLink.mutate()}
                          title="需安装 yt-dlp；仅供个人学习使用"
                        >
                          <Download className="h-3.5 w-3.5" />
                          {importLink.isPending ? "下载中" : "下载"}
                        </Button>
                      </div>
                      {importLink.isError && (
                        <p className="basis-full text-right text-xs text-red-400">
                          {String(importLink.error)}
                        </p>
                      )}
                    </div>
                  )}
                </header>
                {selectedCourseId && (
                  <>
                    <div className="flex flex-none items-center justify-between gap-3 border-b border-[var(--border-faint)] bg-[var(--surface-app)] px-7 py-3">
                      <span className="text-sm font-medium text-[var(--text-normal)]">
                        最近添加
                      </span>
                      <span className="text-xs text-[var(--text-faint)]">
                        {videos.length} 个视频
                      </span>
                    </div>
                  </>
                )}
                <div className="min-h-0 flex-1 overflow-y-auto px-7 py-6">
                  {!selectedCourseId || videos.length === 0 ? (
                    <div className="flex h-full min-h-[320px] items-center justify-center">
                      <div className="max-w-sm text-center">
                        <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-md border border-[var(--border-faint)] bg-[var(--surface-card)] text-primary">
                          <Film className="h-7 w-7" />
                        </div>
                        <h2 className="text-base font-semibold text-[var(--text-strong)]">
                          {selectedCourseId ? "还没有视频" : "选择课程开始"}
                        </h2>
                        <p className="mt-2 text-sm leading-relaxed text-[var(--text-muted)]">
                          {selectedCourseId
                            ? "导入本地视频或粘贴视频链接后，会在这里形成课程视频列表。"
                            : "从左侧选择课程后导入或管理视频。"}
                        </p>
                      </div>
                    </div>
                  ) : (
                    <div className="grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-4">
                      {videos.map((video) => (
                        <article
                          key={video.id}
                          className="group relative min-w-0 overflow-hidden rounded-md border border-[var(--border-faint)] bg-[var(--surface-card)] text-left shadow-sm transition hover:-translate-y-0.5 hover:border-[var(--border-subtle)] hover:bg-[var(--surface-card-hover)] hover:shadow-[var(--shadow-pop)]"
                        >
                          <button
                            className="block w-full text-left"
                            aria-label={`打开视频：${video.title}`}
                            onClick={() => setSelectedVideoId(video.id)}
                          >
                          <span className="relative flex aspect-video items-center justify-center overflow-hidden bg-[var(--surface-stage)] text-white">
                            <VideoCover
                              videoId={video.id}
                              className="absolute inset-0 h-full w-full"
                            />
                            <span className="relative flex h-11 w-11 items-center justify-center rounded-full bg-black/35 text-white shadow-lg backdrop-blur-sm transition group-hover:bg-primary">
                              <Play className="h-5 w-5 fill-current" />
                            </span>
                          </span>
                          <span className="block space-y-3 p-3.5">
                            <span className="block truncate text-sm font-semibold text-[var(--text-strong)]">
                              {video.title}
                            </span>
                            <span className="flex items-center justify-between gap-2">
                              <span className="text-xs text-[var(--text-muted)]">
                                {video.duration_ms
                                  ? formatMs(video.duration_ms)
                                  : "00:00"}
                              </span>
                              <span
                                data-testid="video-status-badge"
                                className={`rounded-full px-2 py-0.5 text-xs font-medium ${
                                  statusMeta[video.processed_status].className
                                }`}
                              >
                                {statusMeta[video.processed_status].label}
                              </span>
                            </span>
                          </span>
                          </button>
                          <button
                            type="button"
                            aria-label="视频操作"
                            className="absolute right-3 top-3 flex h-8 w-8 items-center justify-center rounded-full bg-[var(--surface-panel)] text-[var(--text-muted)] shadow hover:text-[var(--text-strong)]"
                            onClick={() =>
                              setOpenMenuVideoId((id) => (id === video.id ? null : video.id))
                            }
                          >
                            <MoreHorizontal className="h-4 w-4" />
                          </button>
                          {openMenuVideoId === video.id && (
                            <div
                              role="menu"
                              className="absolute right-3 top-12 z-10 w-32 overflow-hidden rounded-md border border-[var(--border-subtle)] bg-[var(--surface-panel)] py-1 text-sm shadow-[var(--shadow-pop)]"
                            >
                              <button
                                type="button"
                                role="menuitem"
                                className="block w-full px-3 py-2 text-left hover:bg-[var(--surface-card-hover)]"
                                onClick={() => {
                                  setOpenMenuVideoId(null);
                                  setRenamingVideo({
                                    id: video.id,
                                    title: video.title,
                                  });
                                }}
                              >
                                修改标题
                              </button>
                              <button
                                type="button"
                                role="menuitem"
                                className="block w-full px-3 py-2 text-left text-red-500 hover:bg-[var(--surface-card-hover)]"
                                onClick={() => {
                                  setOpenMenuVideoId(null);
                                  void deleteVideo(video.id);
                                }}
                              >
                                删除
                              </button>
                              <button
                                type="button"
                                role="menuitem"
                                className="block w-full px-3 py-2 text-left hover:bg-[var(--surface-card-hover)]"
                                onClick={() => {
                                  setOpenMenuVideoId(null);
                                  startProcessing(video.id);
                                }}
                              >
                                {video.processed_status === "done" ? "重新处理" : "开始处理"}
                              </button>
                            </div>
                          )}
                          {renamingVideo?.id === video.id && (
                            <div
                              role="dialog"
                              aria-label="修改标题"
                              className="absolute inset-x-3 top-12 z-20 rounded-md border border-[var(--border-subtle)] bg-[var(--surface-panel)] p-2 shadow-[var(--shadow-pop)]"
                            >
                              <label className="sr-only" htmlFor={`rename-${video.id}`}>
                                视频标题
                              </label>
                              <input
                                id={`rename-${video.id}`}
                                aria-label="视频标题"
                                className="w-full rounded border border-[var(--border-subtle)] bg-[var(--surface-input)] px-2 py-1.5 text-xs text-[var(--text-strong)] outline-none focus:border-primary/70"
                                value={renamingVideo.title}
                                onChange={(event) =>
                                  setRenamingVideo({
                                    id: video.id,
                                    title: event.target.value,
                                  })
                                }
                                onKeyDown={(event) => {
                                  if (event.key === "Enter") void saveRenamedVideo();
                                  if (event.key === "Escape") setRenamingVideo(null);
                                }}
                              />
                              <div className="mt-2 flex justify-end gap-1">
                                <button
                                  type="button"
                                  aria-label="取消修改标题"
                                  className="flex h-7 w-7 items-center justify-center rounded text-[var(--text-muted)] hover:bg-[var(--surface-card-hover)]"
                                  onClick={() => setRenamingVideo(null)}
                                >
                                  <X className="h-3.5 w-3.5" />
                                </button>
                                <button
                                  type="button"
                                  aria-label="保存标题"
                                  className="flex h-7 w-7 items-center justify-center rounded bg-primary text-primary-foreground disabled:opacity-50"
                                  disabled={!renamingVideo.title.trim()}
                                  onClick={() => void saveRenamedVideo()}
                                >
                                  <Check className="h-3.5 w-3.5" />
                                </button>
                              </div>
                            </div>
                          )}
                        </article>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
          {selectedVideo && (
            <>
              <div
                role="separator"
                aria-label="调整学习资料宽度"
                aria-orientation="vertical"
                className="w-1 cursor-col-resize bg-transparent hover:bg-primary/40"
                onPointerDown={beginStudyPanelResize}
              />
              <aside
                aria-label="学习资料面板"
                className="flex min-w-[380px] max-w-[720px] flex-none flex-col border-l border-[var(--border-subtle)] bg-[var(--surface-app)]"
                style={{ width: studyPanelWidth }}
              >
                <TabsPanel videoId={selectedVideo.id} />
              </aside>
            </>
          )}
        </main>
      </div>
      {showSettings && <SettingsPanel onClose={() => setShowSettings(false)} />}
    </div>
  );
}
