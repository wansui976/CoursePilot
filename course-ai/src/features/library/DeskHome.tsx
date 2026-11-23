import { useState } from "react";
import { useTranslation } from "react-i18next";
import { BookOpen, FolderPlus, Loader2, Play } from "lucide-react";
import { useOptionalShell } from "@/app/shell";
import { formatMs } from "@/lib/time";
import type { Course, VideoListItem } from "@/lib/types";
import { displayTitle } from "@/lib/videoTitle";
import { Button } from "@/ui/button";
import { ErrorNote } from "@/ui/ErrorNote";
import { Kbd, Mark } from "@/ui/marks";
import { MistakeDeck } from "@/features/study/MistakeDeck";
import { CourseDeck } from "./CourseDeck";
import { LectureCover } from "./LectureCover";
import { UpdateNotice } from "./UpdateNotice";
import { DeskWindow } from "./DeskWindow";
import { SolarTermBoard } from "./SolarTermBoard";
import { daypartOf, seasonOf } from "@/lib/daypart";
import { moonPhase } from "@/lib/moon";
import { useNow } from "@/lib/useNow";
import { useWindowWeather } from "@/lib/useWindowWeather";
import { useHomeLayout } from "@/stores/homeLayout";

type DeskSummary = {
  course: Course;
  videos: VideoListItem[];
  watched: number;
  resume: { video: VideoListItem; ratio: number; positionSec: number; index: number } | null;
  next: VideoListItem | null;
};

/**
 * 主页的「课桌」摆法：俯视一张书桌，桌上每样东西都是实物。
 * 左上一张便利贴写今天的计划，中间摊开正在看的这一讲，右上是待复习的那摞卡，左下是课程牌堆。
 * 内容和仪表盘一样，只是摆法不同（设置 → 外观 → 主页样式）。
 */
export function DeskHome({
  summaries,
  dueCount,
  onSelectCourse,
  onResume,
  onContinue,
  onCreateCourse,
  creatingCourse,
  createError,
}: {
  summaries: DeskSummary[];
  dueCount: number;
  onSelectCourse: (courseId: string) => void;
  onResume: (courseId: string, videoId: string, positionSec: number) => void;
  onContinue: (courseId: string, videoId: string) => void;
  onCreateCourse: () => void;
  creatingCourse: boolean;
  createError: Error | null;
}) {
  const { t } = useTranslation();
  const shell = useOptionalShell();
  const [front, setFront] = useState(0);
  const now = useNow();

  const showWindow = useHomeLayout((state) => state.deskWindow);
  const windowWeather = useWindowWeather(showWindow);
  const sun = windowWeather.weather
    ? { sunrise: windowWeather.weather.sunrise_ms, sunset: windowWeather.weather.sunset_ms }
    : null;
  const part = daypartOf(now, sun);
  const open = summaries.find((summary) => summary.resume) ?? null;
  const resume = open?.resume ?? null;

  return (
    <div className="ca-main-col ca-desk">
      <header className="ca-desk-head">
        <h1 className="ca-desk-title ca-title-with-term">
          {t("desk.title")}
          <SolarTermBoard now={now} />
        </h1>
        <Button variant="default" size="sm" disabled={creatingCourse} onClick={onCreateCourse}>
          {creatingCourse ? <Loader2 className="animate-spin" /> : <FolderPlus />}
          {t("desk.newCourse")}
        </Button>
      </header>
      <div className="ca-desk-surface" data-window={showWindow ? "" : undefined}>
        {showWindow && (
          <DeskWindow
            part={part}
            season={seasonOf(now, windowWeather.place?.latitude)}
            moon={moonPhase(now)}
            weather={windowWeather.weather}
            placeName={windowWeather.place?.name}
          />
        )}
        {createError && <ErrorNote error={createError} className="ca-desk-error" />}
        <UpdateNotice className="ca-desk-error" />

        <aside className="ca-sticky" aria-label={t("desk.noteTitle")}>
          <span className="ca-sticky-title">{t("desk.noteTitle")}</span>
          {resume && <span>{t("desk.noteResume", { title: displayTitle(resume.video.title) })}</span>}
          <span>{dueCount > 0 ? t("desk.noteReview", { count: dueCount }) : t("desk.noteNoReview")}</span>
        </aside>

        <section className="ca-desk-obj ca-notebook" aria-label={t("desk.openNotebook")}>
          {open && resume ? (
            <>
              <LectureCover
                videoId={resume.video.id}
                title={resume.video.title}
                course={open.course}
                index={resume.index}
                className="ca-notebook-cover"
              >
                <span className="ca-deck-progress" aria-hidden="true">
                  <i style={{ width: `${resume.ratio * 100}%` }} />
                </span>
              </LectureCover>
              <div className="ca-notebook-page">
                <span className="ca-desk-label">
                  {open.course.name} · {t("desk.openNotebook")}
                </span>
                <h2 className="ca-notebook-title">{displayTitle(resume.video.title)}</h2>
                <p className="ca-notebook-line">
                  <Mark>{t("desk.lastStop", { time: formatMs(Math.round(resume.positionSec * 1000)) })}</Mark>
                </p>
                <Button
                  variant="primary"
                  size="sm"
                  className="self-start"
                  onClick={() => onResume(open.course.id, resume.video.id, resume.positionSec)}
                >
                  <Play className="fill-current" />
                  {t("desk.continueAt", { time: formatMs(Math.round(resume.positionSec * 1000)) })}
                </Button>
              </div>
            </>
          ) : (
            <div className="ca-notebook-page ca-notebook-empty">
              <span className="ca-desk-label">{t("desk.openNotebook")}</span>
              <h2 className="ca-notebook-title">{t("desk.nothingOpen")}</h2>
            </div>
          )}
        </section>

        <section className="ca-desk-pile" aria-label={t("desk.reviewPile")}>
          {[3, 2, 1].map((depth) => (
            <span
              key={depth}
              className="ca-desk-obj ca-pile-sheet"
              style={{ transform: `translate(${depth * 3}px, ${-depth * 4}px)`, zIndex: 5 - depth }}
              aria-hidden="true"
            />
          ))}
          <button
            type="button"
            className="ca-desk-obj ca-pile-top"
            onClick={() => shell?.openMainView("dashboard")}
          >
            <span className="ca-desk-label">{t("desk.reviewPile")}</span>
            <span className="ca-pile-count">
              {dueCount}
              <small>{t("desk.reviewCards")}</small>
            </span>
            <span className="ca-pile-go">
              {dueCount > 0 ? (
                <>
                  <BookOpen className="h-3.5 w-3.5" />
                  {t("desk.reviewStart")} <Kbd>R</Kbd>
                </>
              ) : (
                t("desk.reviewNone")
              )}
            </span>
          </button>
        </section>

        <div className="ca-desk-miss">
          <MistakeDeck onReview={() => shell?.openMainView("dashboard")} />
        </div>

        <section className="ca-desk-deck" aria-label={t("desk.deckCaption", { count: summaries.length })}>
          <CourseDeck
            items={summaries}
            front={Math.min(front, Math.max(0, summaries.length - 1))}
            onFrontChange={setFront}
            onOpenCourse={onSelectCourse}
            onContinue={onContinue}
          />
          <span className="ca-desk-label">{t("desk.deckCaption", { count: summaries.length })}</span>
        </section>
      </div>
    </div>
  );
}
