import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Book,
  Check,
  ChevronLeft,
  Film,
  LayoutGrid,
  List,
  Menu,
  Moon,
  MoreHorizontal,
  Play,
  Settings,
  Sun,
  X,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from "react";
import { onBackButtonPress } from "@tauri-apps/api/app";
import { confirm as confirmDialog } from "@tauri-apps/plugin-dialog";
import { CourseSidebar } from "@/components/CourseSidebar";
import { RecycleBin } from "@/components/RecycleBin";
import { DevConsole } from "@/components/DevConsole";
import { ImportVideoButton } from "@/components/ImportVideoDialog";
import { SettingsPanel } from "@/components/SettingsDialog";
import { TabsPanel } from "@/components/TabsPanel";
import { VideoCover } from "@/components/VideoCover";
import { VideoPlayer } from "@/components/VideoPlayer";
import { useDeviceLayout } from "@/lib/deviceLayout";
import { ipc } from "@/lib/ipc";
import type { Video } from "@/lib/types";
import { formatMs } from "@/lib/time";
import { readPlaybackProgress } from "@/lib/playback";
import { usePlayer } from "@/stores/player";
import { useJobs, type JobUpdate } from "@/stores/jobs";
import { accentVars, useTheme } from "@/stores/theme";
import { getCurrentWindow } from "@tauri-apps/api/window";

const statusMeta = {
  pending: { label: "待处理" },
  processing: { label: "处理中" },
  done: { label: "已处理" },
  failed: { label: "处理失败" },
} as const;

const PANEL_WIDTH_STORAGE_KEY = "course-ai-study-panel-width";
const VIEW_STORAGE_KEY = "course-ai-home-view";

type LibraryView = "grid" | "list";

function readInitialView(): LibraryView {
  if (typeof window === "undefined") return "grid";
  return window.localStorage.getItem(VIEW_STORAGE_KEY) === "list"
    ? "list"
    : "grid";
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
  const [showRecycleBin, setShowRecycleBin] = useState(false);
  const [showDevConsole, setShowDevConsole] = useState(false);
  const theme = useTheme((s) => s.effective);
  const accent = useTheme((s) => s.accent);
  const toggleTheme = useTheme((s) => s.toggle);
  const [view, setView] = useState<LibraryView>(readInitialView);
  const [libraryDrawerOpen, setLibraryDrawerOpen] = useState(false);
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
  const deviceLayout = useDeviceLayout();
  const isLightTheme = theme === "light";
  const themeToggleLabel = isLightTheme ? "切换到夜晚模式" : "切换到白天模式";
  const isPhoneDevice = deviceLayout === "phone";
  const isWorkbenchWide =
    deviceLayout === "desktop" ||
    deviceLayout === "laptop" ||
    deviceLayout === "tablet-landscape";
  const studyPanelWidthForLayout =
    deviceLayout === "tablet-landscape"
      ? Math.min(studyPanelWidth, 420)
      : studyPanelWidth;
  const isAndroidDevice =
    deviceLayout === "phone" ||
    deviceLayout === "tablet-portrait" ||
    deviceLayout === "tablet-landscape";
  const androidBackGuard = useRef(0);

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

  function changeView(next: LibraryView) {
    setView(next);
    window.localStorage.setItem(VIEW_STORAGE_KEY, next);
  }

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

  // 启动时按已保存的偏好同步主题与强调色（auto 解析系统明暗）。
  useEffect(() => {
    useTheme.getState().sync();
  }, []);

  useEffect(() => {
    setVideo(selectedVideoId);
  }, [selectedVideoId, setVideo]);

  const goBackOneLevel = useCallback(() => {
    const now = Date.now();
    if (now - androidBackGuard.current < 250) return;
    androidBackGuard.current = now;

    if (libraryDrawerOpen) {
      closeLibraryDrawer();
      return;
    }
    if (showSettings || showRecycleBin || showDevConsole) {
      setShowSettings(false);
      setShowRecycleBin(false);
      setShowDevConsole(false);
      return;
    }
    if (queueOpen) {
      setSelectedVideoId(null);
      setQueueOpen(false);
      return;
    }
    if (selectedVideoId) {
      returnToLibrary();
      return;
    }
    openLibraryDrawer();
  }, [
    libraryDrawerOpen,
    queueOpen,
    selectedVideoId,
    showDevConsole,
    showRecycleBin,
    showSettings,
  ]);

  useEffect(() => {
    if (!isAndroidDevice) return;

    let cancelled = false;
    let closeListener: (() => void) | null = null;
    let backListener: { unregister: () => Promise<void> } | null = null;

    void (async () => {
      closeListener = await getCurrentWindow().onCloseRequested((event) => {
        event.preventDefault();
        goBackOneLevel();
      });
      backListener = await onBackButtonPress(() => {
        goBackOneLevel();
      });
      if (cancelled) {
        closeListener?.();
        void backListener.unregister();
      }
    })();

    return () => {
      cancelled = true;
      closeListener?.();
      void backListener?.unregister();
    };
  }, [goBackOneLevel, isAndroidDevice]);

  // ASR 完成后：章节、摘要、笔记、出题、脑图全部由后端流水线作为可见任务自动续跑
  // （见 pipeline::run_ai_followups），用户无需手动点「生成」。这里只补做不在后端任务
  // 队列里的「课件抽取」，并在各 AI 任务完成时刷新对应面板。
  useEffect(() => {
    queuedVideoIds.forEach((videoId) => {
      const jobs = jobsByVideo[videoId];
      if (!jobs) return;
      if (jobs.asr?.status === "done" && !generatedAfterAsr.current.has(videoId)) {
        generatedAfterAsr.current.add(videoId);
        void ipc.slides.extract(videoId).finally(() => {
          queryClient.invalidateQueries({ queryKey: ["slides", videoId] });
        });
      }
      // 后端各 AI 任务完成 → 刷新对应面板（各刷一次）。
      for (const stage of ["chapters", "summary", "notes", "quiz", "mindmap"] as const) {
        const key = `${videoId}:${stage}`;
        if (jobs[stage]?.status === "done" && !generatedAfterAsr.current.has(key)) {
          generatedAfterAsr.current.add(key);
          queryClient.invalidateQueries({ queryKey: [stage, videoId] });
          queryClient.invalidateQueries({ queryKey: ["videos", selectedCourseId] });
        }
      }
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

  // 已有字幕时「仅重新纠错」：不重新识别，回到原始稿后重跑 AI 纠错，完成后刷新文稿。
  const recorrect = useMutation({
    mutationFn: (videoId: string) => ipc.pipeline.recorrect(videoId),
    onSuccess: (_d, videoId) =>
      queryClient.invalidateQueries({ queryKey: ["transcripts", videoId] }),
  });

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
    const ok = await confirmDialog(
      "删除这个视频？\n它会移入回收站，可在 30 天内恢复。",
      { title: "删除视频", kind: "warning", okLabel: "删除", cancelLabel: "取消" },
    );
    if (!ok) return;
    await ipc.videos.delete(videoId);
    setQueuedVideoIds((ids) => ids.filter((id) => id !== videoId));
    if (selectedVideoId === videoId) setSelectedVideoId(null);
    await queryClient.invalidateQueries({ queryKey: ["videos", selectedCourseId] });
    await queryClient.invalidateQueries({ queryKey: ["trash"] });
  }

  // 设置 / 回收站作为主区域整页，与处理队列一致；互斥切换。保留当前选中的视频，
  // 这样从控制台打开设置、点「返回」能回到原来的视频工作台，而不是退回首页。
  function openMainView(view: "settings" | "recycle" | "dev") {
    setQueueOpen(false);
    setShowSettings(view === "settings");
    setShowRecycleBin(view === "recycle");
    setShowDevConsole(view === "dev");
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

  function openQueuedVideo(videoId: string) {
    setQueueOpen(false);
    setSelectedVideoId(videoId);
  }

  function openLibraryDrawer() {
    setLibraryDrawerOpen(true);
  }

  function closeLibraryDrawer() {
    setLibraryDrawerOpen(false);
  }

  function selectCourse(id: string) {
    setSelectedCourseId(id);
    setSelectedVideoId(null);
    setQueueOpen(false);
    setShowSettings(false);
    setShowRecycleBin(false);
    setShowDevConsole(false);
    closeLibraryDrawer();
  }

  function toggleQueue() {
    setSelectedVideoId(null);
    setShowSettings(false);
    setShowRecycleBin(false);
    setShowDevConsole(false);
    setQueueOpen((open) => !open);
    closeLibraryDrawer();
  }

  function returnToLibrary() {
    setSelectedVideoId(null);
    setQueueOpen(false);
    setShowSettings(false);
    setShowRecycleBin(false);
    setShowDevConsole(false);
  }

  function renderProcessingQueuePage() {
    return (
      <div
        aria-label="处理队列页面"
        className="flex min-h-0 flex-1 flex-col overflow-hidden"
      >
        <header className="flex flex-none items-start justify-between gap-4 border-b border-[var(--border-subtle)] bg-[var(--surface-header)] px-7 py-5">
          <div className="flex min-w-0 items-start gap-3">
            <button
              type="button"
              className="ca-icon-btn mt-0.5"
              onClick={goBackOneLevel}
              aria-label="返回上一菜单"
              title="返回上一菜单"
            >
              <ChevronLeft className="h-4 w-4" />
            </button>
            <div className="min-w-0">
              <h1 className="text-2xl font-semibold text-[var(--text-strong)]">
                处理队列
              </h1>
              <p className="mt-1 text-sm text-[var(--text-muted)]">
                抽音频 → 语音识别 → 生成章节 → 生成笔记
              </p>
            </div>
          </div>
          <span className="rounded-full bg-[var(--surface-card)] px-2.5 py-1 text-xs text-[var(--text-muted)]">
            {queuedVideos.length} 个任务
          </span>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto px-7 py-6">
          {queuedVideos.length === 0 ? (
            <div className="flex h-full min-h-[240px] items-center justify-center text-sm text-[var(--text-faint)]">
              暂无正在处理的视频。导入或处理视频后会出现在这里。
            </div>
          ) : (
            <div className="mx-auto flex max-w-3xl flex-col gap-3">
              {queuedVideos.map((video) => {
                const active = activeJobFor(video.id);
                const progress = displayProgress(active);
                const percent = Math.floor(progress * 100);
                const message = active?.message || stageLabel(active?.stage);
                const canCancel =
                  active?.status === "running" || active?.status === "pending";
                return (
                  <div
                    key={video.id}
                    className="relative overflow-hidden rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-card)] shadow-[var(--shadow-card)]"
                  >
                    <button
                      onClick={() => openQueuedVideo(video.id)}
                      className={`block w-full px-4 py-3 text-left transition hover:bg-[var(--surface-card-hover)] ${
                        canCancel ? "pr-20" : ""
                      }`}
                    >
                      <div className="flex items-center justify-between gap-3">
                        <div className="min-w-0 truncate text-sm font-medium text-[var(--text-strong)]">
                          {video.title}
                        </div>
                        <span className="shrink-0 tabular-nums text-xs text-[var(--text-muted)]">
                          {percent}%
                        </span>
                      </div>
                      <div className="mt-2 h-1.5 overflow-hidden rounded bg-[var(--surface-card-hover)]">
                        <div
                          className={
                            active?.status === "failed"
                              ? "h-full bg-red-500"
                              : "h-full bg-primary"
                          }
                          style={{ width: `${percent}%` }}
                        />
                      </div>
                      <div
                        className={
                          active?.status === "failed"
                            ? "mt-1.5 truncate text-xs text-red-500"
                            : "mt-1.5 truncate text-xs text-[var(--text-muted)]"
                        }
                      >
                        {message}
                      </div>
                    </button>
                    {canCancel && (
                      <button
                        onClick={() => void ipc.pipeline.cancel(video.id)}
                        className="absolute right-3 top-3 rounded-md border border-[var(--border-subtle)] bg-[var(--surface-panel)] px-2 py-1 text-xs text-[var(--text-muted)] transition hover:text-red-500"
                      >
                        取消
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    );
  }

  // 视频卡片上的「⋯」操作按钮（网格/列表共用）。
  function videoOptionsButton(video: Video) {
    return (
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
    );
  }

  function videoMenu(video: Video) {
    if (openMenuVideoId !== video.id) return null;
    return (
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
            setRenamingVideo({ id: video.id, title: video.title });
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
            // 已有字幕（处理完成）→ 仅重新 AI 纠错；否则跑完整处理。
            if (video.processed_status === "done") {
              recorrect.mutate(video.id);
            } else {
              startProcessing(video.id);
            }
          }}
        >
          {video.processed_status === "done"
            ? recorrect.isPending && recorrect.variables === video.id
              ? "纠错中…"
              : "重新纠错"
            : "开始处理"}
        </button>
      </div>
    );
  }

  function videoRenameBox(video: Video) {
    if (renamingVideo?.id !== video.id) return null;
    return (
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
            setRenamingVideo({ id: video.id, title: event.target.value })
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
            className="flex h-7 w-7 items-center justify-center rounded border border-[var(--border-subtle)] bg-[var(--surface-card)] text-[var(--text-strong)] hover:bg-[var(--surface-card-hover)] disabled:opacity-50"
            disabled={!renamingVideo.title.trim()}
            onClick={() => void saveRenamedVideo()}
          >
            <Check className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>
    );
  }

  function statusBadge(video: Video) {
    const status = video.processed_status;
    return (
      <span
        data-testid="video-status-badge"
        className={`ca-chip ${status}`}
      >
        <span className="dot" />
        {statusMeta[status].label}
      </span>
    );
  }

  function renderVideoGridCard(video: Video) {
    const progress = readPlaybackProgress(video.id);
    const durationMs =
      video.duration_ms ??
      (progress.durationSec ? Math.round(progress.durationSec * 1000) : null);
    return (
      <article
        key={video.id}
        className="ca-card group relative"
      >
        <button
          className="block w-full text-left"
          aria-label={`打开视频：${video.title}`}
          onClick={() => setSelectedVideoId(video.id)}
        >
          <span className="ca-thumb">
            <VideoCover
              videoId={video.id}
              className="absolute inset-0 h-full w-full"
            />
            <span className="play">
              <Play className="h-5 w-5 fill-current" />
            </span>
            <span className="dur">
              {durationMs ? formatMs(durationMs) : "00:00"}
            </span>
            {progress.ratio > 0 && progress.ratio < 0.995 && (
              <span
                className="ov-bar"
                aria-label={`已观看 ${Math.round(progress.ratio * 100)}%`}
              >
                <i style={{ width: `${progress.ratio * 100}%` }} />
              </span>
            )}
          </span>
          <span className="ca-card-body">
            <span className="ca-card-title">
              {video.title}
            </span>
            <span className="ca-card-foot">
              {statusBadge(video)}
            </span>
          </span>
        </button>
        {videoOptionsButton(video)}
        {videoMenu(video)}
        {videoRenameBox(video)}
      </article>
    );
  }

  function renderVideoListRow(video: Video) {
    const progress = readPlaybackProgress(video.id);
    const durationMs =
      video.duration_ms ??
      (progress.durationSec ? Math.round(progress.durationSec * 1000) : null);
    const durationText = durationMs ? formatMs(durationMs) : "00:00";
    return (
      <article
        key={video.id}
        className="ca-row group relative"
      >
        <button
          className="row-button"
          aria-label={`打开视频：${video.title}`}
          onClick={() => setSelectedVideoId(video.id)}
        >
          <span className="row-main">
            <span className="row-thumb">
              <VideoCover
                videoId={video.id}
                className="absolute inset-0 h-full w-full"
              />
              <span className="play">
                <Play className="h-4 w-4 fill-current" />
              </span>
              {progress.ratio > 0 && progress.ratio < 0.995 && (
                <span
                  className="ov-bar"
                  aria-label={`已观看 ${Math.round(progress.ratio * 100)}%`}
                >
                  <i style={{ width: `${progress.ratio * 100}%` }} />
                </span>
              )}
            </span>
            <span className="row-name">
              <span className="t">{video.title}</span>
              <span className="s">{durationText}</span>
            </span>
          </span>
          <span className="c-dur">{durationText}</span>
          <span className="c-status">{statusBadge(video)}</span>
        </button>
        {videoOptionsButton(video)}
        {videoMenu(video)}
        {videoRenameBox(video)}
      </article>
    );
  }

  function renderCourseVideoLibrary() {
    return (
      <div className="ca-main-col">
        <header className="ca-topbar">
          <div className="tb-lead">
            {isPhoneDevice && (
              <button
                type="button"
                className="hamb"
                onClick={openLibraryDrawer}
                title="打开课程库"
                aria-label="打开课程库"
              >
                <Menu className="h-5 w-5" />
              </button>
            )}
            <div className="tb-titles">
              <h1>课程视频</h1>
              <div className="sub">
                {selectedCourse
                  ? `${selectedCourse.name} · ${videos.length} 个视频`
                  : "选择课程后导入或管理视频"}
              </div>
            </div>
          </div>
          {selectedCourseId && (
            <div className="tb-actions">
              {videos.length > 0 && (
                <div className="ca-seg">
                  {(
                    [
                      ["grid", LayoutGrid, "网格视图"],
                      ["list", List, "列表视图"],
                    ] as const
                  ).map(([key, Icon, label]) => (
                    <button
                      key={key}
                      aria-label={label}
                      aria-pressed={view === key}
                      onClick={() => changeView(key)}
                      className={view === key ? "on" : ""}
                    >
                      <Icon className="h-4 w-4" />
                    </button>
                  ))}
                </div>
              )}
              <ImportVideoButton courseId={selectedCourseId} />
            </div>
          )}
        </header>
        <div className="ca-scroll">
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
          ) : view === "list" ? (
            <div className="ca-list">
              <div className="ca-list-head">
                <span>名称</span>
                <span className="h-dur">时长</span>
                <span className="h-status">状态</span>
              </div>
              {videos.map((video) => renderVideoListRow(video))}
            </div>
          ) : (
            <div className="ca-grid">
              {videos.map((video) => renderVideoGridCard(video))}
            </div>
          )}
        </div>
      </div>
    );
  }

  function renderSelectedVideoWorkspace() {
    if (!selectedVideo) return null;

    return (
      <div
        aria-label="学习工作台响应布局"
        data-layout={isWorkbenchWide ? "wide" : "stacked"}
        className="ca-wb"
        style={
          isWorkbenchWide
            ? ({ "--study-panel-width": `${studyPanelWidthForLayout}px` } as CSSProperties)
            : undefined
        }
      >
        <section aria-label="学习工作台" className="ca-player-col">
          <header className="ca-wb-head">
            <div className="wb-title-row">
              {isPhoneDevice && (
                <>
                  <button
                    type="button"
                    className="hamb"
                    onClick={returnToLibrary}
                    title="返回课程库"
                    aria-label="返回课程库"
                  >
                    <ChevronLeft className="h-5 w-5" />
                  </button>
                  <button
                    type="button"
                    className="hamb"
                    onClick={openLibraryDrawer}
                    title="打开课程库"
                    aria-label="打开课程库"
                  >
                    <Menu className="h-5 w-5" />
                  </button>
                </>
              )}
              <div className="min-w-0">
                <h1 className="wb-title">{selectedVideo.title}</h1>
              </div>
            </div>
          </header>
          <div className="ca-stage-wrap">
            <div className="ca-stage">
              {mediaSrc ? (
                <VideoPlayer src={mediaSrc} videoId={selectedVideo.id} />
              ) : (
                <div className="flex h-full items-center justify-center bg-black text-sm text-white/40">
                  正在准备播放…
                </div>
              )}
            </div>
          </div>
        </section>
        {isWorkbenchWide && (
          <div
            role="separator"
            aria-label="调整学习资料宽度"
            aria-orientation="vertical"
            className="ca-resizer"
            onPointerDown={beginStudyPanelResize}
          />
        )}
        <aside
          aria-label="学习资料面板"
          className="ca-panel-col"
        >
          <TabsPanel videoId={selectedVideo.id} />
        </aside>
      </div>
    );
  }

  function renderRail() {
    return (
      <nav className="ca-rail" aria-label="工具栏">
        <span className="rail-logo">
          <Book className="h-[18px] w-[18px]" />
        </span>
        <button
          className="rail-btn"
          title="返回课程库"
          aria-label="返回课程库"
          onClick={returnToLibrary}
        >
          <ChevronLeft className="h-5 w-5" />
        </button>
        <button className="rail-btn active" title="课程视频">
          <List className="h-5 w-5" />
        </button>
        <div className="rail-sp" />
        <button
          className="rail-btn"
          title={themeToggleLabel}
          aria-label={themeToggleLabel}
          onClick={toggleTheme}
        >
          {isLightTheme ? <Moon className="h-[19px] w-[19px]" /> : <Sun className="h-[19px] w-[19px]" />}
        </button>
        <button
          className="rail-btn"
          title="设置"
          aria-label="设置"
          onClick={() => openMainView("settings")}
        >
          <Settings className="h-[19px] w-[19px]" />
        </button>
      </nav>
    );
  }

  function renderSidebar(drawer = false) {
    return (
      <CourseSidebar
        className={drawer ? "h-full border-0" : undefined}
        selectedCourseId={selectedCourseId}
        onSelect={selectCourse}
        onOpenSettings={() => {
          openMainView("settings");
          closeLibraryDrawer();
        }}
        onToggleTheme={toggleTheme}
        theme={theme}
        themeToggleLabel={themeToggleLabel}
        queueOpen={queueOpen}
        queueCount={queuedVideoIds.length}
        onToggleQueue={toggleQueue}
        onOpenRecycleBin={() => {
          openMainView("recycle");
          closeLibraryDrawer();
        }}
        onCloseDrawer={drawer ? closeLibraryDrawer : undefined}
      />
    );
  }

  const isWorkbenchView = !!selectedVideo && !showSettings && !showRecycleBin && !showDevConsole && !queueOpen;

  return (
    <div
      data-theme={theme}
      data-device={deviceLayout}
      data-view={isWorkbenchView ? "workbench" : "library"}
      style={accentVars(accent, theme) as CSSProperties}
      className={`ca-app ${libraryDrawerOpen ? "drawer-open" : ""}`}
    >
      {isPhoneDevice && (
        <>
          <div
            className="ca-scrim"
            onClick={closeLibraryDrawer}
          />
          <aside
            aria-label="课程库抽屉"
            className={`ca-drawer ${libraryDrawerOpen ? "translate-x-0" : ""}`}
          >
            {renderSidebar(true)}
          </aside>
        </>
      )}
      {isPhoneDevice ? null : isWorkbenchView ? renderRail() : renderSidebar()}
      <main className="ca-main">
        {showSettings ? (
          <SettingsPanel
            onClose={() => setShowSettings(false)}
            onOpenDevConsole={() => openMainView("dev")}
          />
        ) : showRecycleBin ? (
          <RecycleBin onClose={() => setShowRecycleBin(false)} />
        ) : showDevConsole ? (
          <DevConsole onClose={() => setShowDevConsole(false)} />
        ) : queueOpen ? (
          renderProcessingQueuePage()
        ) : selectedVideo ? (
          renderSelectedVideoWorkspace()
        ) : (
          renderCourseVideoLibrary()
        )}
      </main>
    </div>
  );
}
