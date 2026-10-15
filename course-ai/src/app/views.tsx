import { useHomeRoute } from "@/app/homeRoute";
import { useShell } from "@/app/shell";
import { ConceptsPanel } from "@/features/knowledge/ConceptsPanel";
import { CourseLibraryView } from "@/features/library/CourseLibraryView";
import { CourseSidebar } from "@/features/library/CourseSidebar";
import { ProcessingQueueView } from "@/features/library/ProcessingQueueView";
import { RecycleBin } from "@/features/library/RecycleBin";
import { isSettingsCategory } from "@/features/settings/categories";
import { DevConsole } from "@/features/settings/DevConsole";
import { SettingsPanel } from "@/features/settings/SettingsPanel";
import { Dashboard } from "@/features/study/Dashboard";
import { VideoWorkbench } from "@/features/workspace/VideoWorkbench";

/**
 * 各路由的主区视图。外壳（Home）负责 rail / 侧栏 / 底栏 / 助手，主区就是这里的 <Outlet />。
 * 导航动作统一走 useShell()，见 app/shell。
 */

/** `/`：选了视频是工作台；窄屏根层是整屏课程列表；否则是课程库（总览或某门课）。 */
export function LibraryRouteView() {
  const shell = useShell();
  const { courseId, videoId, go } = useHomeRoute();
  const { selectedVideo, knowledgeReturn } = shell;

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
  );
}

export function QueueRouteView() {
  const shell = useShell();
  return (
    <ProcessingQueueView
      queue={shell.queue}
      onBack={shell.goBackOneLevel}
      onOpenVideo={shell.openQueuedVideo}
    />
  );
}

export function DashboardRouteView() {
  const shell = useShell();
  return (
    <Dashboard
      onClose={shell.closeToLibrary}
      onOpenCourse={shell.selectCourse}
      onResume={shell.resumeStudy}
      onJump={shell.reviewJump}
    />
  );
}

export function SettingsRouteView() {
  const shell = useShell();
  const { settingsCategory, go } = useHomeRoute();
  return (
    <SettingsPanel
      category={isSettingsCategory(settingsCategory) ? settingsCategory : null}
      onCategoryChange={(category) => go({ settingsCategory: category })}
      onClose={shell.closeToLibrary}
      onOpenDevConsole={() => shell.openMainView("dev")}
      onRegisterExitRequest={shell.registerSettingsExitRequest}
      onRegisterBackRequest={shell.registerSettingsBackRequest}
    />
  );
}

export function RecycleRouteView() {
  const shell = useShell();
  return <RecycleBin onClose={shell.closeToLibrary} />;
}

export function DevRouteView() {
  const { go } = useHomeRoute();
  return <DevConsole onClose={() => go({ view: "settings", settingsCategory: "dev" })} />;
}
