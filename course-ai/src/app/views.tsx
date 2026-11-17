import { lazy, Suspense, useCallback, type ReactNode } from "react";
import { useHomeRoute } from "@/app/homeRoute";
import { useShell } from "@/app/shell";
import { CourseLibraryView } from "@/features/library/CourseLibraryView";
import { CourseSidebar } from "@/features/library/CourseSidebar";
import { isSettingsCategory } from "@/features/settings/categories";
import { VideoWorkbench } from "@/features/workspace/VideoWorkbench";

// 课程库 / 工作台是启动就要的，留在主包；其余一级视图点进去才加载，首屏少解析一大截
// （学习面板连着复习会话、知识点连着费曼复述、设置连着各分类和模型管理）。
const ConceptsPanel = lazy(() =>
  import("@/features/knowledge/ConceptsPanel").then((m) => ({ default: m.ConceptsPanel })),
);
const ProcessingQueueView = lazy(() =>
  import("@/features/library/ProcessingQueueView").then((m) => ({ default: m.ProcessingQueueView })),
);
const RecycleBin = lazy(() =>
  import("@/features/library/RecycleBin").then((m) => ({ default: m.RecycleBin })),
);
const DevConsole = lazy(() =>
  import("@/features/settings/DevConsole").then((m) => ({ default: m.DevConsole })),
);
const SettingsPanel = lazy(() =>
  import("@/features/settings/SettingsPanel").then((m) => ({ default: m.SettingsPanel })),
);
const Dashboard = lazy(() =>
  import("@/features/study/Dashboard").then((m) => ({ default: m.Dashboard })),
);

/** 懒加载视图的占位：本地读文件只要几十毫秒，留空比闪一下骨架更安静。 */
function Lazy({ children }: { children: ReactNode }) {
  return <Suspense fallback={null}>{children}</Suspense>;
}

/**
 * 各路由的主区视图。外壳（Home）负责 rail / 侧栏 / 底栏 / 助手，主区就是这里的 <Outlet />。
 * 导航动作统一走 useShell()，见 app/shell。
 */

/** `/`：选了视频是工作台；窄屏根层是整屏课程列表；否则是课程库（总览或某门课）。 */
export function LibraryRouteView() {
  const shell = useShell();
  const { courseId, folderId, videoId, go } = useHomeRoute();
  const { selectedVideo, knowledgeReturn } = shell;
  const changeFolder = useCallback((id: string | null) => go({ folderId: id }), [go]);

  if (selectedVideo) {
    return (
      <VideoWorkbench
        video={selectedVideo}
        course={shell.selectedCourse}
        courseVideos={shell.courseVideos}
        isPhoneDevice={shell.isPhoneDevice}
        shellWide={shell.shellWide}
        availableWidth={shell.workbenchAvailableWidth}
        backToConceptName={knowledgeReturn?.navigationState.conceptName ?? null}
        showBackButton={shell.sidebarCollapsed}
        onReturnToKnowledge={shell.returnToKnowledge}
        onReturnFromVideo={shell.returnFromVideo}
        onFullscreenChange={shell.setVideoFullscreen}
      />
    );
  }

  if (shell.showCourseListScreen) {
    return (
      <CourseSidebar
        selectedCourseId={courseId}
        onSelect={shell.selectCourse}
        onClearSelection={shell.clearCourseSelection}
        onOpenRecycleBin={() => shell.openMainView("recycle")}
        onTransientCloseChange={shell.registerTransientClose}
      />
    );
  }

  return (
    <CourseLibraryView
      key={courseId ?? "none"}
      courseId={courseId}
      folderId={folderId}
      onFolderChange={changeFolder}
      videoQuery={shell.videoQuery}
      onVideoQueryChange={shell.setVideoQuery}
      isPhoneDevice={shell.isPhoneDevice}
      queue={shell.queue}
      recorrection={shell.recorrection}
      openVideo={shell.openVideo}
      onBackToCourses={() => go({ courseId: null })}
      onOpenConcepts={() => go({ view: "concepts" })}
      onVideoDeleted={(deletedId) => {
        shell.forgetQueuedVideo(deletedId);
        if (videoId === deletedId) go({ videoId: null });
      }}
      onSelectCourse={shell.selectCourse}
      onResume={shell.resumeStudy}
      onTransientCloseChange={shell.registerTransientClose}
    />
  );
}

/** `/concepts`：课程知识点。没选课程、或正从知识点跳进了某个视频时，与 `/` 一致。 */
export function ConceptsRouteView() {
  const shell = useShell();
  const { courseId } = useHomeRoute();
  if (shell.selectedVideo || !courseId) return <LibraryRouteView />;
  return (
    <Lazy>
      <ConceptsPanel
        courseId={courseId}
        courseName={shell.selectedCourse?.name}
        onClose={shell.closeConcepts}
        onJump={shell.conceptJump}
        initialNavigationState={
          shell.knowledgeReturn?.courseId === courseId
            ? shell.knowledgeReturn.navigationState
            : null
        }
      />
    </Lazy>
  );
}

export function QueueRouteView() {
  const shell = useShell();
  return (
    <Lazy>
      <ProcessingQueueView
        queue={shell.queue}
        onBack={shell.goBackOneLevel}
        onOpenVideo={shell.openQueuedVideo}
      />
    </Lazy>
  );
}

export function DashboardRouteView() {
  const shell = useShell();
  return (
    <Lazy>
      <Dashboard
        onClose={shell.closeToLibrary}
        onOpenCourse={shell.selectCourse}
        onResume={shell.resumeStudy}
        onJump={shell.reviewJump}
      />
    </Lazy>
  );
}

export function SettingsRouteView() {
  const shell = useShell();
  const { settingsCategory, go } = useHomeRoute();
  return (
    <Lazy>
      <SettingsPanel
        category={isSettingsCategory(settingsCategory) ? settingsCategory : null}
        onCategoryChange={(category) => go({ settingsCategory: category })}
        onClose={shell.closeToLibrary}
        onOpenDevConsole={() => shell.openMainView("dev")}
        onRegisterExitRequest={shell.registerSettingsExitRequest}
        onRegisterBackRequest={shell.registerSettingsBackRequest}
      />
    </Lazy>
  );
}

export function RecycleRouteView() {
  const shell = useShell();
  return (
    <Lazy>
      <RecycleBin onClose={shell.closeToLibrary} />
    </Lazy>
  );
}

export function DevRouteView() {
  const { go } = useHomeRoute();
  return (
    <Lazy>
      <DevConsole onClose={() => go({ view: "settings", settingsCategory: "dev" })} />
    </Lazy>
  );
}
