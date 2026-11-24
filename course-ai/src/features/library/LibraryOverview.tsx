import { useState } from "react";
import { useQueries, useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { ChevronLeft, ChevronRight, FolderPlus, Layers, LayoutGrid, Loader2, Play } from "lucide-react";
import { ipc } from "@/lib/ipc";
import { qk } from "@/lib/queryKeys";
import { DECK_THRESHOLD, useHomeLayout } from "@/stores/homeLayout";
import { Button } from "@/ui/button";
import { IconButton } from "@/ui/icon-button";
import { ErrorNote } from "@/ui/ErrorNote";
import { queries } from "@/lib/queries";
import {
  WATCHED_RATIO,
  readLastVideoId,
  readPlaybackProgress,
  usePlaybackRevision,
} from "@/lib/playback";
import { formatMs } from "@/lib/time";
import type { Course, VideoListItem } from "@/lib/types";
import { displayTitle } from "@/lib/videoTitle";
import { CourseDeck } from "./CourseDeck";
import { DeskHome } from "./DeskHome";
import { LectureCover } from "./LectureCover";
import { CourseBoardCover } from "./CourseBoardCover";
import { SolarTermBoard } from "./SolarTermBoard";
import { useNow } from "@/lib/useNow";
import { UpdateNotice } from "./UpdateNotice";
/** 「继续学习」最多列几门课。 */
const RESUME_LIMIT = 3;

export type CourseSummary = {
  course: Course;
  videos: VideoListItem[];
  watched: number;
  resume: { video: VideoListItem; ratio: number; positionSec: number; index: number } | null;
};

function summarize(course: Course, videos: VideoListItem[]): CourseSummary {
  const watched = videos.filter(
    (video) => readPlaybackProgress(video.id).ratio >= WATCHED_RATIO,
  ).length;
  const lastId = readLastVideoId(course.id);
  const lastVideo = lastId ? videos.find((video) => video.id === lastId) : undefined;
  const progress = lastVideo ? readPlaybackProgress(lastVideo.id) : null;
  const resume =
    lastVideo && progress && progress.ratio > 0 && progress.ratio < WATCHED_RATIO
      ? {
          video: lastVideo,
          ratio: progress.ratio,
          positionSec: progress.positionSec,
          index: videos.indexOf(lastVideo),
        }
      : null;
  return { course, videos, watched, resume };
}

/** 一门课的「下一讲」：列表里第一个还没看完的视频。 */
function nextLecture(videos: VideoListItem[]): VideoListItem | null {
  return videos.find((video) => readPlaybackProgress(video.id).ratio < WATCHED_RATIO) ?? null;
}

/**
 * 课程库首页（有课程、尚未选中时）：标题 + 统计行 + 跨课程的「继续学习」+ 全部课程。
 * 课程不超过 4 门时平铺成卡片；多于 4 门叠成牌堆（「全部展开」切回平铺）。
 * 主页样式选了「课桌」时换成 DeskHome，内容相同、摆法不同。
 */
export function LibraryOverview({
  courses,
  onSelectCourse,
  onResume,
  onCreateCourse,
  creatingCourse,
  createError,
}: {
  courses: Course[];
  onSelectCourse: (courseId: string) => void;
  onResume: (courseId: string, videoId: string, positionSec: number) => void;
  onCreateCourse: () => void;
  creatingCourse: boolean;
  createError: Error | null;
}) {
  // 进度从库里回填（换设备、同步下来）后重新渲染：进度是渲染期直接读本地缓存的。
  usePlaybackRevision((state) => state.revision);
  const { t } = useTranslation();
  const now = useNow();
  const layout = useHomeLayout((state) => state.layout);
  const deckExpanded = useHomeLayout((state) => state.deckExpanded);
  const setDeckExpanded = useHomeLayout((state) => state.setDeckExpanded);
  const [deckFront, setDeckFront] = useState(0);
  const lists = useQueries({
    queries: courses.map((course) => queries.videos(course.id)),
  });
  const summaries = courses.map((course, index) =>
    summarize(course, lists[index]?.data ?? []),
  );
  const totalVideos = courses.reduce((sum, course) => sum + course.video_count, 0);
  const totalWatched = summaries.reduce((sum, summary) => sum + summary.watched, 0);
  const { data: dueCount } = useQuery({
    queryKey: qk.srs.countDue(),
    queryFn: () => ipc.srs.countDue(),
  });

  function continueCourse(courseId: string, videoId: string) {
    const summary = summaries.find((item) => item.course.id === courseId);
    const position = summary?.resume?.video.id === videoId ? summary.resume.positionSec : 0;
    onResume(courseId, videoId, position);
  }

  if (layout === "desk") {
    return (
      <DeskHome
        summaries={summaries.map((summary) => ({ ...summary, next: nextLecture(summary.videos) }))}
        dueCount={dueCount ?? 0}
        onSelectCourse={onSelectCourse}
        onResume={onResume}
        onContinue={continueCourse}
        onCreateCourse={onCreateCourse}
        creatingCourse={creatingCourse}
        createError={createError}
      />
    );
  }

  const stacked = courses.length > DECK_THRESHOLD && !deckExpanded;

  return (
    <div className="ca-main-col ca-overview">
      <header className="ca-topbar">
        <div className="tb-lead">
          <div className="tb-titles">
            <h1 className="ca-title-with-term">
              {t("nav.courseLibrary")}
              <SolarTermBoard now={now} />
            </h1>
            <div className="ca-stats">
              <div className="ca-stat">
                <span className="v">{courses.length}</span>
                <span className="k">{t("library.statCourses")}</span>
              </div>
              <div className="ca-stat">
                <span className="v">
                  {totalWatched}
                  <small>/ {totalVideos}</small>
                </span>
                <span className="k">
                  {t("library.statVideos")} · {t("library.statWatched")}
                </span>
              </div>
              {dueCount != null && (
                <div className="ca-stat">
                  <span className="v">{dueCount}</span>
                  <span className="k">{t("library.statDue")}</span>
                </div>
              )}
            </div>
          </div>
        </div>
        <div className="tb-actions">
          <Button
            variant="default"
            size="sm"
            disabled={creatingCourse}
            onClick={onCreateCourse}
            data-tour="add-course"
            className="ca-touch-44"
          >
            {creatingCourse ? <Loader2 className="animate-spin" /> : <FolderPlus />}
            {creatingCourse ? t("nav.addingCourse") : t("nav.addCourseFolder")}
          </Button>
        </div>
      </header>
      <div className="ca-scroll">
        {createError && <ErrorNote className="mb-4" error={createError} />}
        <UpdateNotice className="mb-4" />

        <ResumeSection courses={courses} onResume={onResume} />

        <section aria-labelledby="library-courses" className="ca-overview-section">
          <div className="ca-section-head">
            <h2 id="library-courses" className="ca-overview-heading">
              {t("library.allCourses")}
            </h2>
            {courses.length > DECK_THRESHOLD && (
              <span className="ca-section-more ca-deck-nav">
                {stacked && (
                  <>
                    <IconButton
                      aria-label={t("library.deckPrev")}
                      onClick={() => setDeckFront((deckFront - 1 + courses.length) % courses.length)}
                    >
                      <ChevronLeft className="h-4 w-4" />
                    </IconButton>
                    <span>
                      {deckFront + 1} / {courses.length}
                    </span>
                    <IconButton
                      aria-label={t("library.deckNext")}
                      onClick={() => setDeckFront((deckFront + 1) % courses.length)}
                    >
                      <ChevronRight className="h-4 w-4" />
                    </IconButton>
                  </>
                )}
                <Button variant="ghost" size="sm" onClick={() => setDeckExpanded(stacked)}>
                  {stacked ? <LayoutGrid /> : <Layers />}
                  {stacked ? t("library.deckShowAll") : t("library.deckStack")}
                </Button>
              </span>
            )}
          </div>
          {stacked ? (
            <CourseDeck
              items={summaries.map((summary) => ({
                course: summary.course,
                videos: summary.videos,
                watched: summary.watched,
                next: nextLecture(summary.videos),
              }))}
              front={deckFront}
              onFrontChange={setDeckFront}
              onOpenCourse={onSelectCourse}
              onContinue={continueCourse}
            />
          ) : (
            <div className="ca-course-grid">
              {summaries.map(({ course, videos, watched }) => {
                const ratio = videos.length > 0 ? watched / videos.length : 0;
                return (
                  <button
                    key={course.id}
                    type="button"
                    className="ca-course-card group"
                    aria-label={t("library.openCourse", { name: course.name })}
                    onClick={() => onSelectCourse(course.id)}
                  >
                    <span className="ca-course-cover" data-tiles={0}>
                      <CourseBoardCover
                        course={course}
                        number={course.video_count}
                        unit={t("library.lectureUnit")}
                        caption={course.name}
                      />
                    </span>
                    <span className="ca-course-body">
                      <span className="ca-course-name">{course.name}</span>
                      <span className="ca-course-meta">
                        {course.video_count > 0
                          ? t("library.courseVideos", { count: course.video_count })
                          : t("library.courseEmpty")}
                        {watched > 0 && (
                          <>
                            <span aria-hidden="true"> · </span>
                            {ratio >= 1
                              ? t("library.courseAllWatched")
                              : t("library.courseWatched", { count: watched })}
                          </>
                        )}
                      </span>
                      <span className="ca-course-progress" aria-hidden="true">
                        <i style={{ width: `${ratio * 100}%` }} />
                      </span>
                    </span>
                  </button>
                );
              })}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

/**
 * 「继续学习」：每门课最近看到一半的那一集。课程库总览和平板竖屏的课程列表首屏共用。
 * 都没有看到一半的就整段不显示。
 */
export function ResumeSection({
  courses,
  onResume,
}: {
  courses: Course[];
  onResume: (courseId: string, videoId: string, positionSec: number) => void;
}) {
  usePlaybackRevision((state) => state.revision);
  const { t } = useTranslation();
  const lists = useQueries({
    queries: courses.map((course) => queries.videos(course.id)),
  });
  const resumable = courses
    .map((course, index) => summarize(course, lists[index]?.data ?? []))
    .filter((summary) => summary.resume)
    .slice(0, RESUME_LIMIT);
  if (resumable.length === 0) return null;
  return (
    <section aria-labelledby="library-resume" className="ca-overview-section">
      <h2 id="library-resume" className="ca-overview-heading">
        {t("library.continueSection")}
      </h2>
      <div className="ca-resume-row">
        {resumable.map(({ course, resume }) => (
          <button
            key={course.id}
            type="button"
            className="ca-resume-card group"
            aria-label={t("home.continueLearning", { title: displayTitle(resume!.video.title) })}
            onClick={() => onResume(course.id, resume!.video.id, resume!.positionSec)}
          >
            <span className="ca-resume-cover">
              <LectureCover
                videoId={resume!.video.id}
                title={resume!.video.title}
                course={course}
                index={resume!.index}
                className="absolute inset-0 h-full w-full"
              />
              <span className="ov-bar" aria-hidden="true">
                <i style={{ width: `${resume!.ratio * 100}%` }} />
              </span>
              <span className="ca-resume-play" aria-hidden="true">
                <Play className="h-4 w-4 fill-current" />
              </span>
            </span>
            <span className="min-w-0 flex-1">
              <span className="ca-resume-course">{course.name}</span>
              <span className="ca-resume-title">{displayTitle(resume!.video.title)}</span>
              <span className="ca-resume-pos">
                {t("home.continueAt", { time: formatMs(Math.round(resume!.positionSec * 1000)) })}
                {" · "}
                {t("home.watchedPercentShort", { percent: Math.round(resume!.ratio * 100) })}
              </span>
            </span>
            {/* 只有一张时显示（见 .ca-resume-row 的样式）；整张卡本身就是按钮，这只是个提示。 */}
            <span className="ca-resume-go" aria-hidden="true">
              <Play className="h-3.5 w-3.5 fill-current" />
              {t("library.resumeGo")}
            </span>
          </button>
        ))}
      </div>
    </section>
  );
}
