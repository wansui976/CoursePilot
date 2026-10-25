import { useQueries } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { FolderPlus, Loader2, Play } from "lucide-react";
import { Button } from "@/ui/button";
import { ErrorNote } from "@/ui/ErrorNote";
import { queries } from "@/lib/queries";
import { WATCHED_RATIO, readLastVideoId, readPlaybackProgress } from "@/lib/playback";
import { formatMs } from "@/lib/time";
import type { Course, VideoListItem } from "@/lib/types";
import { displayTitle } from "@/lib/videoTitle";
import { UpdateNotice } from "./UpdateNotice";
import { VideoCover } from "./VideoCover";

/** 课程封面拼贴最多取几集。 */
const MOSAIC = 4;
/** 「继续学习」最多列几门课。 */
const RESUME_LIMIT = 3;

type CourseSummary = {
  course: Course;
  videos: VideoListItem[];
  watched: number;
  resume: { video: VideoListItem; ratio: number; positionSec: number } | null;
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
      ? { video: lastVideo, ratio: progress.ratio, positionSec: progress.positionSec }
      : null;
  return { course, videos, watched, resume };
}

/**
 * 课程库首页（有课程、尚未选中时）：问候 + 跨课程的「继续学习」+ 全部课程卡片。
 * 卡片封面取前几集的首帧拼贴，进度按本地播放记录聚合，与课程内视图同源。
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
  const { t } = useTranslation();
  const lists = useQueries({
    queries: courses.map((course) => queries.videos(course.id)),
  });
  const summaries = courses.map((course, index) =>
    summarize(course, lists[index]?.data ?? []),
  );
  const totalVideos = courses.reduce((sum, course) => sum + course.video_count, 0);
  const resumable = summaries.filter((summary) => summary.resume).slice(0, RESUME_LIMIT);

  return (
    <div className="ca-main-col">
      <header className="ca-topbar">
        <div className="tb-lead">
          <div className="tb-titles">
            <h1>{t("nav.courseLibrary")}</h1>
            <div className="sub">
              {t("library.overviewSub", { courses: courses.length, videos: totalVideos })}
            </div>
          </div>
        </div>
        <div className="tb-actions">
          <Button
            variant="outline"
            size="sm"
            disabled={creatingCourse}
            onClick={onCreateCourse}
            className="ca-touch-44"
          >
            {creatingCourse ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <FolderPlus className="h-4 w-4" />
            )}
            {creatingCourse ? t("nav.addingCourse") : t("nav.addCourseFolder")}
          </Button>
        </div>
      </header>
      <div className="ca-scroll">
        {createError && <ErrorNote className="mb-4" error={createError} />}
        <UpdateNotice className="mb-4" />

        {resumable.length > 0 && (
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
                    <VideoCover videoId={resume!.video.id} className="absolute inset-0 h-full w-full" />
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
                </button>
              ))}
            </div>
          </section>
        )}

        <section aria-labelledby="library-courses" className="ca-overview-section">
          <h2 id="library-courses" className="ca-overview-heading">
            {t("library.allCourses")}
          </h2>
          <div className="ca-course-grid">
            {summaries.map(({ course, videos, watched }) => {
              const covers = videos.slice(0, MOSAIC);
              const ratio = videos.length > 0 ? watched / videos.length : 0;
              return (
                <button
                  key={course.id}
                  type="button"
                  className="ca-course-card group"
                  aria-label={t("library.openCourse", { name: course.name })}
                  onClick={() => onSelectCourse(course.id)}
                >
                  <span
                    className="ca-course-cover"
                    data-tiles={covers.length >= MOSAIC ? MOSAIC : covers.length > 0 ? 1 : 0}
                  >
                    {covers.length === 0 ? (
                      // 没有视频封面：像一本书的封面，中性底色上用阅读字体写课程名。
                      <span className="ca-course-initial" aria-hidden="true">
                        {course.name}
                      </span>
                    ) : (
                      (covers.length >= MOSAIC ? covers : covers.slice(0, 1)).map((video) => (
                        <span key={video.id} className="ca-course-tile">
                          <VideoCover videoId={video.id} className="absolute inset-0 h-full w-full" />
                        </span>
                      ))
                    )}
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
        </section>
      </div>
    </div>
  );
}
