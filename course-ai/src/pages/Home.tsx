import { useQuery } from "@tanstack/react-query";
import { queries } from "@/lib/queries";
import { useTranslation } from "react-i18next";
import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import { AppSidebar } from "@/features/shell/AppSidebar";
import { AppRail } from "@/features/shell/AppRail";
import type { ShellNav } from "@/features/shell/shellNav";
import type { ConceptNavigationState } from "@/features/knowledge/ConceptsPanel";
import { useProcessingQueue } from "@/features/library/useProcessingQueue";
import { useDownloadsSync } from "@/features/library/useDownloads";
import { useRecorrection } from "@/features/library/useRecorrection";
import { BottomTabBar, type CompactTab } from "@/features/shell/BottomTabBar";
import {
  coarsePointer,
  useContainerPixelWidth,
  useContainerWidth,
  useIsPortrait,
} from "@/lib/useContainerWidth";
import type { DueCard } from "@/lib/ipc";
import type { AssistantAction, Video } from "@/lib/types";
import {
  buildAssistantContext,
  dispatchAssistantNavigation,
  reconcileAssistantAction,
} from "@/lib/assistantHome";
import { WATCHED_RATIO, readPlaybackProgress, writeLastVideoId } from "@/lib/playback";
import { useStudyReminder } from "@/lib/useStudyReminder";
import { isTablet } from "@/lib/platform";
import { usePlayer } from "@/stores/player";
import { selectDownloadCount, useDownloads } from "@/stores/downloads";
import { AssistantPanel } from "@/features/assistant/AssistantPanel";
import { accentVars, useTheme } from "@/stores/theme";
import { useAssistantUi } from "@/stores/assistant";
import { useHomeRoute } from "@/app/homeRoute";
import { ShellContext, type KnowledgeReturnState, type Shell } from "@/app/shell";
import { MAIN_VIEW_COMPONENTS } from "@/app/mainViews";
import { useAndroidBack, useTransientDismissal } from "@/features/shell/systemBack";

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
  // 主区视图与课程/视频选择都由路由承载（见 app/homeRoute）；视图互斥由路径天然保证。
  const {
    view: mainView,
    courseId: selectedCourseId,
    videoId: selectedVideoId,
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
  // 强调色同时写到 <html>：经 Portal 挂到 body 的浮层（对话框、复习会话、菜单）不在
  // .ca-app 里，只写 .ca-app 的话浮层里的 --accent 是未定义。
  useEffect(() => {
    const root = document.documentElement;
    const vars = accentVars(accent, theme, customAccent);
    for (const [name, value] of Object.entries(vars)) root.style.setProperty(name, value);
    return () => {
      for (const name of Object.keys(vars)) root.style.removeProperty(name);
    };
  }, [accent, theme, customAccent]);
  // 助手只有浮动一种形态，盖在内容上方，不占主区宽度；rail 按钮就是开/关。
  const assistantOpen = useAssistantUi((s) => s.open);
  const toggleAssistant = useAssistantUi((s) => s.toggle);
  // 库内标题过滤（前端过滤，不落存储；切课程时清空）。
  const [videoQuery, setVideoQuery] = useState("");
  // 统一侧栏折叠状态：分视图记忆（课程库 / 工作台）。
  const [sidebarCollapsed, setSidebarCollapsed] = useState<SidebarCollapsed>(readSidebarCollapsed);
  const queue = useProcessingQueue({ selectedCourseId });
  const { queuedVideos, forgetQueuedVideo } = queue;
  useDownloadsSync();
  const downloadCount = useDownloads(selectDownloadCount);
  const setVideo = usePlayer((s) => s.setVideo);
  const appRef = useRef<HTMLDivElement>(null);
  const settingsExitRequestRef = useRef<
    ((continuation: () => void) => void) | null
  >(null);
  const settingsBackRequestRef = useRef<(() => void) | null>(null);
  const [videoFullscreen, setVideoFullscreen] = useState(false);
  // 返回 / 显式导航前先关掉最上层的临时态（菜单、模态、全屏播放器……），见 shell/systemBack。
  const { dismissVisibleTransient, registerTransientClose } = useTransientDismissal({
    videoFullscreen,
  });
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
          dismissVisibleTransient(continuation)
        ) {
          return;
        }
        continuation();
      });
    },
    [dismissVisibleTransient, runAfterSettingsExit, selectedVideoId],
  );
  const bucket = useContainerWidth(appRef);
  // 外壳横屏时有让开挖孔的左右内边距：选外壳看整宽（bucket），工作台排版看扣掉内边距的宽度。
  const appPixelWidth = useContainerPixelWidth(appRef, { contentBox: true });
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
  // 侧栏展开占 256px（导航与课程列表在同一列），收起后换成 56px 的图标 rail。
  // 宽度喂给工作台布局。
  const sidebarWidth = shellWide
    ? sidebarCollapsed[selectedVideoId ? "workbench" : "library"]
      ? 56
      : 256
    : 0;
  const workbenchAvailableWidth = Math.max(0, appPixelWidth - sidebarWidth);
  const androidBackGuard = useRef(0);
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
  useAndroidBack(goBackOneLevel);



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

  const MainViewComponent = MAIN_VIEW_COMPONENTS[mainView];
  const shellNav: ShellNav = {
    view: sidebarView,
    libraryHomeActive: mainViewKey === "library" && !selectedCourseId,
    queueOpen,
    queueCount: queuedVideos.length + downloadCount,
    onToggleQueue: toggleQueue,
    dashboardOpen: showDashboard,
    onOpenDashboard: () => openMainView("dashboard"),
    assistantActive: assistantOpen,
    onToggleAssistant: toggleAssistant,
    theme,
    themeToggleLabel,
    onToggleTheme: toggleTheme,
    recycleOpen: showRecycleBin,
    onOpenRecycleBin: () => openMainView("recycle"),
    settingsOpen: showSettings,
    onOpenSettings: () => openMainView("settings"),
    onBackToLibrary: returnFromVideo,
    onGoLibraryHome: clearCourseSelection,
  };
  const shell: Shell = {
    isPhoneDevice,
    shellWide,
    workbenchAvailableWidth,
    showCourseListScreen,
    courseVideos: videos,
    selectedCourse,
    selectedVideo,
    knowledgeReturn,
    queue,
    recorrection,
    videoQuery,
    setVideoQuery,
    selectCourse,
    clearCourseSelection,
    openVideo,
    openQueuedVideo,
    openMainView,
    closeToLibrary: closeMainOverlays,
    resumeStudy,
    reviewJump,
    conceptJump,
    closeConcepts: () => {
      go({ view: "library" });
      setKnowledgeReturn(null);
    },
    returnToKnowledge,
    returnFromVideo,
    goBackOneLevel,
    forgetQueuedVideo,
    setVideoFullscreen,
    registerTransientClose,
    registerSettingsExitRequest,
    registerSettingsBackRequest,
  };

  return (
    <ShellContext.Provider value={shell}>
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
      {isPhoneDevice ? null : sidebarIsCollapsed ? (
        <AppRail nav={shellNav} onExpandSidebar={() => toggleSidebarCollapsed()} />
      ) : (
        <AppSidebar
              nav={shellNav}
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
            />
      )}
      <main className="ca-main">
        {/* key=视图类型(而非视频 id):切换顶层视图时重挂以重播入场动画;在工作台内
            切换视频时 key 不变,播放器与面板状态保留、不被打断。 */}
        <div key={mainViewKey} className="ca-view">
          <MainViewComponent />
        </div>
      </main>
      {showBottomTab && (
        <BottomTabBar
          active={activeCompactTab}
          queueCount={queuedVideos.length + downloadCount}
          onSelect={selectCompactTab}
        />
      )}
      <AssistantPanel
        context={assistantContext}
        onNavigate={assistantNavigate}
        onActionApplied={assistantActionApplied}
        compact={isPhoneDevice}
        bottomNavigationVisible={showBottomTab}
        // 桌面布局左侧工具栏里有助手按钮（⌘J 也能呼出），不再另外浮一个圆球；
        // 只有窄屏（没有工具栏）才需要这个入口。
        launcherVisible={
          isPhoneDevice && !showSettings && !showRecycleBin && !showDevConsole && !showDashboard
        }
      />
    </div>
    </ShellContext.Provider>
  );
}
