import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Book,
  Check,
  ChevronLeft,
  Film,
  LayoutGrid,
  List,
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
import { BottomTabBar, type CompactTab } from "@/components/BottomTabBar";
import { coarsePointer, useContainerWidth, useIsPortrait } from "@/lib/useContainerWidth";
import { ipc } from "@/lib/ipc";
import type { Video } from "@/lib/types";
import { formatMs } from "@/lib/time";
import { displayTitle } from "@/lib/videoTitle";
import { readPlaybackProgress } from "@/lib/playback";
import { readVideoResumeState, writeVideoResumeState } from "@/lib/resumeState";
import { isTablet } from "@/lib/platform";
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
  const customAccent = useTheme((s) => s.customAccent);
  const toggleTheme = useTheme((s) => s.toggle);
  const [view, setView] = useState<LibraryView>(readInitialView);
  const [openMenuVideoId, setOpenMenuVideoId] = useState<string | null>(null);
  const [renamingVideo, setRenamingVideo] = useState<{
    id: string;
    title: string;
  } | null>(null);
  const [queueOpen, setQueueOpen] = useState(false);
  const [queueTick, setQueueTick] = useState(0);
  const [queuedVideoIds, setQueuedVideoIds] = useState<string[]>([]);
  const [compactTab, setCompactTab] = useState<CompactTab>("courses");
  const [studyPanelWidth, setStudyPanelWidth] = useState(readPanelWidth);
  const [isResizingPanel, setIsResizingPanel] = useState(false);
  // 拖动期间的实时宽度（用 ref，不触发重渲染；松手才提交到 state）。
  const liveWidthRef = useRef(studyPanelWidth);
  // 工作台左侧栏「课程视频」菜单：点开后在侧栏旁弹出同课程的全部视频。
  const [railVideosOpen, setRailVideosOpen] = useState(false);
  const queryClient = useQueryClient();
  const setVideo = usePlayer((s) => s.setVideo);
  const jobsByVideo = useJobs((s) => s.byVideo);
  const resetJobs = useJobs((s) => s.resetVideo);
  const generatedAfterAsr = useRef<Set<string>>(new Set());
  const appRef = useRef<HTMLDivElement>(null);
  const bucket = useContainerWidth(appRef);
  const isLightTheme = theme === "light";
  const themeToggleLabel = isLightTheme ? "切换到夜晚模式" : "切换到白天模式";
  const tabletDevice = isTablet();
  const portrait = useIsPortrait();
  // 触控优先：iOS/iPad 竖屏一律走底部 Tab / 上下叠放布局；只有横屏才保留桌面式左右分栏。
  // 方向必须单独判断:12.9" iPad 竖屏宽 1024 会落入 wide 档,只看 bucket 仍会被当宽屏左右布局。
  const stackedPortrait = portrait && (tabletDevice || coarsePointer());
  const isWorkbenchWide = bucket === "wide" && !stackedPortrait;
  const tabletWide = tabletDevice && isWorkbenchWide;
  const isPhoneDevice = !isWorkbenchWide;
  // 只有横屏宽布局才保留可拖的竖向分隔条。
  const showResizer = isWorkbenchWide;
  const studyPanelWidthForLayout = isResizingPanel
    ? liveWidthRef.current
    : studyPanelWidth;
  // 硬件返回键是「平台能力」（仅 Android 有），与布局宽度无关：用 UA 判平台，
  // 避免在桌面拦截窗口关闭。
  const isAndroidPlatform =
    typeof navigator !== "undefined" && /android/i.test(navigator.userAgent);
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

  function openVideo(videoId: string) {
    const savedWidth = readVideoResumeState(videoId).studyPanelWidth;
    setStudyPanelWidth(
      savedWidth != null ? Math.min(720, Math.max(360, savedWidth)) : readPanelWidth(),
    );
    setSelectedVideoId(videoId);
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
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  useEffect(() => {
    setVideo(selectedVideoId);
  }, [selectedVideoId, setVideo]);

  // 卡片「⋯」菜单:点菜单与触发按钮之外的任意位置即收起(都打了 data-video-menu)。
  useEffect(() => {
    if (!openMenuVideoId) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest("[data-video-menu]")) return;
      setOpenMenuVideoId(null);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [openMenuVideoId]);

  const goBackOneLevel = useCallback(() => {
    const now = Date.now();
    if (now - androidBackGuard.current < 250) return;
    androidBackGuard.current = now;

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
    // 窄屏「课程」Tab:选了课程→退回课程列表;已在列表根层则不拦截(交系统)。
    if (selectedCourseId) {
      setSelectedCourseId(null);
      return;
    }
  }, [
    queueOpen,
    selectedCourseId,
    selectedVideoId,
    showDevConsole,
    showRecycleBin,
    showSettings,
  ]);

  useEffect(() => {
    if (!isAndroidPlatform) return;

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
  }, [goBackOneLevel, isAndroidPlatform]);

  // ASR 完成后：章节、摘要、笔记、出题、脑图全部由后端流水线作为可见任务自动续跑
  // （见 pipeline::run_ai_followups），用户无需手动点「生成」。这里只补做不在后端任务
  // 队列里的「课件抽取」，并在各 AI 任务完成时刷新对应面板。
  useEffect(() => {
    // 注意：以 jobsByVideo 为遍历源，而非 queuedVideoIds——这样视频处理完成
    // 出队后，后端续跑的 AI 任务完成时仍能刷新对应面板。
    Object.keys(jobsByVideo).forEach((videoId) => {
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
  }, [jobsByVideo, queryClient, selectedCourseId]);

  // 处理完成（asr 完成或被取消）后把视频移出处理队列；失败的保留以显示错误。
  // 留一点时间让用户看到 100% 再消失。后端续跑的 AI 任务在后台继续，不影响视频已可用。
  useEffect(() => {
    const timers: number[] = [];
    queuedVideoIds.forEach((videoId) => {
      const active = activeJobFor(videoId);
      if (active?.status === "done" || active?.status === "canceled") {
        timers.push(
          window.setTimeout(() => {
            setQueuedVideoIds((ids) => ids.filter((id) => id !== videoId));
          }, 1200),
        );
      }
    });
    return () => timers.forEach((timer) => window.clearTimeout(timer));
  }, [jobsByVideo, queuedVideoIds]);

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
    // 拖动期间直接改 .ca-wb 上的 CSS 变量（不触发 React 重渲染、不写 storage），
    // 松手时才提交一次 state + 持久化，避免每次 pointermove 重渲染整个工作台。
    const wb = event.currentTarget.parentElement as HTMLElement | null;
    const startX = event.clientX;
    const startWidth = studyPanelWidth;
    liveWidthRef.current = startWidth;
    // 冻结右侧面板内容宽度：拖动期间内容不随列宽连续 reflow（长文稿尤其卡），
    // 松手后（去掉 is-resizing-panel 类）再一次性回流到最终宽度。
    wb?.style.setProperty("--panel-frozen-width", `${startWidth}px`);
    setIsResizingPanel(true);
    // 按工作台实际宽度限制：面板最小 280，且至少给视频留 320，避免小屏（手机横屏）被挤没。
    const containerW = wb?.clientWidth ?? 0;
    const minPanel = 280;
    const maxPanel = containerW > 0 ? Math.max(minPanel, containerW - 320) : 720;
    const onMove = (move: PointerEvent) => {
      const next = Math.min(maxPanel, Math.max(minPanel, startWidth - (move.clientX - startX)));
      liveWidthRef.current = next;
      wb?.style.setProperty("--study-panel-width", `${next}px`);
    };
    const onUp = () => {
      setIsResizingPanel(false);
      const finalWidth = liveWidthRef.current;
      setStudyPanelWidth(finalWidth);
      window.localStorage.setItem(PANEL_WIDTH_STORAGE_KEY, String(finalWidth));
      if (selectedVideoId) {
        writeVideoResumeState(selectedVideoId, { studyPanelWidth: finalWidth });
      }
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }

  // 双击分隔条:把面板宽度复位到默认值(480),省去手动拖回。
  function resetStudyPanelWidth() {
    const next = 480;
    liveWidthRef.current = next;
    setStudyPanelWidth(next);
    window.localStorage.setItem(PANEL_WIDTH_STORAGE_KEY, String(next));
    if (selectedVideoId) {
      writeVideoResumeState(selectedVideoId, { studyPanelWidth: next });
    }
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
    openVideo(videoId);
  }

  function selectCourse(id: string) {
    setSelectedCourseId(id);
    setSelectedVideoId(null);
    setQueueOpen(false);
    setShowSettings(false);
    setShowRecycleBin(false);
    setShowDevConsole(false);
  }

  function toggleQueue() {
    setSelectedVideoId(null);
    setShowSettings(false);
    setShowRecycleBin(false);
    setShowDevConsole(false);
    setQueueOpen((open) => !open);
  }

  function returnToLibrary() {
    setRailVideosOpen(false);
    setSelectedVideoId(null);
    setQueueOpen(false);
    setShowSettings(false);
    setShowRecycleBin(false);
    setShowDevConsole(false);
  }

  // 窄屏底部 Tab 切换:课程→回到课程下钻当前层;队列/设置→打开对应整页。
  function selectCompactTab(tab: CompactTab) {
    setCompactTab(tab);
    if (tab === "courses") {
      setQueueOpen(false);
      setShowSettings(false);
      setShowRecycleBin(false);
      setShowDevConsole(false);
    } else if (tab === "queue") {
      setShowSettings(false);
      setShowRecycleBin(false);
      setShowDevConsole(false);
      setQueueOpen(true);
    } else {
      setQueueOpen(false);
      setShowRecycleBin(false);
      setShowDevConsole(false);
      setShowSettings(true);
    }
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
            <div className="flex w-full flex-col gap-3">
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
                          {displayTitle(video.title)}
                        </div>
                        <span className="shrink-0 tabular-nums text-xs text-[var(--text-muted)]">
                          {percent}%
                        </span>
                      </div>
                      <div className="mt-2 h-1.5 overflow-hidden rounded bg-[var(--surface-card-hover)]">
                        <div
                          className={
                            active?.status === "failed"
                              ? "h-full bg-[var(--status-err)]"
                              : "h-full bg-primary"
                          }
                          style={{ width: `${percent}%` }}
                        />
                      </div>
                      <div
                        className={
                          active?.status === "failed"
                            ? "mt-1.5 truncate text-xs text-[var(--status-err)]"
                            : "mt-1.5 truncate text-xs text-[var(--text-muted)]"
                        }
                      >
                        {message}
                      </div>
                    </button>
                    {canCancel && (
                      <button
                        onClick={() => void ipc.pipeline.cancel(video.id)}
                        className="ca-touch-44 absolute right-3 top-3 rounded-md border border-[var(--border-subtle)] bg-[var(--surface-panel)] px-2 py-1 text-xs text-[var(--text-muted)] transition hover:text-[var(--status-err)]"
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
        aria-haspopup="menu"
        aria-expanded={openMenuVideoId === video.id}
        data-video-menu
        className="ca-touch-44 absolute right-3 top-3 flex h-8 w-8 items-center justify-center rounded-full bg-[var(--surface-panel)] text-[var(--text-muted)] shadow hover:text-[var(--text-strong)]"
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
        data-video-menu
        className="absolute right-3 top-12 z-10 w-32 overflow-hidden rounded-md border border-[var(--border-subtle)] bg-[var(--surface-panel)] py-1 text-sm shadow-[var(--shadow-pop)]"
      >
        <button
          type="button"
          role="menuitem"
          className="ca-touch-44 block w-full px-3 py-2 text-left hover:bg-[var(--surface-card-hover)]"
          onClick={() => {
            setOpenMenuVideoId(null);
            setRenamingVideo({ id: video.id, title: displayTitle(video.title) });
          }}
        >
          修改标题
        </button>
        <button
          type="button"
          role="menuitem"
          className="ca-touch-44 mt-1 block w-full border-t border-[var(--border-subtle)] px-3 py-2 pt-2.5 text-left text-[var(--status-err)] hover:bg-[var(--surface-card-hover)]"
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
          className="ca-touch-44 block w-full px-3 py-2 text-left hover:bg-[var(--surface-card-hover)]"
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
          autoFocus
          onFocus={(event) => event.currentTarget.select()}
          className="min-h-11 w-full rounded border border-[var(--border-subtle)] bg-[var(--surface-input)] px-2 py-1.5 text-xs text-[var(--text-strong)] outline-none focus:border-primary/70"
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
            className="ca-touch-44 flex h-7 w-7 items-center justify-center rounded text-[var(--text-muted)] hover:bg-[var(--surface-card-hover)]"
            onClick={() => setRenamingVideo(null)}
          >
            <X className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            aria-label="保存标题"
            className="ca-touch-44 flex h-7 w-7 items-center justify-center rounded border border-[var(--border-subtle)] bg-[var(--surface-card)] text-[var(--text-strong)] hover:bg-[var(--surface-card-hover)] disabled:opacity-50"
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
          aria-label={`打开视频：${displayTitle(video.title)}`}
          onClick={() => openVideo(video.id)}
        >
          <span className="ca-thumb">
            <VideoCover
              videoId={video.id}
              className="absolute inset-0 h-full w-full"
            />
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
              {displayTitle(video.title)}
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
          aria-label={`打开视频：${displayTitle(video.title)}`}
          onClick={() => openVideo(video.id)}
        >
          <span className="row-main">
            <span className="row-thumb">
              <VideoCover
                videoId={video.id}
                className="absolute inset-0 h-full w-full"
              />
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
              <span className="t">{displayTitle(video.title)}</span>
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
                onClick={() => setSelectedCourseId(null)}
                title="返回课程库"
                aria-label="返回课程库"
              >
                <ChevronLeft className="h-5 w-5" />
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
        className={`ca-wb ${isResizingPanel ? "is-resizing-panel" : ""}`}
        style={
          showResizer
            ? ({ "--study-panel-width": `${studyPanelWidthForLayout}px` } as CSSProperties)
            : undefined
        }
      >
        <section aria-label="学习工作台" className="ca-player-col">
          {!isPhoneDevice && (
            <header className="ca-wb-head">
              <div className="wb-title-row">
                <div className="min-w-0">
                  <h1 className="wb-title">{displayTitle(selectedVideo.title)}</h1>
                </div>
              </div>
            </header>
          )}
          <div className="ca-stage-wrap">
            {isPhoneDevice && (
              <button
                type="button"
                className="ca-back-fab"
                onClick={returnToLibrary}
                title="返回"
                aria-label="返回"
              >
                <ChevronLeft className="h-5 w-5" />
              </button>
            )}
            <div className="ca-stage">
              {mediaSrc ? (
                <VideoPlayer
                  src={mediaSrc}
                  videoId={selectedVideo.id}
                  immersive={isPhoneDevice}
                />
              ) : (
                <div className="flex h-full items-center justify-center bg-black text-sm text-white/40">
                  正在准备播放…
                </div>
              )}
            </div>
          </div>
        </section>
        {showResizer && (
          <div
            role="separator"
            aria-label="调整学习资料宽度"
            aria-orientation="vertical"
            title="拖动调整宽度,双击重置"
            className={`ca-resizer ${isResizingPanel ? "is-resizing" : ""}`}
            onPointerDown={beginStudyPanelResize}
            onDoubleClick={resetStudyPanelWidth}
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
        <button
          className={`rail-btn ${railVideosOpen ? "active" : ""}`}
          title="课程视频"
          aria-label="课程视频"
          aria-expanded={railVideosOpen}
          onClick={() => setRailVideosOpen((open) => !open)}
        >
          <List className="h-5 w-5" />
        </button>
        <div className="rail-sp" />
        <button
          className="rail-btn"
          title={themeToggleLabel}
          aria-label={themeToggleLabel}
          onClick={toggleTheme}
        >
          {isLightTheme ? <Moon className="h-5 w-5" /> : <Sun className="h-5 w-5" />}
        </button>
        <button
          className="rail-btn"
          title="设置"
          aria-label="设置"
          onClick={() => openMainView("settings")}
        >
          <Settings className="h-5 w-5" />
        </button>
      </nav>
    );
  }

  // 工作台左侧栏「课程视频」菜单：在侧栏右侧弹出同课程的全部视频，点选即切换。
  function renderRailVideoFlyout() {
    return (
      <>
        <div
          className="ca-rail-flyout-scrim"
          onClick={() => setRailVideosOpen(false)}
        />
        <div className="ca-rail-flyout" role="dialog" aria-label="课程视频列表">
          <div className="ca-rail-flyout-head">
            <span className="t">{selectedCourse?.name ?? "课程视频"}</span>
            <button
              type="button"
              className="ca-icon-btn"
              aria-label="关闭"
              onClick={() => setRailVideosOpen(false)}
            >
              <X className="h-4 w-4" />
            </button>
          </div>
          <div className="ca-rail-flyout-list">
            {videos.map((video) => (
              <button
                key={video.id}
                type="button"
                className={`ca-rail-flyout-item ${video.id === selectedVideoId ? "on" : ""}`}
                aria-current={video.id === selectedVideoId ? "true" : undefined}
                onClick={() => {
                  openVideo(video.id);
                  setRailVideosOpen(false);
                }}
              >
                <Play className="h-3.5 w-3.5 flex-none" />
                <span className="nm">{displayTitle(video.title)}</span>
              </button>
            ))}
            {videos.length === 0 && (
              <div className="ca-rail-flyout-empty">该课程暂无视频</div>
            )}
          </div>
        </div>
      </>
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
        }}
        onToggleTheme={toggleTheme}
        theme={theme}
        themeToggleLabel={themeToggleLabel}
        queueOpen={queueOpen}
        queueCount={queuedVideoIds.length}
        onToggleQueue={toggleQueue}
        onOpenRecycleBin={() => {
          openMainView("recycle");
        }}
      />
    );
  }

  // 窄屏「课程」Tab 的根页:整屏课程列表(复用 CourseSidebar 的增删改),回收站置于右上。
  function renderCourseListScreen() {
    if (tabletWide) {
      return renderSidebar();
    }
    return (
      <CourseSidebar
        variant="screen"
        selectedCourseId={selectedCourseId}
        onSelect={selectCourse}
        theme={theme}
        themeToggleLabel={themeToggleLabel}
        onOpenRecycleBin={() => openMainView("recycle")}
      />
    );
  }

  const isWorkbenchView = !!selectedVideo && !showSettings && !showRecycleBin && !showDevConsole && !queueOpen;
  // 窄屏底部 Tab 仅在「非工作台」时显示(工作台全屏沉浸)。
  const showBottomTab = isPhoneDevice && !isWorkbenchView;
  // 窄屏「课程」Tab 根层(未选课程、未开队列/设置/回收/控制台)→ 整屏课程列表。
  const showCourseListScreen =
    isPhoneDevice &&
    compactTab === "courses" &&
    !selectedCourseId &&
    !queueOpen &&
    !showSettings &&
    !showRecycleBin &&
    !showDevConsole;

  return (
    <div
      ref={appRef}
      data-theme={theme}
      data-bucket={bucket}
      data-device={tabletWide ? "tablet" : "phone-or-desktop"}
      data-view={isWorkbenchView ? "workbench" : "library"}
      style={accentVars(accent, theme, customAccent) as CSSProperties}
      className="ca-app"
    >
      {isPhoneDevice ? null : isWorkbenchView ? renderRail() : renderSidebar()}
      {!isPhoneDevice && isWorkbenchView && railVideosOpen && renderRailVideoFlyout()}
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
        ) : showCourseListScreen ? (
          renderCourseListScreen()
        ) : (
          renderCourseVideoLibrary()
        )}
      </main>
      {showBottomTab && (
        <BottomTabBar
          active={compactTab}
          queueCount={queuedVideoIds.length}
          onSelect={selectCompactTab}
        />
      )}
    </div>
  );
}
