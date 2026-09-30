import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { queries } from "@/lib/queries";
import { qk } from "@/lib/queryKeys";
import { useTranslation } from "react-i18next";
import { invalidateStaleArtifacts } from "@/lib/useStaleArtifacts";
import {
  Check,
  ChevronLeft,
  Film,
  FolderPlus,
  LayoutGrid,
  Lightbulb,
  List,
  Loader2,
  MoreHorizontal,
  Play,
  Search,
  Shrink,
  X,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { onBackButtonPress } from "@tauri-apps/api/app";
import { confirm as confirmDialog } from "@tauri-apps/plugin-dialog";
import { AppSidebar } from "@/components/AppSidebar";
import { AppRail } from "@/components/AppRail";
import { CourseSidebar } from "@/components/CourseSidebar";
import { useCreateCourse } from "@/components/CourseList";
import { RecycleBin } from "@/components/RecycleBin";
import { Dashboard } from "@/components/Dashboard";
import { ConceptsPanel, type ConceptNavigationState } from "@/components/ConceptsPanel";
import { DevConsole } from "@/components/DevConsole";
import { ImportVideoButton } from "@/components/ImportVideoDialog";
import { SettingsPanel } from "@/components/settings/SettingsPanel";
import { isSettingsCategory } from "@/components/settings/categories";
import { TabsPanel } from "@/components/TabsPanel";
import { WorkspaceLayout } from "@/components/workspace/WorkspaceLayout";
import { ProcessingQueuePanel } from "@/components/ProcessingQueuePanel";
import { SortableVideoItem, SortableVideos } from "@/components/SortableVideos";
import { VideoCover } from "@/components/VideoCover";
import { VideoPlayer } from "@/components/VideoPlayer";
import { BottomTabBar, type CompactTab } from "@/components/BottomTabBar";
import { Badge, type BadgeTone } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import { ErrorNote } from "@/components/ui/ErrorNote";
import { IconButton } from "@/components/ui/icon-button";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Menu, MenuItem } from "@/components/ui/menu";
import {
  coarsePointer,
  useContainerPixelWidth,
  useContainerWidth,
  useIsPortrait,
} from "@/lib/useContainerWidth";
import { ipc, type DueCard } from "@/lib/ipc";
import { humanizeError } from "@/lib/errors";
import {
  currentStage,
  overallProgress,
  stageMessage,
} from "@/lib/pipelineProgress";
import { canRecorrect } from "@/lib/videoActions";
import type {
  AssistantAction,
  Video,
  VideoListItem,
} from "@/lib/types";
import { buildAssistantContext, reconcileAssistantAction } from "@/lib/assistantHome";
import { formatMs } from "@/lib/time";
import { displayTitle } from "@/lib/videoTitle";
import {
  WATCHED_RATIO,
  readLastVideoId,
  readPlaybackProgress,
  writeLastVideoId,
} from "@/lib/playback";
import { useStudyReminder } from "@/lib/useStudyReminder";
import { isIOS, isTablet } from "@/lib/platform";
import { usePlayer } from "@/stores/player";
import { AssistantPanel } from "@/components/AssistantPanel";
import { useJobs, type JobUpdate } from "@/stores/jobs";
import { accentVars, useTheme } from "@/stores/theme";
import { useAssistantUi } from "@/stores/assistant";
import { useHomeRoute } from "@/app/homeRoute";
import { getCurrentWindow } from "@tauri-apps/api/window";

const statusLabelKey = {
  pending: "home.statusPending",
  processing: "home.statusProcessing",
  done: "home.statusDone",
  failed: "home.statusFailed",
} as const;

const statusTone: Record<Video["processed_status"], BadgeTone> = {
  pending: "neutral",
  processing: "processing",
  done: "success",
  failed: "danger",
};

const VIEW_STORAGE_KEY = "course-ai-home-view";
const GRID_DENSITY_KEY = "course-ai-grid-density";

type GridDensity = "cozy" | "compact";

function readGridDensity(): GridDensity {
  if (typeof window === "undefined") return "cozy";
  return window.localStorage.getItem(GRID_DENSITY_KEY) === "compact"
    ? "compact"
    : "cozy";
}

type LibraryView = "grid" | "list";

function readInitialView(): LibraryView {
  if (typeof window === "undefined") return "grid";
  return window.localStorage.getItem(VIEW_STORAGE_KEY) === "list"
    ? "list"
    : "grid";
}

const SIDEBAR_COLLAPSED_KEY = "course-ai-sidebar-collapsed";

type SidebarCollapsed = { library: boolean; workbench: boolean };

type KnowledgeReturnState = {
  courseId: string;
  navigationState: ConceptNavigationState;
};

type JobLoadState =
  | { status: "loading" }
  | { status: "ready" }
  | { status: "error"; error: unknown };

export function dispatchAssistantNavigation(
  action: AssistantAction,
  currentVideoId: string | null,
  commands: {
    selectCourse: (courseId: string) => void;
    openAt: (videoId: string, atMs: number) => void;
    seek: (atMs: number) => void;
    clearPendingOpen: () => void;
  },
) {
  if (action.kind === "open_video") {
    if (action.course_id) commands.selectCourse(action.course_id);

    const atMs = Math.max(0, action.at_ms ?? 0);
    if (action.video_id === currentVideoId) {
      // pendingSeek 只在 loadedmetadata 时消费；当前视频不会重新触发该事件，必须直接 seek。
      commands.clearPendingOpen();
      if (action.at_ms != null) commands.seek(atMs);
      return;
    }

    commands.openAt(action.video_id, atMs);
    return;
  }

  if (action.kind === "seek_to") {
    commands.clearPendingOpen();
    commands.seek(Math.max(0, action.at_ms));
  }
}

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
  // 主区视图与课程/视频选择都由路由承载（见 app/homeRoute）；视图互斥由路径天然保证。
  const {
    view: mainView,
    courseId: selectedCourseId,
    videoId: selectedVideoId,
    settingsCategory,
    go,
  } = useHomeRoute();
  const showSettings = mainView === "settings";
  const showRecycleBin = mainView === "recycle";
  const showDevConsole = mainView === "dev";
  const showDashboard = mainView === "dashboard";
  const showConcepts = mainView === "concepts";
  const queueOpen = mainView === "queue";
  const [knowledgeReturn, setKnowledgeReturn] = useState<KnowledgeReturnState | null>(null);
  const { t } = useTranslation();
  // 应用打开时的学习提醒（开启且今天有到期卡才发，每天至多一次）。
  useStudyReminder();
  const theme = useTheme((s) => s.effective);
  const accent = useTheme((s) => s.accent);
  const customAccent = useTheme((s) => s.customAccent);
  const toggleTheme = useTheme((s) => s.toggle);
  // 助手只有浮动一种形态，盖在内容上方，不占主区宽度；rail 按钮就是开/关。
  const assistantOpen = useAssistantUi((s) => s.open);
  const toggleAssistant = useAssistantUi((s) => s.toggle);
  const [view, setView] = useState<LibraryView>(readInitialView);
  // 网格卡片密度（舒适/紧凑）：只影响网格列宽，切到列表视图无意义但保留记忆。
  const [gridDensity, setGridDensity] = useState<GridDensity>(readGridDensity);
  // 库内标题过滤（前端过滤，不落存储；切课程时清空）。
  const [videoQuery, setVideoQuery] = useState("");
  const [openMenuVideoId, setOpenMenuVideoId] = useState<string | null>(null);
  const [renamingVideo, setRenamingVideo] = useState<{
    id: string;
    title: string;
  } | null>(null);
  const videoMenuTriggerRef = useRef<HTMLButtonElement | null>(null);
  const renameOriginTriggerRef = useRef<HTMLButtonElement | null>(null);
  const renameDialogRef = useRef<HTMLDivElement | null>(null);
  const [queueTick, setQueueTick] = useState(0);
  const [queuedVideos, setQueuedVideos] = useState<Video[]>([]);
  // 队列卡片的 jobs 是独立 IPC 请求；没有这层状态时，失败会落成「没有阶段」并显示等待中。
  const [jobLoadStateByVideo, setJobLoadStateByVideo] = useState<
    Record<string, JobLoadState>
  >({});
  const jobRequestRef = useRef<Record<string, number>>({});
  const requestedJobIdsRef = useRef<Set<string>>(new Set());
  const { createCourse, creatingCourse, createError } = useCreateCourse();
  // 统一侧栏折叠状态：分视图记忆（课程库 / 工作台）。
  const [sidebarCollapsed, setSidebarCollapsed] = useState<SidebarCollapsed>(readSidebarCollapsed);
  const queryClient = useQueryClient();
  const setVideo = usePlayer((s) => s.setVideo);
  const jobsByVideo = useJobs((s) => s.byVideo);
  const setJob = useJobs((s) => s.setOne);
  const resetJobs = useJobs((s) => s.resetVideo);
  const generatedAfterAsr = useRef<Set<string>>(new Set());
  const appRef = useRef<HTMLDivElement>(null);
  const settingsExitRequestRef = useRef<
    ((continuation: () => void) => void) | null
  >(null);
  const settingsBackRequestRef = useRef<(() => void) | null>(null);
  const transientCloseRef = useRef<(() => void) | null>(null);
  const dismissVisibleTransientRef = useRef<
    ((continuation?: () => void) => boolean) | null
  >(null);
  const registerTransientClose = useCallback((close: (() => void) | null) => {
    transientCloseRef.current = close;
  }, []);
  const registerSettingsExitRequest = useCallback(
    (request: ((continuation: () => void) => void) | null) => {
      settingsExitRequestRef.current = request;
    },
    [],
  );
  const registerSettingsBackRequest = useCallback((request: (() => void) | null) => {
    settingsBackRequestRef.current = request;
  }, []);
  const runAfterSettingsExit = useCallback(
    (continuation: () => void) => {
      if (showSettings && settingsExitRequestRef.current) {
        settingsExitRequestRef.current(continuation);
        return;
      }
      continuation();
    },
    [showSettings],
  );
  const runAfterWorkspaceTransient = useCallback(
    (continuation: () => void) => {
      runAfterSettingsExit(() => {
        if (
          selectedVideoId &&
          dismissVisibleTransientRef.current?.(continuation)
        ) {
          return;
        }
        continuation();
      });
    },
    [runAfterSettingsExit, selectedVideoId],
  );
  const bucket = useContainerWidth(appRef);
  const appPixelWidth = useContainerPixelWidth(appRef);
  const isLightTheme = theme === "light";
  const themeToggleLabel = isLightTheme ? t("home.themeLightLabel") : t("home.themeDarkLabel");
  const tabletDevice = isTablet();
  const portrait = useIsPortrait();
  // 触控优先：iOS/iPad 竖屏一律走底部 Tab / 上下叠放布局；只有横屏才保留桌面式左右分栏。
  // 方向必须单独判断:12.9" iPad 竖屏宽 1024 会落入 wide 档,只看 bucket 仍会被当宽屏左右布局。
  const stackedPortrait = portrait && (tabletDevice || coarsePointer());
  const shellWide = bucket === "wide" && !stackedPortrait;
  const tabletWide = tabletDevice && shellWide;
  const isPhoneDevice = !shellWide;
  // rail 常驻消耗 56px；宽栏只在展开时再占 256px，折叠时为 0。宽度总和喂给工作台布局。
  const sidebarWidth = shellWide
    ? 56 + (sidebarCollapsed[selectedVideoId ? "workbench" : "library"] ? 0 : 256)
    : 0;
  const workbenchAvailableWidth = Math.max(0, appPixelWidth - sidebarWidth);
  // 硬件返回键是「平台能力」（仅 Android 有），与布局宽度无关：用 UA 判平台，
  // 避免在桌面拦截窗口关闭。
  const isAndroidPlatform =
    typeof navigator !== "undefined" && /android/i.test(navigator.userAgent);
  const androidBackGuard = useRef(0);
  const [videoFullscreen, setVideoFullscreen] = useState(false);
  const returnToLibrary = useCallback(() => {
    setKnowledgeReturn(null);
    go({ view: "library", videoId: null });
  }, [go]);

  const {
    data: videos = [],
    isPending: videosPending,
    isError: videosError,
    error: videosErrorObj,
    refetch: refetchVideos,
  } = useQuery(queries.videos(selectedCourseId));
  const { data: courses = [] } = useQuery(queries.courses());
  // 顶栏副标「已看完 N 个」：本地按播放进度聚合，零后端改动。
  // 不 memo：看完一集从工作台返回时 videos 引用不变（react-query 结构共享），
  // memo 会停在旧值，而卡片 ov-bar 是渲染期直读 localStorage 反而是新的——同屏打架。
  // 直接渲染期算（几十集的规模，localStorage 读几十次无开销），与卡片进度同源同步。
  const watchedCount = videos.filter(
    (video) => readPlaybackProgress(video.id).ratio >= WATCHED_RATIO,
  ).length;
  // 顶栏搜索框：按 / 全局聚焦（只在搜索框确实渲染时挂监听）。
  const librarySearchRef = useRef<HTMLInputElement>(null);
  const librarySearchVisible = Boolean(selectedCourseId && videos.length > 0);
  useEffect(() => {
    if (!librarySearchVisible) return;
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "/" || event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.isContentEditable)
      ) {
        return;
      }
      event.preventDefault();
      librarySearchRef.current?.focus();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [librarySearchVisible]);
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
  const selectedCourse = courses.find(
    (course) => course.id === selectedCourseId,
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
            setJob({
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
    [setJob],
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
        queryKey: qk.videos.list(selectedCourseId),
      });
    },
  });

  function changeView(next: LibraryView) {
    setView(next);
    window.localStorage.setItem(VIEW_STORAGE_KEY, next);
  }

  // 网格密度：舒适 ↔ 紧凑，只影响网格列宽。
  function toggleGridDensity() {
    setGridDensity((current) => {
      const next = current === "cozy" ? "compact" : "cozy";
      window.localStorage.setItem(GRID_DENSITY_KEY, next);
      return next;
    });
  }

  function openVideo(videoId: string) {
    runAfterWorkspaceTransient(() => {
      // 记录「该课程最近打开的视频」，回到课程库时给「继续上次」横幅。
      // 用视频自己的 course_id（队列打开跨课程视频时 selectedCourseId 还是旧值）。
      const target =
        videos.find((video) => video.id === videoId) ??
        queuedVideos.find((video) => video.id === videoId);
      if (target) writeLastVideoId(target.course_id, videoId);
      // 打开视频即回到工作台：合上可能叠在主区的设置/回收站/控制台/队列整页。
      go({ view: "library", videoId });
    });
  }

  // 复习卡「回看出处」：关掉仪表盘、切到卡所属课程，跨视频跳转由 pendingSeek 驱动。
  function reviewJump(card: DueCard) {
    runAfterWorkspaceTransient(() => {
      setKnowledgeReturn(null);
      go(card.course_id ? { view: "library", courseId: card.course_id } : { view: "library" });
      if (card.video_id && card.source_ms != null) {
        usePlayer.getState().requestOpenAt(card.video_id, card.source_ms);
      }
    });
  }

  // 助手的导航动作。只有这里知道播放器和当前选中项，所以由 Home 执行。
  function assistantNavigate(action: AssistantAction) {
    const navigate = () => {
      setKnowledgeReturn(null);
      closeMainOverlays();
      dispatchAssistantNavigation(action, selectedVideoId, {
        selectCourse: (courseId) => go({ courseId }),
        openAt: usePlayer.getState().requestOpenAt,
        seek: usePlayer.getState().requestSeek,
        clearPendingOpen: usePlayer.getState().clearPendingSeek,
      });
    };
    if (action.kind === "open_video" && action.video_id !== selectedVideoId) {
      runAfterWorkspaceTransient(navigate);
    } else {
      // 当前视频内 seek 不会卸载编辑器，可安全执行；仍保留设置页的未保存退出保护。
      runAfterSettingsExit(navigate);
    }
  }

  function assistantActionApplied(action: AssistantAction) {
    reconcileAssistantAction(action, selectedVideoId, {
      removeQueuedVideo: (videoId) =>
        setQueuedVideos((items) => items.filter((item) => item.id !== videoId)),
      clearCurrentVideo: () => go({ videoId: null }),
      clearPendingOpen: (videoId) => {
        const player = usePlayer.getState();
        if (player.pendingSeek?.videoId === videoId) player.clearPendingSeek();
      },
    });
  }

  // 仪表盘「继续学习」：切到该课程，打开上次的视频并跳到上次进度（秒→毫秒）。
  function resumeStudy(courseId: string, videoId: string, positionSec: number) {
    runAfterWorkspaceTransient(() => {
      setKnowledgeReturn(null);
      go({ view: "library", courseId });
      usePlayer.getState().requestOpenAt(videoId, Math.round(positionSec * 1000));
    });
  }

  // 「知识点」出处点击：关面板、跳到该视频对应位置（同课程，pendingSeek 驱动开视频+seek）。
  function conceptJump(
    videoId: string,
    startMs: number,
    navigationState?: ConceptNavigationState,
  ) {
    if (selectedCourseId && navigationState) {
      setKnowledgeReturn({ courseId: selectedCourseId, navigationState });
    } else {
      setKnowledgeReturn(null);
    }
    go({ view: "library" });
    usePlayer.getState().requestOpenAt(videoId, startMs);
  }

  const performReturnToKnowledge = useCallback(() => {
    if (!knowledgeReturn) return;
    usePlayer.getState().clearPendingSeek();
    go({ view: "concepts", courseId: knowledgeReturn.courseId, videoId: null });
  }, [go, knowledgeReturn]);

  const returnToKnowledge = useCallback(() => {
    runAfterWorkspaceTransient(performReturnToKnowledge);
  }, [performReturnToKnowledge, runAfterWorkspaceTransient]);

  const returnFromVideo = useCallback(() => {
    runAfterWorkspaceTransient(() => {
      if (knowledgeReturn) {
        performReturnToKnowledge();
      } else {
        returnToLibrary();
      }
    });
  }, [
    knowledgeReturn,
    performReturnToKnowledge,
    returnToLibrary,
    runAfterWorkspaceTransient,
  ]);

  const selectedVideo =
    videos.find((video) => video.id === selectedVideoId) ??
    queuedVideos.find((video) => video.id === selectedVideoId);

  // asset 协议在 macOS WKWebView 下放大文件会「有画面没声音」；改用本地 HTTP
  // 媒体服务（带 Range）提供视频，拿到 http://127.0.0.1 的 URL 再播。
  const {
    data: mediaSrc,
    isError: mediaSrcError,
    error: mediaSrcErrorObj,
    refetch: refetchMediaSrc,
  } = useQuery({
    queryKey: qk.mediaUrl.video(selectedVideo?.id),
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
  // 助手要知道「播到哪儿了」，「跳到刚才那句」这类话才落得下去。
  const playerMs = usePlayer((s) => s.currentMs);
  const assistantContext = buildAssistantContext(selectedCourseId, selectedVideo, playerMs);
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

  const restoreFocus = useCallback((target: HTMLElement | null) => {
    queueMicrotask(() => {
      if (target?.isConnected) target.focus();
    });
  }, []);

  const closeVideoMenuAndRestoreFocus = useCallback(() => {
    const trigger = videoMenuTriggerRef.current;
    setOpenMenuVideoId(null);
    restoreFocus(trigger);
  }, [restoreFocus]);

  const cancelVideoRename = useCallback(() => {
    const trigger = renameOriginTriggerRef.current;
    setRenamingVideo(null);
    restoreFocus(trigger);
  }, [restoreFocus]);

  const dismissVisibleTransient = useCallback(
    (continuation?: () => void): boolean => {
      const visibleMenus = Array.from(
        document.querySelectorAll<HTMLElement>('[role="menu"]:not([hidden])'),
      ).filter(
        (menu) =>
          !menu.closest('[hidden], [aria-hidden="true"], [data-state="inactive"]'),
      );
      const dispatchEscape = (target: HTMLElement | Document) => {
        const escape = new KeyboardEvent("keydown", {
          key: "Escape",
          code: "Escape",
          bubbles: true,
          cancelable: true,
        });
        target.dispatchEvent(escape);
        return escape.defaultPrevented;
      };

      const visibleTransientLayers = Array.from(
        document.querySelectorAll<HTMLElement>(
          '[data-system-back-layer]:not([hidden])',
        ),
      ).filter(
        (layer) =>
          !layer.closest('[hidden], [aria-hidden="true"], [data-state="inactive"]'),
      );

      // 子组件自己的全屏模态（复习、移动助手、未保存确认、导入任务）比 Home
      // 的页面层级更靠上。把 Android 返回等价成 Esc，让模态自行决定关闭或拦截。
      const visibleModals = Array.from(
        document.querySelectorAll<HTMLElement>(
          '[role="dialog"][aria-modal="true"]:not([hidden])',
        ),
      ).filter(
        (modal) =>
          !modal.closest('[hidden], [aria-hidden="true"], [data-state="inactive"]'),
      );
      const modal = visibleModals[visibleModals.length - 1];

      const continueAfterDismissal = (target?: HTMLElement | null) => {
        if (
          !continuation ||
          target?.hasAttribute("data-system-back-pending") ||
          target?.hasAttribute("data-system-back-dirty")
        ) {
          return;
        }
        queueMicrotask(() => {
          const stillVisible =
            target?.isConnected &&
            !target.closest('[hidden], [aria-hidden="true"], [data-state="inactive"]');
          if (stillVisible) return;
          // 显式导航可能叠着多层（例如移动助手盖在文稿编辑器上）：逐层关闭，
          // 直到没有可见临时态才执行原导航；dirty / pending 层会在上面直接截断。
          if (dismissVisibleTransientRef.current?.(continuation)) return;
          continuation();
        });
      };

      // 全屏播放器在模态助手之上；先关其内部菜单，再退出全屏。
      if (videoFullscreen) {
        const fullscreenLayer =
          document.querySelector<HTMLElement>("[data-video-fullscreen]");
        const fullscreenMenu = [...visibleMenus]
          .reverse()
          .find((menu) => fullscreenLayer?.contains(menu));
        if (fullscreenMenu && dispatchEscape(fullscreenMenu)) {
          continueAfterDismissal(fullscreenMenu);
          return true;
        }
        const fullscreenTransient = [...visibleTransientLayers]
          .reverse()
          .find((layer) => fullscreenLayer?.contains(layer));
        if (fullscreenTransient && dispatchEscape(fullscreenTransient)) {
          continueAfterDismissal(fullscreenTransient);
          return true;
        }
        dispatchEscape(document);
        continueAfterDismissal(fullscreenLayer);
        return true;
      }

      // 模态内的菜单/临时层比模态本身更靠上；页面背后的临时层不能抢先消费返回。
      if (modal) {
        const modalMenu = [...visibleMenus]
          .reverse()
          .find((menu) => modal.contains(menu));
        if (modalMenu && dispatchEscape(modalMenu)) {
          continueAfterDismissal(modalMenu);
          return true;
        }
        const modalTransient = [...visibleTransientLayers]
          .reverse()
          .find((layer) => modal.contains(layer));
        if (modalTransient && dispatchEscape(modalTransient)) {
          continueAfterDismissal(modalTransient);
          return true;
        }
        dispatchEscape(modal);
        continueAfterDismissal(modal);
        return true;
      }

      if (transientCloseRef.current) {
        transientCloseRef.current();
        continueAfterDismissal();
        return true;
      }

      if (openMenuVideoId) {
        closeVideoMenuAndRestoreFocus();
        continueAfterDismissal(visibleMenus[visibleMenus.length - 1]);
        return true;
      }
      if (renamingVideo) {
        cancelVideoRename();
        continueAfterDismissal(renameDialogRef.current);
        return true;
      }

      // 导入、导出和倍速等页面菜单由子组件管理。Android 返回等价成 Escape。
      const menu = visibleMenus[visibleMenus.length - 1];
      if (menu && dispatchEscape(menu)) {
        continueAfterDismissal(menu);
        return true;
      }

      const transientLayer = visibleTransientLayers[visibleTransientLayers.length - 1];
      if (transientLayer && dispatchEscape(transientLayer)) {
        continueAfterDismissal(transientLayer);
        return true;
      }

      return false;
    },
    [
      openMenuVideoId,
      renamingVideo,
      cancelVideoRename,
      closeVideoMenuAndRestoreFocus,
      videoFullscreen,
    ],
  );
  dismissVisibleTransientRef.current = dismissVisibleTransient;

  const goBackOneLevel = useCallback((): boolean => {
    const now = Date.now();
    if (now - androidBackGuard.current < 250) return true;
    androidBackGuard.current = now;

    if (dismissVisibleTransient()) return true;

    if (showConcepts) {
      go({ view: "library" });
      setKnowledgeReturn(null);
      return true;
    }
    if (showSettings) {
      if (settingsBackRequestRef.current) settingsBackRequestRef.current();
      else runAfterSettingsExit(() => go({ view: "library" }));
      return true;
    }
    if (showDevConsole) {
      // 控制台从设置的「开发者」分类进入，返回也回到那里。
      go({ view: "settings", settingsCategory: "dev" });
      return true;
    }
    if (showRecycleBin || showDashboard) {
      go({ view: "library" });
      return true;
    }
    if (queueOpen) {
      go({ view: "library", videoId: null });
      return true;
    }
    if (selectedVideoId) {
      returnFromVideo();
      return true;
    }
    // 窄屏「课程」Tab:选了课程→退回课程列表；已在列表根层则由调用方结束 Activity。
    if (selectedCourseId) {
      go({ courseId: null });
      return true;
    }
    return false;
  }, [
    go,
    queueOpen,
    selectedCourseId,
    selectedVideoId,
    showDevConsole,
    showRecycleBin,
    showSettings,
    showDashboard,
    showConcepts,
    runAfterSettingsExit,
    returnFromVideo,
    dismissVisibleTransient,
  ]);

  useEffect(() => {
    if (!isAndroidPlatform) return;

    let cancelled = false;
    let closeListener: (() => void) | null = null;
    let backListener: { unregister: () => Promise<void> } | null = null;

    void (async () => {
      closeListener = await getCurrentWindow().onCloseRequested((event) => {
        event.preventDefault();
        if (!goBackOneLevel()) void ipc.app.exit();
      });
      backListener = await onBackButtonPress(() => {
        if (!goBackOneLevel()) void ipc.app.exit();
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
    mutationFn: (videoId: string) => ipc.pipeline.dismiss(videoId),
    onSuccess: (_data, videoId) => {
      setQueuedVideos((items) => items.filter((item) => item.id !== videoId));
      queryClient.setQueryData<Video[]>(["processing-videos"], (items) =>
        items?.filter((item) => item.id !== videoId),
      );
      resetJobs(videoId);
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

  // 已有字幕时「仅重新纠错」：不重新识别，回到原始稿后重跑 AI 纠错，完成后刷新文稿。
  const recorrect = useMutation({
    mutationFn: (target: { videoId: string; courseId: string }) =>
      ipc.pipeline.recorrect(target.videoId),
    onSuccess: (_d, target) => {
      queryClient.invalidateQueries({ queryKey: qk.transcripts(target.videoId) });
      // 纠错重写了整份文稿：各 AI 产物据此重新判断是否已过期。
      invalidateStaleArtifacts(queryClient, target.videoId);
    },
  });
  const resetRecorrect = recorrect.reset;
  const recorrectPendingRef = useRef(recorrect.isPending);
  const resetRecorrectWhenSettled = useRef(false);
  recorrectPendingRef.current = recorrect.isPending;
  useEffect(() => {
    // reset 只清 observer，不会取消已经发出的付费请求。进行中切课程/视频时先隐藏
    // 当前作用域，等请求真正收口再清；否则 hook 会提前回 idle，菜单能够重复发同一请求。
    if (recorrectPendingRef.current) {
      resetRecorrectWhenSettled.current = true;
    } else {
      resetRecorrect();
    }
  }, [resetRecorrect, selectedCourseId, selectedVideoId]);
  useEffect(() => {
    if (recorrect.isPending || !resetRecorrectWhenSettled.current) return;
    resetRecorrectWhenSettled.current = false;
    // 请求期间可能切走又回到原课程。此时结果仍属于眼前作用域，失败反馈要留下；
    // 只有收口时仍在其他课程/视频里，才清掉已经不可见的 mutation 状态。
    const backInTargetLibrary =
      !selectedVideoId && recorrect.variables?.courseId === selectedCourseId;
    if (!backInTargetLibrary) resetRecorrect();
  }, [
    recorrect.isPending,
    recorrect.variables,
    resetRecorrect,
    selectedCourseId,
    selectedVideoId,
  ]);
  // 纠错失败原来没有任何地方接：菜单点完就收起，既没有报错也没有变化，看起来就像没点上——
  // 而没配大模型、批次全失败、快照对不上都会走到这里。
  const recorrectTarget =
    recorrect.isError &&
    recorrect.variables &&
    videos.some(
      (video) =>
        video.id === recorrect.variables?.videoId &&
        video.course_id === recorrect.variables?.courseId &&
        video.course_id === selectedCourseId,
    )
      ? recorrect.variables
      : null;
  const recorrectError = recorrectTarget ? recorrect.error : null;

  async function requestRecorrection(video: VideoListItem) {
    const confirmed = await confirmDialog(t("home.reCorrectConfirm"), {
      title: t("home.reCorrectConfirmTitle"),
      kind: "warning",
      okLabel: t("home.reCorrectConfirmAction"),
      cancelLabel: t("common.cancel"),
    });
    if (!confirmed) return;
    recorrect.mutate({ videoId: video.id, courseId: video.course_id });
  }

  async function saveRenamedVideo() {
    if (!renamingVideo) return;
    const videoId = renamingVideo.id;
    const originTrigger = renameOriginTriggerRef.current;
    const title = renamingVideo.title.trim();
    if (!title) return;
    const current = videos.find((video) => video.id === videoId);
    if (current && current.title === title) {
      const shouldRestoreFocus = renameDialogRef.current?.contains(document.activeElement) ?? false;
      setRenamingVideo(null);
      if (shouldRestoreFocus) restoreFocus(originTrigger);
      return;
    }
    await ipc.videos.updateTitle(videoId, title);
    const shouldRestoreFocus = renameDialogRef.current?.contains(document.activeElement) ?? false;
    setRenamingVideo(null);
    if (shouldRestoreFocus) restoreFocus(originTrigger);
    await queryClient.invalidateQueries({ queryKey: qk.videos.list(selectedCourseId) });
  }

  async function deleteVideo(videoId: string) {
    const ok = await confirmDialog(
      t("home.deleteConfirm"),
      { title: t("home.deleteTitle"), kind: "warning", okLabel: t("home.deleteLabel"), cancelLabel: t("home.cancel") },
    );
    if (!ok) return;
    await ipc.videos.delete(videoId);
    setQueuedVideos((items) => items.filter((item) => item.id !== videoId));
    if (selectedVideoId === videoId) go({ videoId: null });
    await queryClient.invalidateQueries({ queryKey: qk.videos.list(selectedCourseId) });
    await queryClient.invalidateQueries({ queryKey: qk.trash() });
  }

  // 设置 / 回收站作为主区域整页，与处理队列一致；互斥切换。保留当前选中的视频，
  // 这样从控制台打开设置、点「返回」能回到原来的视频工作台，而不是退回首页。
  // 收起主区所有整页浮层（设置/回收站/控制台/队列）。新增浮层态时只改这一处，
  // 避免在各处手写「四个 setXxx(false)」漏改而出现两页同显。
  function closeMainOverlays() {
    go({ view: "library" });
  }

  function openMainView(view: "settings" | "recycle" | "dev" | "dashboard") {
    runAfterWorkspaceTransient(() => go({ view }));
  }

  /** 语音识别没有真进度可报的那一段（0.12–0.9），按时间往前爬一点，免得看着像死了。
   *  纠错阶段（0.9 起）有逐批的真进度，不需要也不应该被估计值盖住。 */
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
    return currentStage(jobsByVideo[videoId] ?? {}) as JobUpdate | undefined;
  }

  /** 整条流水线的完成度：识别做完只是开头，后面还有课件与五个 AI 步骤。
   *  当前阶段自身的估计进度并进整体，好让识别那段也在动。 */
  function pipelineProgressFor(videoId: string) {
    const byStage = jobsByVideo[videoId] ?? {};
    const active = activeJobFor(videoId);
    if (!active || active.status !== "running") return overallProgress(byStage);
    const patched = {
      ...byStage,
      [active.stage]: { ...active, progress: displayProgress(active) },
    };
    return overallProgress(patched);
  }

  function openQueuedVideo(video: Video) {
    go({ view: "library", courseId: video.course_id });
    openVideo(video.id);
  }

  function selectCourse(id: string) {
    runAfterWorkspaceTransient(() => {
      setKnowledgeReturn(null);
      go({ view: "library", courseId: id, videoId: null });
      setVideoQuery("");
    });
  }

  function clearCourseSelection() {
    runAfterWorkspaceTransient(() => {
      setKnowledgeReturn(null);
      go({ view: "library", courseId: null, videoId: null });
      setVideoQuery("");
    });
  }

  // rail logo（library 态）回课程库首页：与「清除课程选择」同义，直接复用 clearCourseSelection。

  function toggleQueue() {
    // 用当前渲染的 queueOpen 求反，保留「再点收起」的切换语义。
    const willOpen = !queueOpen;
    runAfterWorkspaceTransient(() => {
      if (willOpen) setKnowledgeReturn(null);
      go({ view: willOpen ? "queue" : "library", videoId: null });
    });
  }

  // 窄屏底部 Tab 切换：课程回到当前课程层级；学习/队列/设置打开对应整页。
  function selectCompactTab(tab: CompactTab) {
    if (tab === "settings" && showSettings) return;
    runAfterWorkspaceTransient(() => {
      go({
        view:
          tab === "study"
            ? "dashboard"
            : tab === "queue"
              ? "queue"
              : tab === "settings"
                ? "settings"
                : "library",
      });
    });
  }

  function renderProcessingQueuePage() {
    const items = queuedVideos.map((video) => {
      const active = activeJobFor(video.id);
      const jobLoadState = jobLoadStateByVideo[video.id];
      const jobLoadError = jobLoadState?.status === "error" ? jobLoadState.error : null;
      const message = jobLoadError
        ? t("home.queueJobsLoadError")
        : jobLoadState?.status === "loading" && !active
          ? t("home.queueJobsLoading")
          : stageMessage(active, t);
      return {
        video,
        percent: Math.floor(pipelineProgressFor(video.id) * 100),
        message,
        failed: active?.status === "failed",
        canCancel: active?.status === "running" || active?.status === "pending",
        jobLoadError,
        jobLoadLoading: jobLoadState?.status === "loading",
        dismissError: dismissProcessing.error,
        dismissPending: dismissProcessing.isPending && dismissProcessing.variables === video.id,
      };
    });
    return (
      <ProcessingQueuePanel
        items={items}
        loading={activeProcessingLoading}
        error={activeProcessingError}
        errorObj={activeProcessingErrorObj}
        onRetryLoad={() => void retryActiveProcessing()}
        onBack={goBackOneLevel}
        onOpenVideo={openQueuedVideo}
        onRetryProcessing={startProcessing}
        onRemoveVideo={removeQueuedVideo}
        onRetryJobs={retryJobsForVideo}
        onCancelVideo={(id) => void ipc.pipeline.cancel(id)}
        onCancelAll={cancelAllProcessing}
        onRetryAll={retryFailedAll}
        dismiss={{
          isError: dismissProcessing.isError,
          isPending: dismissProcessing.isPending,
          variables: dismissProcessing.variables,
          error: dismissProcessing.error,
          mutate: dismissProcessing.mutate,
        }}
      />
    );
  }


  // 视频卡片上的「⋯」操作按钮（网格/列表共用）。
  function videoOptionsButton(video: Video) {
    return (
      <IconButton
        ref={(node) => {
          if (openMenuVideoId === video.id && node) videoMenuTriggerRef.current = node;
        }}
        type="button"
        aria-label={t("home.videoActions")}
        aria-haspopup="menu"
        aria-expanded={openMenuVideoId === video.id}
        data-video-menu
        className="ca-touch-44 absolute right-3 top-3 h-7 w-7 rounded-full bg-[var(--surface-panel)] shadow-[var(--shadow-raise)]"
        onClick={(event) => {
          videoMenuTriggerRef.current = event.currentTarget;
          setOpenMenuVideoId((id) => (id === video.id ? null : video.id));
        }}
      >
        <MoreHorizontal className="h-3.5 w-3.5" />
      </IconButton>
    );
  }

  // 菜单要按「有没有文稿」在「重新纠错」和「开始处理」之间选，所以收的是列表条目而不是裸 Video。
  function videoMenu(video: VideoListItem) {
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
        aria-label={t("home.videoActionsMenu")}
        data-video-menu
        className="absolute right-3 top-12 z-10 w-32"
        onClose={() => setOpenMenuVideoId(null)}
        triggerRef={videoMenuTriggerRef}
      >
        <MenuItem
          className="ca-touch-44"
          onClick={() => {
            renameOriginTriggerRef.current = videoMenuTriggerRef.current;
            setOpenMenuVideoId(null);
            setRenamingVideo({ id: video.id, title: displayTitle(video.title) });
          }}
        >
          {t("home.editTitle")}
        </MenuItem>
        {/* 过滤态下移动的是全量列表位置、界面上看不出效果，藏掉避免困惑。 */}
        {!normalizedQuery && index > 0 && (
          <MenuItem className="ca-touch-44" onClick={() => moveTo(index - 1)}>
            {t("home.moveUp")}
          </MenuItem>
        )}
        {!normalizedQuery && index !== -1 && index < videos.length - 1 && (
          <MenuItem className="ca-touch-44" onClick={() => moveTo(index + 1)}>
            {t("home.moveDown")}
          </MenuItem>
        )}
        <MenuItem
          className="ca-touch-44"
          disabled={canRecorrect(video) && recorrect.isPending}
          onClick={() => {
            setOpenMenuVideoId(null);
            if (canRecorrect(video)) {
              if (recorrect.isPending) return;
              void requestRecorrection(video);
            } else {
              startProcessing(video);
            }
          }}
        >
          {canRecorrect(video)
            ? recorrect.isPending && recorrect.variables?.videoId === video.id
              ? t("home.correcting")
              : t("home.reCorrect")
            : t("home.startProcessing")}
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
          {t("home.delete")}
        </MenuItem>
      </Menu>
    );
  }

  function videoRenameBox(video: Video) {
    if (renamingVideo?.id !== video.id) return null;
    return (
      <div
        ref={renameDialogRef}
        role="dialog"
        aria-label={t("home.editTitle")}
        className="absolute inset-x-3 top-12 z-20 rounded-md border border-[var(--border-subtle)] bg-[var(--surface-panel)] p-2 shadow-[var(--shadow-pop)]"
      >
        <label className="sr-only" htmlFor={`rename-${video.id}`}>
          {t("home.videoTitle")}
        </label>
        <input
          id={`rename-${video.id}`}
          aria-label={t("home.videoTitle")}
          autoFocus
          onFocus={(event) => event.currentTarget.select()}
          className="min-h-11 w-full rounded border border-[var(--border-subtle)] bg-[var(--surface-input)] px-2 py-1.5 text-xs text-[var(--text-strong)] outline-none"
          value={renamingVideo.title}
          onChange={(event) =>
            setRenamingVideo({ id: video.id, title: event.target.value })
          }
          onKeyDown={(event) => {
            if (event.key === "Enter") void saveRenamedVideo();
            if (event.key === "Escape") {
              event.preventDefault();
              event.stopPropagation();
              cancelVideoRename();
            }
          }}
        />
        <div className="mt-2 flex justify-end gap-1">
          <button
            type="button"
            aria-label={t("home.cancelEdit")}
            className="ca-touch-44 flex h-7 w-7 items-center justify-center rounded text-[var(--text-muted)] hover:bg-[var(--surface-card-hover)]"
            onClick={cancelVideoRename}
          >
            <X className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            aria-label={t("home.saveTitle")}
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
        {t(statusLabelKey[status])}
      </Badge>
    );
  }

  function renderVideoGridCard(video: VideoListItem) {
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
          aria-label={t("home.openVideo", { title: displayTitle(video.title) })}
          onClick={() => openVideo(video.id)}
        >
          <span className="ca-thumb">
            <VideoCover
              videoId={video.id}
              className="absolute inset-0 h-full w-full"
            />
            {/* 悬停快捷播放：整卡本就是一个可点按钮，这里只做视觉 affordance（装饰，不嵌套真按钮）。 */}
            <span
              aria-hidden="true"
              className="ca-card-play pointer-events-none absolute inset-0 z-10 grid place-items-center"
            >
              <span className="flex h-12 w-12 items-center justify-center rounded-full bg-black/55 text-white ring-1 ring-white/25 backdrop-blur-sm">
                <Play className="h-6 w-6 fill-current" />
              </span>
            </span>
            <span className="st">{statusBadge(video)}</span>
            {/* 时长未知就不显示角标：假的「00:00」会让人以为视频是空的。 */}
            {durationMs != null && (
              <span className="dur">{formatMs(durationMs)}</span>
            )}
            {progress.ratio >= WATCHED_RATIO && (
              <span className="done">
                <Check className="h-3 w-3" />
                {t("home.watched")}
              </span>
            )}
            {progress.ratio > 0 && progress.ratio < WATCHED_RATIO && (
              <span
                className="ov-bar"
                aria-label={t("home.watchedPercent", { percent: Math.round(progress.ratio * 100) })}
              >
                <i style={{ width: `${progress.ratio * 100}%` }} />
              </span>
            )}
          </span>
          <span className="ca-card-body">
            <span className="ca-card-title">
              {displayTitle(video.title)}
            </span>
            {renderVideoMetaLine(video, progress, durationMs)}
          </span>
        </button>
        {videoOptionsButton(video)}
        {videoMenu(video)}
        {videoRenameBox(video)}
      </article>
    );
  }

  /** 卡片 body 的学习信息行：时长 · 进度 / ✓ 已看完 / 处理中实时进度 / 失败提示。
   *  时长未知只显示状态部分，不编假时长。 */
  function renderVideoMetaLine(
    video: VideoListItem,
    progress: ReturnType<typeof readPlaybackProgress>,
    durationMs: number | null,
  ) {
    const durationText = durationMs != null ? formatMs(durationMs) : null;
    const jobs = jobsByVideo[video.id] ?? {};
    const hasJobs = Object.keys(jobs).length > 0;
    // 处理中：jobs 数据到了才接管 meta 行；没到退回静态「处理中」徽标，不显示空进度条。
    if (video.processed_status === "processing" && hasJobs) {
      const stage = activeJobFor(video.id);
      return (
        <span className="ca-card-meta">
          <span className="ca-meta-progress" aria-hidden="true">
            <i style={{ width: `${Math.round(pipelineProgressFor(video.id) * 100)}%` }} />
          </span>
          <span className="ca-meta-text accent truncate">
            <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />
            {stageMessage(stage, t)}
          </span>
        </span>
      );
    }
    if (video.processed_status === "failed") {
      return (
        <span className="ca-card-meta">
          <span className="ca-meta-text err truncate">{t("home.processingFailedMeta")}</span>
        </span>
      );
    }
    if (progress.ratio >= WATCHED_RATIO) {
      return (
        <span className="ca-card-meta">
          {durationText != null && <span className="ca-meta-text">{durationText} · </span>}
          {/* 整串带 ✓，避免与封面「已看完」徽标在文本查询上撞车。 */}
          <span className="ca-meta-text ok">{`✓ ${t("home.watched")}`}</span>
        </span>
      );
    }
    if (progress.ratio > 0) {
      const percent = Math.round(progress.ratio * 100);
      return (
        <span className="ca-card-meta">
          {durationText != null && <span className="ca-meta-text">{durationText} · </span>}
          <span className="ca-meta-text accent">
            {t("home.watchedPercentShort", { percent })}
          </span>
        </span>
      );
    }
    return durationText != null ? (
      <span className="ca-card-meta">
        <span className="ca-meta-text">{durationText}</span>
      </span>
    ) : null;
  }

  function renderVideoListRow(video: VideoListItem) {
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
          aria-label={t("home.openVideo", { title: displayTitle(video.title) })}
          onClick={() => openVideo(video.id)}
        >
          <span className="row-main">
            <span className="row-thumb">
              <VideoCover
                videoId={video.id}
                className="absolute inset-0 h-full w-full"
              />
              {progress.ratio >= WATCHED_RATIO && (
                <span className="done" role="img" aria-label={t("home.watched")}>
                  <Check className="h-3 w-3" />
                </span>
              )}
              {progress.ratio > 0 && progress.ratio < WATCHED_RATIO && (
                <span
                  className="ov-bar"
                  aria-label={t("home.watchedPercent", { percent: Math.round(progress.ratio * 100) })}
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
          {renderListProgressCell(video, progress)}
          <span className="c-dur">{durationText}</span>
        </button>
        {videoOptionsButton(video)}
        {videoMenu(video)}
        {videoRenameBox(video)}
      </article>
    );
  }

  /** 列表「进度」列：处理中/失败由文字承担（状态徽标不再单列），看完/已看/未看三态文字。 */
  function renderListProgressCell(
    video: VideoListItem,
    progress: ReturnType<typeof readPlaybackProgress>,
  ) {
    const jobs = jobsByVideo[video.id] ?? {};
    const hasJobs = Object.keys(jobs).length > 0;
    if (video.processed_status === "processing" && hasJobs) {
      return (
        <span className="c-progress processing">
          <Loader2 className="h-3 w-3 flex-none animate-spin" aria-hidden="true" />
          <span className="min-w-0 truncate">{stageMessage(activeJobFor(video.id), t)}</span>
          <span className="accent flex-none">{Math.round(pipelineProgressFor(video.id) * 100)}%</span>
        </span>
      );
    }
    if (video.processed_status === "failed") {
      return <span className="c-progress err">{t("home.processingFailedMeta")}</span>;
    }
    if (progress.ratio >= WATCHED_RATIO) {
      return <span className="c-progress ok">{`✓ ${t("home.watched")}`}</span>;
    }
    if (progress.ratio > 0) {
      return (
        <span className="c-progress accent">
          {t("home.watchedPercentShort", { percent: Math.round(progress.ratio * 100) })}
        </span>
      );
    }
    return <span className="c-progress">{t("home.notWatched")}</span>;
  }

  // 「继续学习」hero 卡：该课程最近打开、且看了但没看完的视频，一键回到工作台
  // （播放器自带断点续播）。搜索过滤时不显示（那会儿用户在找别的）。
  function renderContinueBanner() {
    if (!selectedCourseId || normalizedQuery) return null;
    const lastId = readLastVideoId(selectedCourseId);
    if (!lastId) return null;
    const lastVideo = videos.find((video) => video.id === lastId);
    if (!lastVideo) return null;
    const progress = readPlaybackProgress(lastId);
    if (progress.ratio <= 0 || progress.ratio >= WATCHED_RATIO) return null;
    const positionMs = Math.round(progress.positionSec * 1000);
    const percent = Math.round(progress.ratio * 100);
    return (
      <button
        type="button"
        className="ca-continue-hero group"
        aria-label={t("home.continueLearning", { title: displayTitle(lastVideo.title) })}
        onClick={() => openVideo(lastId)}
      >
        <span className="ca-continue-cover">
          <VideoCover
            videoId={lastVideo.id}
            className="absolute inset-0 h-full w-full"
          />
          <span className="ov-bar" aria-hidden="true">
            <i style={{ width: `${progress.ratio * 100}%` }} />
          </span>
        </span>
        <span className="min-w-0 flex-1 text-left">
          <span className="ca-continue-label">{t("home.continueLearningLabel")}</span>
          <span className="ca-continue-title truncate">{displayTitle(lastVideo.title)}</span>
          <span className="ca-continue-pos">
            {t("home.continueAt", { time: formatMs(positionMs) })}
            <span className="ca-continue-pct"> · {t("home.watchedPercentShort", { percent })}</span>
          </span>
        </span>
        <span className="ca-continue-play" aria-hidden="true">
          <Play className="h-5 w-5" />
        </span>
      </button>
    );
  }

  function renderCourseVideoLibrary() {
    // 视频列表还没回来时的骨架：顶栏照常（课程名来自 courses 查询，不闪），
    // 正文按当前视图档位铺占位卡。条件必须带 selectedCourseId——
    // enabled:false 时 isPending 恒为 true，不判课程 id 会让「未选课程」永远停在骨架。
    function renderLibrarySkeleton() {
      if (view === "list") {
        return (
          <div className="ca-list" role="status" aria-label={t("home.loadingVideos")}>
            <div className="ca-list-head">
              <span>{t("home.colName")}</span>
              <span className="h-progress">{t("home.colProgress")}</span>
              <span className="h-dur">{t("home.colDuration")}</span>
            </div>
            {Array.from({ length: 6 }).map((_, index) => (
              <div key={index} className="ca-row" aria-hidden="true">
                <div className="row-button pointer-events-none">
                  <span className="row-main">
                    <span className="row-thumb">
                      <Skeleton className="absolute inset-0 h-full w-full rounded-none" />
                    </span>
                    <span className="row-name">
                      <Skeleton className="h-3 w-full" />
                      <Skeleton className="h-3 w-2/3" />
                    </span>
                  </span>
                  <span className="c-progress">
                    <Skeleton className="h-3 w-16" />
                  </span>
                  <span className="c-dur">
                    <Skeleton className="h-3 w-10" />
                  </span>
                </div>
              </div>
            ))}
          </div>
        );
      }
      return (
        <div className="ca-grid" role="status" aria-label={t("home.loadingVideos")}>
          {Array.from({ length: 8 }).map((_, index) => (
            <div key={index} className="ca-card pointer-events-none" aria-hidden="true">
              <div className="ca-thumb">
                <Skeleton className="absolute inset-0 h-full w-full rounded-none" />
              </div>
              <div className="ca-card-body">
                <Skeleton className="h-3.5 w-full" />
                <Skeleton className="h-3.5 w-2/3" />
              </div>
            </div>
          ))}
        </div>
      );
    }

    return (
      <div className="ca-main-col">
        <header className="ca-topbar">
          <div className="tb-lead">
            {isPhoneDevice && (
              <button
                type="button"
                className="hamb"
                onClick={() => go({ courseId: null })}
                title={t("home.backToLibrary")}
                aria-label={t("home.backToLibrary")}
              >
                <ChevronLeft className="h-5 w-5" />
              </button>
            )}
            <div className="tb-titles">
              {/* h1 给课程名（用户关心「我在哪个课程」），数量降为副标题。 */}
              <h1>{selectedCourse ? selectedCourse.name : t("home.courseVideos")}</h1>
              <div className="sub">
                {selectedCourse ? (
                  <>
                    {t("home.videoCount", { count: videos.length })}
                    {watchedCount > 0 && (
                      <>
                        <span aria-hidden="true"> · </span>
                        <span>{t("home.watchedCount", { count: watchedCount })}</span>
                        <span className="ca-sub-progress" aria-hidden="true">
                          <i style={{ width: `${(watchedCount / videos.length) * 100}%` }} />
                        </span>
                      </>
                    )}
                  </>
                ) : (
                  t("home.selectCourseHint")
                )}
              </div>
            </div>
          </div>
          {selectedCourseId && (
            <div className="tb-actions">
              {videos.length > 0 && (
                <div className="relative">
                  <Search
                    className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[var(--text-faint)]"
                    aria-hidden="true"
                  />
                  <input
                    ref={librarySearchRef}
                    aria-label={t("home.searchVideos")}
                    placeholder={t("home.searchVideos")}
                    className="tb-search ca-touch-44 w-full rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-input)] py-2 pl-9 pr-9 text-sm text-[var(--text-strong)] placeholder:text-[var(--text-faint)] focus:border-[var(--focus-ring)] [&::-webkit-search-cancel-button]:appearance-none"
                    value={videoQuery}
                    onChange={(event) => setVideoQuery(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Escape") setVideoQuery("");
                    }}
                  />
                  {videoQuery !== "" && (
                    <button
                      type="button"
                      aria-label={t("home.clearSearch")}
                      title={t("home.clearSearch")}
                      onClick={() => setVideoQuery("")}
                      className="ca-touch-44 absolute right-1 top-1/2 grid h-8 w-8 -translate-y-1/2 place-items-center rounded-md text-[var(--text-faint)] transition hover:bg-[var(--surface-card-hover)] hover:text-[var(--text-strong)]"
                    >
                      <X className="h-4 w-4" />
                    </button>
                  )}
                </div>
              )}
              {videos.length > 0 && (
                <div className="ca-seg">
                  {(
                    [
                      ["grid", LayoutGrid, t("home.gridView")],
                      ["list", List, t("home.listView")],
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
                  {/* 网格密度：仅网格视图下有意义；图标随当前密度提示下一步切换。 */}
                  {view === "grid" && (
                    <button
                      aria-label={
                        gridDensity === "cozy"
                          ? t("home.switchToCompact")
                          : t("home.switchToCozy")
                      }
                      title={
                        gridDensity === "cozy"
                          ? t("home.switchToCompact")
                          : t("home.switchToCozy")
                      }
                      aria-pressed={gridDensity === "compact"}
                      onClick={toggleGridDensity}
                      className={gridDensity === "compact" ? "on" : ""}
                    >
                      <Shrink className="h-4 w-4" />
                    </button>
                  )}
                </div>
              )}
              {videos.length > 0 && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => go({ view: "concepts" })}
                  className="ca-touch-44"
                >
                  <Lightbulb className="h-4 w-4" />
                  {t("home.knowledgePoints")}
                </Button>
              )}
              <ImportVideoButton
                courseId={selectedCourseId}
                onStartProcessing={startProcessing}
              />
            </div>
          )}
        </header>
        <div className="ca-scroll">
          {recorrectError && (
            <ErrorNote
              error={recorrectError}
              onRetry={
                recorrectTarget
                  ? () => recorrect.mutate(recorrectTarget)
                  : undefined
              }
              className="mx-4 mt-3"
            />
          )}
          {!videosError && renderContinueBanner()}
          {selectedCourseId && videosPending ? (
            renderLibrarySkeleton()
          ) : selectedCourseId && videosError ? (
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
                title={selectedCourseId ? t("home.noVideos") : t("home.noCourses")}
                description={
                  selectedCourseId
                    ? t("home.noVideosHint")
                    : undefined
                }
                action={
                  selectedCourseId ? (
                    <ImportVideoButton
                      courseId={selectedCourseId}
                      onStartProcessing={startProcessing}
                    />
                  ) : (
                    <div className="flex flex-col items-center gap-2">
                      <Button
                        type="button"
                        disabled={creatingCourse}
                        onClick={() => void createCourse()}
                      >
                        {creatingCourse ? (
                          <Loader2 className="h-4 w-4 animate-spin" />
                        ) : (
                          <FolderPlus className="h-4 w-4" />
                        )}
                        {creatingCourse ? t("nav.addingCourse") : t("nav.addCourseFolder")}
                      </Button>
                      {createError && (
                        <ErrorNote className="max-w-sm" error={createError} />
                      )}
                    </div>
                  )
                }
              />
            </div>
          ) : visibleVideos.length === 0 ? (
            <div className="flex h-full min-h-[320px] items-center justify-center">
              <EmptyState
                icon={<Film className="h-7 w-7" />}
                title={t("home.noMatch")}
                description={t("home.noMatchDesc", { query: videoQuery.trim() })}
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
                  <span>{t("home.colName")}</span>
                  <span className="h-progress">{t("home.colProgress")}</span>
                  <span className="h-dur">{t("home.colDuration")}</span>
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
              <div className="ca-grid" data-density={gridDensity} aria-label={t("home.videoGrid")}>
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
      <WorkspaceLayout
        videoId={selectedVideo.id}
        shellWide={shellWide}
        availableWidth={workbenchAvailableWidth}
        panel={<TabsPanel videoId={selectedVideo.id} />}
        player={
          <section aria-label={t("home.workbench")} className="ca-player-col">
            {!isPhoneDevice && (
              <header className="ca-wb-head">
                <div className="wb-title-row">
                  {knowledgeReturn && (
                    <button
                      type="button"
                      onClick={returnToKnowledge}
                      aria-label={t("home.backToConcept", { name: knowledgeReturn.navigationState.conceptName })}
                      title={t("home.backToConcept", { name: knowledgeReturn.navigationState.conceptName })}
                      className="ca-touch-44 inline-flex max-w-[45%] flex-none items-center gap-1 text-sm font-medium text-primary transition hover:opacity-80"
                    >
                      <ChevronLeft className="h-4 w-4 flex-none" />
                      <span className="truncate">{t("home.backToConcepts", { name: knowledgeReturn.navigationState.conceptName })}</span>
                    </button>
                  )}
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
                  onClick={returnFromVideo}
                  title={knowledgeReturn ? t("home.backToConcept", { name: knowledgeReturn.navigationState.conceptName }) : t("nav.back")}
                  aria-label={knowledgeReturn ? t("home.backToConcept", { name: knowledgeReturn.navigationState.conceptName }) : t("nav.back")}
                >
                  <ChevronLeft className="h-5 w-5" />
                </button>
              )}
              <div className="ca-stage">
                {mediaSrcError ? (
                  <div className="flex h-full items-center justify-center bg-black p-4">
                    <ErrorNote
                      className="w-full max-w-md"
                      error={mediaSrcErrorObj}
                      onRetry={() => void refetchMediaSrc()}
                    />
                  </div>
                ) : mediaSrc ? (
                  <VideoPlayer
                    src={mediaSrc}
                    videoId={selectedVideo.id}
                    immersive={isIOS()}
                    onFullscreenChange={setVideoFullscreen}
                  />
                ) : (
                  <div className="flex h-full items-center justify-center bg-black text-sm text-white/40">
                    {t("home.preparing")}
                  </div>
                )}
              </div>
            </div>
          </section>
        }
      />
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
        onTransientCloseChange={registerTransientClose}
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
  // 底栏选中项由当前顶层视图派生，返回或由其它入口切页后不会保留旧高亮。
  const activeCompactTab: CompactTab = showSettings || showDevConsole
    ? "settings"
    : showDashboard
      ? "study"
      : queueOpen
        ? "queue"
        : "courses";
  // 窄屏「课程」Tab 根层(未选课程、未开队列/设置/回收/控制台)→ 整屏课程列表。
  const showCourseListScreen =
    isPhoneDevice &&
    activeCompactTab === "courses" &&
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
            : showConcepts && selectedCourseId
              ? "concepts"
              : showCourseListScreen
                ? "courselist"
                : "library";

  return (
    <div
      ref={appRef}
      data-theme={theme}
      data-bucket={bucket}
      data-device={tabletWide ? "tablet" : "phone-or-desktop"}
      data-shell={isPhoneDevice ? "stacked" : "sidebar"}
      data-view={isWorkbenchView || (!isPhoneDevice && inVideoSession) ? "workbench" : "library"}
      data-sidebar={isPhoneDevice ? undefined : sidebarIsCollapsed ? "collapsed" : "expanded"}
      style={accentVars(accent, theme, customAccent) as CSSProperties}
      className="ca-app"
    >
      {isPhoneDevice ? null : (
        <>
          <AppRail
            view={sidebarView}
            sidebarExpanded={!sidebarIsCollapsed}
            onExpandSidebar={() => toggleSidebarCollapsed()}
            queueOpen={queueOpen}
            queueCount={queuedVideos.length}
            onToggleQueue={toggleQueue}
            onOpenDashboard={() => openMainView("dashboard")}
            assistantActive={assistantOpen}
            onToggleAssistant={toggleAssistant}
            theme={theme}
            themeToggleLabel={themeToggleLabel}
            onToggleTheme={toggleTheme}
            onOpenRecycleBin={() => openMainView("recycle")}
            onOpenSettings={() => openMainView("settings")}
            onBackToLibrary={returnFromVideo}
            onGoLibraryHome={clearCourseSelection}
          />
          {!sidebarIsCollapsed && (
            <AppSidebar
              view={sidebarView}
              onToggleCollapsed={() => toggleSidebarCollapsed()}
              selectedCourseId={selectedCourseId}
              selectedCourseWatchedRatio={
                selectedCourseId && videos.length > 0
                  ? watchedCount / videos.length
                  : null
              }
              onSelectCourse={selectCourse}
              onClearCourseSelection={clearCourseSelection}
              videos={videos}
              selectedVideoId={selectedVideoId}
              onOpenVideo={openVideo}
              queueOpen={queueOpen}
            />
          )}
        </>
      )}
      <main className="ca-main">
        {/* key=视图类型(而非视频 id):切换顶层视图时重挂以重播入场动画;在工作台内
            切换视频时 key 不变,播放器与面板状态保留、不被打断。 */}
        <div key={mainViewKey} className="ca-view">
          {showSettings ? (
            <SettingsPanel
              category={isSettingsCategory(settingsCategory) ? settingsCategory : null}
              onCategoryChange={(category) => go({ settingsCategory: category })}
              onClose={() => go({ view: "library" })}
              onOpenDevConsole={() => openMainView("dev")}
              onRegisterExitRequest={registerSettingsExitRequest}
              onRegisterBackRequest={registerSettingsBackRequest}
            />
          ) : showRecycleBin ? (
            <RecycleBin onClose={() => go({ view: "library" })} />
          ) : showDashboard ? (
            <Dashboard
              onClose={() => go({ view: "library" })}
              onOpenCourse={selectCourse}
              onResume={resumeStudy}
              onJump={reviewJump}
            />
          ) : showDevConsole ? (
            <DevConsole
              onClose={() => go({ view: "settings", settingsCategory: "dev" })}
            />
          ) : queueOpen ? (
            renderProcessingQueuePage()
          ) : selectedVideo ? (
            renderSelectedVideoWorkspace()
          ) : showConcepts && selectedCourseId ? (
            <ConceptsPanel
              courseId={selectedCourseId}
              courseName={selectedCourse?.name}
              onClose={() => {
                go({ view: "library" });
                setKnowledgeReturn(null);
              }}
              onJump={conceptJump}
              initialNavigationState={
                knowledgeReturn?.courseId === selectedCourseId
                  ? knowledgeReturn.navigationState
                  : null
              }
            />
          ) : showCourseListScreen ? (
            renderCourseListScreen()
          ) : (
            renderCourseVideoLibrary()
          )}
        </div>
      </main>
      {showBottomTab && (
        <BottomTabBar
          active={activeCompactTab}
          queueCount={queuedVideos.length}
          onSelect={selectCompactTab}
        />
      )}
      <AssistantPanel
        context={assistantContext}
        onNavigate={assistantNavigate}
        onActionApplied={assistantActionApplied}
        compact={isPhoneDevice}
        bottomNavigationVisible={showBottomTab}
        launcherVisible={
          !showSettings && !showRecycleBin && !showDevConsole && !showDashboard
        }
      />
    </div>
  );
}
