import { useQuery } from "@tanstack/react-query";
import { queries } from "@/lib/queries";
import { qk } from "@/lib/queryKeys";
import { useTranslation } from "react-i18next";
import { ChevronLeft } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import { onBackButtonPress } from "@tauri-apps/api/app";
import { AppSidebar } from "@/features/shell/AppSidebar";
import { AppRail } from "@/features/shell/AppRail";
import { CourseSidebar } from "@/features/library/CourseSidebar";
import { RecycleBin } from "@/features/library/RecycleBin";
import { Dashboard } from "@/features/study/Dashboard";
import { ConceptsPanel, type ConceptNavigationState } from "@/features/knowledge/ConceptsPanel";
import { DevConsole } from "@/features/settings/DevConsole";
import { SettingsPanel } from "@/features/settings/SettingsPanel";
import { isSettingsCategory } from "@/features/settings/categories";
import { TabsPanel } from "@/features/workspace/TabsPanel";
import { WorkspaceLayout } from "@/features/workspace/WorkspaceLayout";
import { ProcessingQueueView } from "@/features/library/ProcessingQueueView";
import { useProcessingQueue } from "@/features/library/useProcessingQueue";
import { CourseLibraryView } from "@/features/library/CourseLibraryView";
import { useRecorrection } from "@/features/library/useRecorrection";
import { VideoPlayer } from "@/features/player";
import { BottomTabBar, type CompactTab } from "@/features/shell/BottomTabBar";
import { ErrorNote } from "@/ui/ErrorNote";
import {
  coarsePointer,
  useContainerPixelWidth,
  useContainerWidth,
  useIsPortrait,
} from "@/lib/useContainerWidth";
import { ipc, type DueCard } from "@/lib/ipc";
import type { AssistantAction, Video } from "@/lib/types";
import { buildAssistantContext, reconcileAssistantAction } from "@/lib/assistantHome";
import { displayTitle } from "@/lib/videoTitle";
import { WATCHED_RATIO, readPlaybackProgress, writeLastVideoId } from "@/lib/playback";
import { useStudyReminder } from "@/lib/useStudyReminder";
import { isIOS, isTablet } from "@/lib/platform";
import { usePlayer } from "@/stores/player";
import { AssistantPanel } from "@/features/assistant/AssistantPanel";
import { accentVars, useTheme } from "@/stores/theme";
import { useAssistantUi } from "@/stores/assistant";
import { useHomeRoute } from "@/app/homeRoute";
import { getCurrentWindow } from "@tauri-apps/api/window";

const SIDEBAR_COLLAPSED_KEY = "course-ai-sidebar-collapsed";

type SidebarCollapsed = { library: boolean; workbench: boolean };

type KnowledgeReturnState = {
  courseId: string;
  navigationState: ConceptNavigationState;
};


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
  // 库内标题过滤（前端过滤，不落存储；切课程时清空）。
  const [videoQuery, setVideoQuery] = useState("");
  // 统一侧栏折叠状态：分视图记忆（课程库 / 工作台）。
  const [sidebarCollapsed, setSidebarCollapsed] = useState<SidebarCollapsed>(readSidebarCollapsed);
  const queue = useProcessingQueue({ queueOpen, selectedCourseId });
  const { queuedVideos, forgetQueuedVideo } = queue;
  const setVideo = usePlayer((s) => s.setVideo);
  const appRef = useRef<HTMLDivElement>(null);
  const settingsExitRequestRef = useRef<
    ((continuation: () => void) => void) | null
  >(null);
  const settingsBackRequestRef = useRef<(() => void) | null>(null);
  const transientCloseRef = useRef<(() => HTMLElement | null | void) | null>(null);
  const dismissVisibleTransientRef = useRef<
    ((continuation?: () => void) => boolean) | null
  >(null);
  const registerTransientClose = useCallback((close: (() => HTMLElement | null | void) | null) => {
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

  const { data: videos = [] } = useQuery(queries.videos(selectedCourseId));
  const { data: courses = [] } = useQuery(queries.courses());
  const recorrection = useRecorrection({ selectedCourseId, selectedVideoId, videos });
  // 顶栏副标「已看完 N 个」：本地按播放进度聚合，零后端改动。
  // 不 memo：看完一集从工作台返回时 videos 引用不变（react-query 结构共享），
  // memo 会停在旧值，而卡片 ov-bar 是渲染期直读 localStorage 反而是新的——同屏打架。
  // 直接渲染期算（几十集的规模，localStorage 读几十次无开销），与卡片进度同源同步。
  const watchedCount = videos.filter(
    (video) => readPlaybackProgress(video.id).ratio >= WATCHED_RATIO,
  ).length;
  const selectedCourse = courses.find(
    (course) => course.id === selectedCourseId,
  );


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
      removeQueuedVideo: forgetQueuedVideo,
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
        const closed = transientCloseRef.current();
        continueAfterDismissal(closed ?? undefined);
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
            <ProcessingQueueView queue={queue} onBack={goBackOneLevel} onOpenVideo={openQueuedVideo} />
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
            <CourseLibraryView
              key={selectedCourseId ?? "none"}
              courseId={selectedCourseId}
              videoQuery={videoQuery}
              onVideoQueryChange={setVideoQuery}
              isPhoneDevice={isPhoneDevice}
              queue={queue}
              recorrection={recorrection}
              openVideo={openVideo}
              onBackToCourses={() => go({ courseId: null })}
              onOpenConcepts={() => go({ view: "concepts" })}
              onVideoDeleted={(videoId) => {
                forgetQueuedVideo(videoId);
                if (selectedVideoId === videoId) go({ videoId: null });
              }}
              onSelectCourse={selectCourse}
              onResume={resumeStudy}
              onTransientCloseChange={registerTransientClose}
            />
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
