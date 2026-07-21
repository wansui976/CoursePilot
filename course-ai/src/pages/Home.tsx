import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Check,
  ChevronLeft,
  Film,
  LayoutGrid,
  List,
  MoreHorizontal,
  Play,
  X,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from "react";
import { onBackButtonPress } from "@tauri-apps/api/app";
import { confirm as confirmDialog } from "@tauri-apps/plugin-dialog";
import { AppSidebar } from "@/components/AppSidebar";
import { CourseSidebar } from "@/components/CourseSidebar";
import { RecycleBin } from "@/components/RecycleBin";
import { Dashboard } from "@/components/Dashboard";
import { DevConsole } from "@/components/DevConsole";
import { ImportVideoButton } from "@/components/ImportVideoDialog";
import { SettingsPanel } from "@/components/SettingsDialog";
import { TabsPanel } from "@/components/TabsPanel";
import { SortableVideoItem, SortableVideos } from "@/components/SortableVideos";
import { VideoCover } from "@/components/VideoCover";
import { VideoPlayer } from "@/components/VideoPlayer";
import { BottomTabBar, type CompactTab } from "@/components/BottomTabBar";
import { Badge, type BadgeTone } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import { ErrorNote } from "@/components/ui/ErrorNote";
import { IconButton } from "@/components/ui/icon-button";
import { Menu, MenuItem } from "@/components/ui/menu";
import { coarsePointer, useContainerWidth, useIsPortrait } from "@/lib/useContainerWidth";
import { ipc, type DueCard } from "@/lib/ipc";
import type { Video } from "@/lib/types";
import { formatMs } from "@/lib/time";
import { displayTitle } from "@/lib/videoTitle";
import {
  readLastVideoId,
  readPlaybackProgress,
  writeLastVideoId,
} from "@/lib/playback";
import { readVideoResumeState, writeVideoResumeState } from "@/lib/resumeState";
import { isIOS, isTablet } from "@/lib/platform";
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

const statusTone: Record<Video["processed_status"], BadgeTone> = {
  pending: "neutral",
  processing: "processing",
  done: "success",
  failed: "danger",
};

const PANEL_WIDTH_STORAGE_KEY = "course-ai-study-panel-width";
const VIEW_STORAGE_KEY = "course-ai-home-view";

// 看到这个比例视为「已看完」：进度条隐藏，改显示看完标记。
const WATCHED_RATIO = 0.995;

type LibraryView = "grid" | "list";

function readInitialView(): LibraryView {
  if (typeof window === "undefined") return "grid";
  return window.localStorage.getItem(VIEW_STORAGE_KEY) === "list"
    ? "list"
    : "grid";
}

function readPanelWidth() {
  if (typeof window === "undefined") return 480;
  // 没存过要走默认 480：Number(null) 是 0（有限数），不先判空会被下面夹成下限 360。
  const raw = window.localStorage.getItem(PANEL_WIDTH_STORAGE_KEY);
  if (!raw) return 480;
  const saved = Number(raw);
  return Number.isFinite(saved) ? Math.min(720, Math.max(360, saved)) : 480;
}

const SIDEBAR_COLLAPSED_KEY = "course-ai-sidebar-collapsed";

type SidebarCollapsed = { library: boolean; workbench: boolean };

// 首次默认：课程库展开（选课要概览）、工作台折叠（看视频省空间）。
function readSidebarCollapsed(): SidebarCollapsed {
  const fallback: SidebarCollapsed = { library: false, workbench: true };
  if (typeof window === "undefined") return fallback;
  try {
    const raw = window.localStorage.getItem(SIDEBAR_COLLAPSED_KEY);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw) as Partial<SidebarCollapsed>;
    return {
      library: parsed.library === true,
      workbench: parsed.workbench !== false,
    };
  } catch {
    return fallback;
  }
}

export function Home() {
  const [selectedCourseId, setSelectedCourseId] = useState<string | null>(null);
  const [selectedVideoId, setSelectedVideoId] = useState<string | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [showRecycleBin, setShowRecycleBin] = useState(false);
  const [showDevConsole, setShowDevConsole] = useState(false);
  const [showDashboard, setShowDashboard] = useState(false);
  const theme = useTheme((s) => s.effective);
  const accent = useTheme((s) => s.accent);
  const customAccent = useTheme((s) => s.customAccent);
  const toggleTheme = useTheme((s) => s.toggle);
  const [view, setView] = useState<LibraryView>(readInitialView);
  // 库内标题过滤（前端过滤，不落存储；切课程时清空）。
  const [videoQuery, setVideoQuery] = useState("");
  const [openMenuVideoId, setOpenMenuVideoId] = useState<string | null>(null);
  const [renamingVideo, setRenamingVideo] = useState<{
    id: string;
    title: string;
  } | null>(null);
  const [queueOpen, setQueueOpen] = useState(false);
  const [queueTick, setQueueTick] = useState(0);
  const [queuedVideos, setQueuedVideos] = useState<Video[]>([]);
  const [compactTab, setCompactTab] = useState<CompactTab>("courses");
  const [studyPanelWidth, setStudyPanelWidth] = useState(readPanelWidth);
  const [isResizingPanel, setIsResizingPanel] = useState(false);
  // 拖动期间的实时宽度（用 ref，不触发重渲染；松手才提交到 state）。
  const liveWidthRef = useRef(studyPanelWidth);
  // 拖拽 resize 的监听清理：中途卸载（快速切换视频/返回）时也要摘掉 window 上的监听，
  // 否则残留的 pointermove/pointerup 会引用已解绑的 DOM 节点。
  const resizeAbortRef = useRef<AbortController | null>(null);
  // 统一侧栏折叠状态：分视图记忆（课程库 / 工作台）。
  const [sidebarCollapsed, setSidebarCollapsed] = useState<SidebarCollapsed>(readSidebarCollapsed);
  const queryClient = useQueryClient();
  const setVideo = usePlayer((s) => s.setVideo);
  const jobsByVideo = useJobs((s) => s.byVideo);
  const setJob = useJobs((s) => s.setOne);
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
  const returnToLibrary = useCallback(() => {
    setSelectedVideoId(null);
    setShowSettings(false);
    setShowRecycleBin(false);
    setShowDevConsole(false);
    setShowDashboard(false);
    setQueueOpen(false);
  }, []);

  const {
    data: videos = [],
    isError: videosError,
    error: videosErrorObj,
    refetch: refetchVideos,
  } = useQuery({
    queryKey: ["videos", selectedCourseId],
    queryFn: () => ipc.videos.list(selectedCourseId!),
    enabled: !!selectedCourseId,
  });
  const { data: courses = [] } = useQuery({
    queryKey: ["courses"],
    queryFn: ipc.courses.list,
  });
  const { data: activeProcessingVideos = [] } = useQuery({
    queryKey: ["processing-videos"],
    queryFn: ipc.pipeline.active,
  });
  const selectedCourse = courses.find(
    (course) => course.id === selectedCourseId,
  );

  useEffect(() => {
    if (activeProcessingVideos.length === 0) return;
    setQueuedVideos((items) => {
      const known = new Set(items.map((item) => item.id));
      const recovered = activeProcessingVideos.filter((video) => !known.has(video.id));
      return recovered.length > 0 ? [...recovered, ...items] : items;
    });
    for (const video of activeProcessingVideos) {
      void ipc.pipeline.jobs(video.id).then((rows) => {
        rows.forEach((job) =>
          setJob({
            video_id: job.video_id,
            job_id: job.id,
            stage: job.stage,
            status: job.status,
            progress: job.progress,
            message: job.message,
          }),
        );
      });
    }
  }, [activeProcessingVideos, setJob]);

  const normalizedQuery = videoQuery.trim().toLowerCase();
  // 过滤只影响展示；排序、菜单上移/下移等按全量 videos 计算。
  const visibleVideos = normalizedQuery
    ? videos.filter((video) =>
        displayTitle(video.title).toLowerCase().includes(normalizedQuery),
      )
    : videos;

  const reorderVideos = useMutation({
    mutationFn: (orderedIds: string[]) =>
      ipc.videos.reorder(selectedCourseId!, orderedIds),
    // 乐观更新：拖放一松手就按新顺序渲染；后端失败时 onError 拉回真实顺序。
    onMutate: (orderedIds) => {
      queryClient.setQueryData<Video[]>(["videos", selectedCourseId], (old) => {
        if (!old) return old;
        const byId = new Map(old.map((video) => [video.id, video]));
        const next = orderedIds.flatMap((id) => byId.get(id) ?? []);
        return next.length === old.length ? next : old;
      });
    },
    onError: () => {
      void queryClient.invalidateQueries({
        queryKey: ["videos", selectedCourseId],
      });
    },
  });

  function changeView(next: LibraryView) {
    setView(next);
    window.localStorage.setItem(VIEW_STORAGE_KEY, next);
  }

  function openVideo(videoId: string) {
    // 记录「该课程最近打开的视频」，回到课程库时给「继续上次」横幅。
    // 用视频自己的 course_id（队列打开跨课程视频时 selectedCourseId 还是旧值）。
    const target =
      videos.find((video) => video.id === videoId) ??
      queuedVideos.find((video) => video.id === videoId);
    if (target) writeLastVideoId(target.course_id, videoId);
    const savedWidth = readVideoResumeState(videoId).studyPanelWidth;
    setStudyPanelWidth(
      savedWidth != null ? Math.min(720, Math.max(360, savedWidth)) : readPanelWidth(),
    );
    // 打开视频即回到工作台：合上可能叠在主区的设置/回收站/控制台/队列整页。
    closeMainOverlays();
    setSelectedVideoId(videoId);
  }

  // 复习卡「回看出处」：关掉仪表盘、切到卡所属课程，跨视频跳转由 pendingSeek 驱动。
  function reviewJump(card: DueCard) {
    closeMainOverlays();
    if (card.course_id) setSelectedCourseId(card.course_id);
    if (card.video_id && card.source_ms != null) {
      usePlayer.getState().requestOpenAt(card.video_id, card.source_ms);
    }
  }

  const selectedVideo =
    videos.find((video) => video.id === selectedVideoId) ??
    queuedVideos.find((video) => video.id === selectedVideoId);

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

  // 跨视频跳转（课程级搜索点到本课程其它视频）：打开目标视频，
  // 具体 seek 由目标播放器加载完成后消费 pendingSeek。
  const pendingSeek = usePlayer((s) => s.pendingSeek);
  useEffect(() => {
    if (pendingSeek && pendingSeek.videoId !== selectedVideoId) {
      openVideo(pendingSeek.videoId);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingSeek]);

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

  // 兜底：若拖拽 resize 进行中组件被卸载，卸载时摘掉残留的 window 监听。
  useEffect(() => () => resizeAbortRef.current?.abort(), []);

  const goBackOneLevel = useCallback(() => {
    const now = Date.now();
    if (now - androidBackGuard.current < 250) return;
    androidBackGuard.current = now;

    if (showSettings || showRecycleBin || showDevConsole || showDashboard) {
      setShowSettings(false);
      setShowRecycleBin(false);
      setShowDevConsole(false);
      setShowDashboard(false);
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
    showDashboard,
    returnToLibrary,
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

  useEffect(() => {
    if (!queueOpen || queuedVideos.length === 0) return;
    const timer = window.setInterval(() => {
      setQueueTick((tick) => tick + 1);
    }, 2000);
    return () => window.clearInterval(timer);
  }, [queueOpen, queuedVideos.length]);

  function startProcessing(video: Video) {
    const videoId = video.id;
    // 清掉这个视频的全部「已处理」标记：不仅 videoId，还有各 AI 阶段的
    // `${videoId}:${stage}`。否则重新处理后，阶段键仍在集合里，后端续跑的
    // 章节/摘要/笔记/出题/脑图完成时不会触发面板刷新，用户会看到旧内容。
    for (const key of [...generatedAfterAsr.current]) {
      if (key === videoId || key.startsWith(`${videoId}:`)) {
        generatedAfterAsr.current.delete(key);
      }
    }
    resetJobs(videoId);
    setQueuedVideos((items) => {
      const existing = items.some((item) => item.id === videoId);
      return existing
        ? items.map((item) => (item.id === videoId ? video : item))
        : [video, ...items];
    });
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
    setQueuedVideos((items) => items.filter((item) => item.id !== videoId));
    if (selectedVideoId === videoId) setSelectedVideoId(null);
    await queryClient.invalidateQueries({ queryKey: ["videos", selectedCourseId] });
    await queryClient.invalidateQueries({ queryKey: ["trash"] });
  }

  // 设置 / 回收站作为主区域整页，与处理队列一致；互斥切换。保留当前选中的视频，
  // 这样从控制台打开设置、点「返回」能回到原来的视频工作台，而不是退回首页。
  // 收起主区所有整页浮层（设置/回收站/控制台/队列）。新增浮层态时只改这一处，
  // 避免在各处手写「四个 setXxx(false)」漏改而出现两页同显。
  function closeMainOverlays() {
    setShowSettings(false);
    setShowRecycleBin(false);
    setShowDevConsole(false);
    setShowDashboard(false);
    setQueueOpen(false);
  }

  function openMainView(view: "settings" | "recycle" | "dev" | "dashboard") {
    setQueueOpen(false);
    setShowSettings(view === "settings");
    setShowRecycleBin(view === "recycle");
    setShowDevConsole(view === "dev");
    setShowDashboard(view === "dashboard");
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
    // rAF 合帧：一帧内多次 pointermove 只写一次（即只触发一次网格重排）。
    let raf = 0;
    let pendingX = startX;
    const apply = () => {
      raf = 0;
      const next = Math.min(maxPanel, Math.max(minPanel, startWidth - (pendingX - startX)));
      liveWidthRef.current = next;
      // 内联写 grid-template-columns（须与 globals.css 的 .ca-wb 列定义一致），
      // 而不是每帧改 --study-panel-width：自定义属性向整棵工作台子树继承，每帧一写
      // 会让全量文稿 DOM（数千节点）做样式重算——文稿打开时拖动卡顿的来源；
      // contain 只隔离布局/绘制，挡不住继承失效。内联属性只失效 .ca-wb 自身样式。
      wb?.style.setProperty(
        "grid-template-columns",
        `minmax(0, 1fr) 8px ${next}px`,
      );
    };
    const onMove = (move: PointerEvent) => {
      pendingX = move.clientX;
      if (!raf) raf = requestAnimationFrame(apply);
    };
    const onUp = () => {
      if (raf) cancelAnimationFrame(raf);
      setIsResizingPanel(false);
      const finalWidth = liveWidthRef.current;
      setStudyPanelWidth(finalWidth);
      // 先把最终宽度写回稳态变量、再撤掉拖动期的内联覆盖：与 React 提交先后无关，
      // 计算宽度始终等于 finalWidth，不会闪动。
      wb?.style.setProperty("--study-panel-width", `${finalWidth}px`);
      wb?.style.removeProperty("grid-template-columns");
      window.localStorage.setItem(PANEL_WIDTH_STORAGE_KEY, String(finalWidth));
      if (selectedVideoId) {
        writeVideoResumeState(selectedVideoId, { studyPanelWidth: finalWidth });
      }
      // abort() 一并摘掉下面用同一 signal 注册的 pointermove/pointerup。
      resizeAbortRef.current?.abort();
      resizeAbortRef.current = null;
    };
    // 用 AbortController 统一管理监听：onUp 里 abort，组件卸载时的 effect 也 abort，
    // 两条路径都能确保监听不残留（中途卸载不再泄漏对已解绑 DOM 的引用）。
    resizeAbortRef.current?.abort();
    const controller = new AbortController();
    resizeAbortRef.current = controller;
    window.addEventListener("pointermove", onMove, { signal: controller.signal });
    window.addEventListener("pointerup", onUp, { signal: controller.signal });
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

  function openQueuedVideo(video: Video) {
    setQueueOpen(false);
    if (selectedCourseId !== video.course_id) {
      setSelectedCourseId(video.course_id);
    }
    openVideo(video.id);
  }

  function selectCourse(id: string) {
    setSelectedCourseId(id);
    setSelectedVideoId(null);
    setVideoQuery("");
    closeMainOverlays();
  }

  function clearCourseSelection() {
    setSelectedCourseId(null);
    setSelectedVideoId(null);
    setVideoQuery("");
    closeMainOverlays();
  }

  function toggleQueue() {
    // 先算出目标态再收起全部：closeMainOverlays 会把 queueOpen 置 false，
    // 这里用当前渲染的 queueOpen 求反，最终以 setQueueOpen 覆盖，保留「再点收起」的切换语义。
    const willOpen = !queueOpen;
    setSelectedVideoId(null);
    closeMainOverlays();
    setQueueOpen(willOpen);
  }

  // 窄屏底部 Tab 切换:课程→回到课程下钻当前层;队列/设置→打开对应整页。
  function selectCompactTab(tab: CompactTab) {
    setCompactTab(tab);
    closeMainOverlays();
    if (tab === "queue") {
      setQueueOpen(true);
    } else if (tab === "settings") {
      setShowSettings(true);
    }
    // tab === "courses"：closeMainOverlays 已收起全部，无需再开任何整页。
  }

  function renderProcessingQueuePage() {
    return (
      <div
        aria-label="处理队列页面"
        className="flex min-h-0 flex-1 flex-col overflow-hidden"
      >
        <header className="flex flex-none items-start justify-between gap-4 border-b border-[var(--border-subtle)] bg-[var(--surface-header)] px-7 py-5">
          <div className="flex min-w-0 items-start gap-3">
            <IconButton
              className="mt-0.5"
              onClick={goBackOneLevel}
              aria-label="返回上一菜单"
              title="返回上一菜单"
            >
              <ChevronLeft className="h-4 w-4" />
            </IconButton>
            <div className="min-w-0">
              <h1 className="text-2xl font-semibold text-[var(--text-strong)]">
                处理队列
              </h1>
            </div>
          </div>
          <Badge tone="neutral" dot={false}>
            {queuedVideos.length} 个任务
          </Badge>
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
                      onClick={() => openQueuedVideo(video)}
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
      <IconButton
        type="button"
        aria-label="视频操作"
        aria-haspopup="menu"
        aria-expanded={openMenuVideoId === video.id}
        data-video-menu
        className="ca-touch-44 absolute right-3 top-3 h-7 w-7 rounded-full bg-[var(--surface-panel)] shadow"
        onClick={() =>
          setOpenMenuVideoId((id) => (id === video.id ? null : video.id))
        }
      >
        <MoreHorizontal className="h-3.5 w-3.5" />
      </IconButton>
    );
  }

  function videoMenu(video: Video) {
    if (openMenuVideoId !== video.id) return null;
    const index = videos.findIndex((item) => item.id === video.id);
    // 拖拽排序的键盘/无障碍替代：与相邻项交换位置，走同一个乐观更新 mutation。
    const moveTo = (targetIndex: number) => {
      setOpenMenuVideoId(null);
      const ids = videos.map((item) => item.id);
      const [moved] = ids.splice(index, 1);
      ids.splice(targetIndex, 0, moved);
      reorderVideos.mutate(ids);
    };
    return (
      <Menu
        aria-label="视频操作菜单"
        data-video-menu
        className="absolute right-3 top-12 z-10 w-32"
      >
        <MenuItem
          className="ca-touch-44"
          onClick={() => {
            setOpenMenuVideoId(null);
            setRenamingVideo({ id: video.id, title: displayTitle(video.title) });
          }}
        >
          修改标题
        </MenuItem>
        {/* 过滤态下移动的是全量列表位置、界面上看不出效果，藏掉避免困惑。 */}
        {!normalizedQuery && index > 0 && (
          <MenuItem className="ca-touch-44" onClick={() => moveTo(index - 1)}>
            上移
          </MenuItem>
        )}
        {!normalizedQuery && index !== -1 && index < videos.length - 1 && (
          <MenuItem className="ca-touch-44" onClick={() => moveTo(index + 1)}>
            下移
          </MenuItem>
        )}
        <MenuItem
          className="ca-touch-44"
          onClick={() => {
            setOpenMenuVideoId(null);
            // 已有字幕（处理完成）→ 仅重新 AI 纠错；否则跑完整处理。
            if (video.processed_status === "done") {
              recorrect.mutate(video.id);
            } else {
              startProcessing(video);
            }
          }}
        >
          {video.processed_status === "done"
            ? recorrect.isPending && recorrect.variables === video.id
              ? "纠错中…"
              : "重新纠错"
            : "开始处理"}
        </MenuItem>
        {/* 危险操作放最后并用分隔线隔开，避免夹在常规操作中间被误点。 */}
        <MenuItem
          tone="danger"
          className="ca-touch-44 mt-1 border-t border-[var(--border-subtle)] pt-2.5"
          onClick={() => {
            setOpenMenuVideoId(null);
            void deleteVideo(video.id);
          }}
        >
          删除
        </MenuItem>
      </Menu>
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
          className="min-h-11 w-full rounded border border-[var(--border-subtle)] bg-[var(--surface-input)] px-2 py-1.5 text-xs text-[var(--text-strong)] outline-none"
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
      <Badge
        data-testid="video-status-badge"
        tone={statusTone[status]}
      >
        {statusMeta[status].label}
      </Badge>
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
            <span className="st">{statusBadge(video)}</span>
            {/* 时长未知就不显示角标：假的「00:00」会让人以为视频是空的。 */}
            {durationMs != null && (
              <span className="dur">{formatMs(durationMs)}</span>
            )}
            {progress.ratio >= WATCHED_RATIO && (
              <span className="done">
                <Check className="h-3 w-3" />
                已看完
              </span>
            )}
            {progress.ratio > 0 && progress.ratio < WATCHED_RATIO && (
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
    // 列表要保持列对齐，时长未知显示占位而不是假的 00:00。
    const durationText = durationMs ? formatMs(durationMs) : "--:--";
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
              {progress.ratio >= WATCHED_RATIO && (
                <span className="done" role="img" aria-label="已看完">
                  <Check className="h-3 w-3" />
                </span>
              )}
              {progress.ratio > 0 && progress.ratio < WATCHED_RATIO && (
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

  // 「继续上次」横幅：该课程最近打开、且看了但没看完的视频，一键回到工作台
  // （播放器自带断点续播）。搜索过滤时不显示（那会儿用户在找别的）。
  function renderContinueBanner() {
    if (!selectedCourseId || normalizedQuery) return null;
    const lastId = readLastVideoId(selectedCourseId);
    if (!lastId) return null;
    const lastVideo = videos.find((video) => video.id === lastId);
    if (!lastVideo) return null;
    const progress = readPlaybackProgress(lastId);
    if (progress.ratio <= 0 || progress.ratio >= WATCHED_RATIO) return null;
    return (
      <button
        type="button"
        className="ca-continue"
        onClick={() => openVideo(lastId)}
      >
        <Play className="ic h-4 w-4" />
        <span className="lbl">继续上次</span>
        <span className="ttl">{displayTitle(lastVideo.title)}</span>
        <span className="pos">
          看到 {formatMs(Math.round(progress.positionSec * 1000))}
        </span>
      </button>
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
              {/* h1 给课程名（用户关心「我在哪个课程」），数量降为副标题。 */}
              <h1>{selectedCourse ? selectedCourse.name : "课程视频"}</h1>
              <div className="sub">
                {selectedCourse
                  ? `${videos.length} 个视频`
                  : "选择课程后导入或管理视频"}
              </div>
            </div>
          </div>
          {selectedCourseId && (
            <div className="tb-actions">
              {videos.length > 0 && (
                <input
                  aria-label="搜索视频"
                  placeholder="搜索视频"
                  className="tb-search"
                  value={videoQuery}
                  onChange={(event) => setVideoQuery(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Escape") setVideoQuery("");
                  }}
                />
              )}
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
              <ImportVideoButton
                courseId={selectedCourseId}
                onStartProcessing={startProcessing}
              />
            </div>
          )}
        </header>
        <div className="ca-scroll">
          {!videosError && renderContinueBanner()}
          {selectedCourseId && videosError ? (
            // 加载失败不再静默留空：显示错误 + 重试，用户能看到问题也能自助恢复。
            <div className="flex h-full min-h-[320px] items-center justify-center p-4">
              <ErrorNote
                error={videosErrorObj}
                onRetry={() => refetchVideos()}
                className="max-w-md"
              />
            </div>
          ) : !selectedCourseId || videos.length === 0 ? (
            <div className="flex h-full min-h-[320px] items-center justify-center">
              <EmptyState
                icon={<Film className="h-7 w-7" />}
                title={selectedCourseId ? "还没有视频" : "选择课程开始"}
                description={
                  selectedCourseId
                    ? "导入本地视频或粘贴视频链接后，会在这里形成课程视频列表。"
                    : "从左侧选择课程后导入或管理视频。"
                }
                action={
                  selectedCourseId ? (
                    <ImportVideoButton
                      courseId={selectedCourseId}
                      onStartProcessing={startProcessing}
                    />
                  ) : undefined
                }
              />
            </div>
          ) : visibleVideos.length === 0 ? (
            <div className="flex h-full min-h-[320px] items-center justify-center">
              <EmptyState
                icon={<Film className="h-7 w-7" />}
                title="没有匹配的视频"
                description={`没有标题包含「${videoQuery.trim()}」的视频。`}
              />
            </div>
          ) : view === "list" ? (
            <SortableVideos
              ids={visibleVideos.map((video) => video.id)}
              layout="list"
              // 过滤态禁用拖拽：子集顺序映射不回全量，后端也会按 id 全集校验拒绝。
              disabled={renamingVideo !== null || normalizedQuery !== ""}
              onReorder={(orderedIds) => reorderVideos.mutate(orderedIds)}
            >
              <div className="ca-list">
                <div className="ca-list-head">
                  <span>名称</span>
                  <span className="h-dur">时长</span>
                  <span className="h-status">状态</span>
                </div>
                {visibleVideos.map((video) => (
                  <SortableVideoItem key={video.id} id={video.id}>
                    {renderVideoListRow(video)}
                  </SortableVideoItem>
                ))}
              </div>
            </SortableVideos>
          ) : (
            <SortableVideos
              ids={visibleVideos.map((video) => video.id)}
              layout="grid"
              disabled={renamingVideo !== null || normalizedQuery !== ""}
              onReorder={(orderedIds) => reorderVideos.mutate(orderedIds)}
            >
              <div className="ca-grid">
                {visibleVideos.map((video) => (
                  <SortableVideoItem key={video.id} id={video.id}>
                    {renderVideoGridCard(video)}
                  </SortableVideoItem>
                ))}
              </div>
            </SortableVideos>
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
                  <h1 className="wb-title" title={displayTitle(selectedVideo.title)}>
                    {displayTitle(selectedVideo.title)}
                  </h1>
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
                  immersive={isIOS()}
                  resizing={isResizingPanel}
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

  // 窄屏「课程」Tab 的根页:整屏课程列表(复用 CourseSidebar 的增删改),回收站置于右上。
  function renderCourseListScreen() {
    return (
      <CourseSidebar
        selectedCourseId={selectedCourseId}
        onSelect={selectCourse}
        onClearSelection={clearCourseSelection}
        onOpenRecycleBin={() => openMainView("recycle")}
      />
    );
  }

  const isWorkbenchView = !!selectedVideo && !showSettings && !showRecycleBin && !showDevConsole && !showDashboard && !queueOpen;
  // 桌面：进入某个视频的工作台会话后，即便在主区叠开设置/回收站/控制台/队列整页，
  // 左侧仍保持窄工具栏（rail），不回退成首页的宽侧栏——设置只是覆盖主区，会话仍在。
  const inVideoSession = !!selectedVideo;
  const sidebarView: "library" | "workbench" = inVideoSession ? "workbench" : "library";
  const sidebarIsCollapsed = sidebarCollapsed[sidebarView];
  function toggleSidebarCollapsed() {
    setSidebarCollapsed((prev) => {
      const next = { ...prev, [sidebarView]: !prev[sidebarView] };
      window.localStorage.setItem(SIDEBAR_COLLAPSED_KEY, JSON.stringify(next));
      return next;
    });
  }
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

  // 主区当前视图的「类型」标识，作为入场动画的重挂 key（顺序须与下方主区条件渲染一致）。
  // 注意：工作台统一为 "workbench"，不含视频 id —— 切换视频不重挂、播放器状态保留。
  const mainViewKey = showSettings
    ? "settings"
    : showRecycleBin
      ? "recycle"
      : showDashboard
        ? "dashboard"
        : showDevConsole
          ? "dev"
          : queueOpen
          ? "queue"
          : selectedVideo
            ? "workbench"
            : showCourseListScreen
              ? "courselist"
              : "library";

  return (
    <div
      ref={appRef}
      data-theme={theme}
      data-bucket={bucket}
      data-device={tabletWide ? "tablet" : "phone-or-desktop"}
      data-view={isWorkbenchView || (!isPhoneDevice && inVideoSession) ? "workbench" : "library"}
      data-sidebar={isPhoneDevice ? undefined : sidebarIsCollapsed ? "collapsed" : "expanded"}
      style={accentVars(accent, theme, customAccent) as CSSProperties}
      className="ca-app"
    >
      {isPhoneDevice ? null : (
        <AppSidebar
          view={sidebarView}
          collapsed={sidebarIsCollapsed}
          onToggleCollapsed={toggleSidebarCollapsed}
          selectedCourseId={selectedCourseId}
          onSelectCourse={selectCourse}
          onClearCourseSelection={clearCourseSelection}
          videos={videos}
          selectedVideoId={selectedVideoId}
          onOpenVideo={openVideo}
          onBackToLibrary={returnToLibrary}
          theme={theme}
          themeToggleLabel={themeToggleLabel}
          onToggleTheme={toggleTheme}
          onOpenSettings={() => openMainView("settings")}
          onOpenRecycleBin={() => openMainView("recycle")}
          onOpenDashboard={() => openMainView("dashboard")}
          queueOpen={queueOpen}
          queueCount={queuedVideos.length}
          onToggleQueue={toggleQueue}
        />
      )}
      <main className="ca-main">
        {/* key=视图类型(而非视频 id):切换顶层视图时重挂以重播入场动画;在工作台内
            切换视频时 key 不变,播放器与面板状态保留、不被打断。 */}
        <div key={mainViewKey} className="ca-view">
          {showSettings ? (
            <SettingsPanel
              onClose={() => setShowSettings(false)}
              onOpenDevConsole={() => openMainView("dev")}
            />
          ) : showRecycleBin ? (
            <RecycleBin onClose={() => setShowRecycleBin(false)} />
          ) : showDashboard ? (
            <Dashboard
              onClose={() => setShowDashboard(false)}
              onOpenCourse={selectCourse}
              onJump={reviewJump}
            />
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
        </div>
      </main>
      {showBottomTab && (
        <BottomTabBar
          active={compactTab}
          queueCount={queuedVideos.length}
          onSelect={selectCompactTab}
        />
      )}
    </div>
  );
}
