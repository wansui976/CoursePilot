import { useState, type KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import { Play } from "lucide-react";
import type { Course, VideoListItem } from "@/lib/types";
import { displayTitle } from "@/lib/videoTitle";
import { CourseBoardCover } from "./CourseBoardCover";
import { Button } from "@/ui/button";
import { Mark, Tag } from "@/ui/marks";
import { useSwipeCard } from "@/features/study/useSwipeCard";

export type DeckCourse = {
  course: Course;
  videos: VideoListItem[];
  watched: number;
  /** 下一讲：第一个没看完的视频。 */
  next: VideoListItem | null;
};

/** 同时露出几张（最前面一张 + 后面四张），更深的藏在后面。 */
const VISIBLE = 5;

/**
 * 课程牌堆：课程多于 4 门时，前后叠起来像一手牌。最前面一张完整，后面每张往右错开、略小、
 * 略斜、略暗，右缘一道课程色的书脊。点露出的那条、按 ←/→、或用外面的上一门/下一门翻牌；
 * 原来最前面那张往左轻甩一下回到牌底。右侧是最前面那门课的详情。
 */
export function CourseDeck({
  items,
  front,
  onFrontChange,
  onOpenCourse,
  onContinue,
}: {
  items: DeckCourse[];
  front: number;
  onFrontChange: (index: number) => void;
  onOpenCourse: (courseId: string) => void;
  onContinue: (courseId: string, videoId: string) => void;
}) {
  const { t } = useTranslation();
  const [leaving, setLeaving] = useState<string | null>(null);
  const n = items.length;
  // 手机上左右滑翻牌（往左滑看下一门，往右滑回上一门）。
  const swipe = useSwipeCard({
    enabled: n > 1,
    onSwipe: (direction) => go(direction === "left" ? front + 1 : front - 1),
  });
  if (n === 0) return null;
  const current = items[Math.min(front, n - 1)];

  function go(next: number) {
    const target = ((next % n) + n) % n;
    if (target === front) return;
    // 往后翻一张时，原来最前面的那张做一个「甩回牌底」的动作。
    if ((target - front + n) % n === 1) setLeaving(items[front].course.id);
    onFrontChange(target);
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "ArrowRight") {
      event.preventDefault();
      go(front + 1);
    } else if (event.key === "ArrowLeft") {
      event.preventDefault();
      go(front - 1);
    }
  }

  const total = current.videos.length;
  const done = Math.min(current.watched, total);
  const ratio = total > 0 ? done / total : 0;

  return (
    <div className="ca-deck">
      <div
        className="ca-deck-stack"
        role="listbox"
        tabIndex={0}
        aria-label={t("library.deckLabel")}
        aria-activedescendant={`deck-card-${current.course.id}`}
        onKeyDown={onKeyDown}
        {...swipe.handlers}
      >
        {items.map((item, k) => {
          const depth = (k - front + n) % n;
          const { course } = item;
          return (
            <div
              key={course.id}
              id={`deck-card-${course.id}`}
              role="option"
              aria-selected={depth === 0}
              aria-label={course.name}
              className={`ca-deck-card${leaving === course.id ? " leaving" : ""}`}
              data-depth={depth}
              data-hidden={depth >= VISIBLE ? "" : undefined}
              style={{ "--i": Math.min(depth, VISIBLE) } as React.CSSProperties}
              onClick={() => (depth === 0 ? onOpenCourse(course.id) : go(k))}
              onAnimationEnd={() => setLeaving((id) => (id === course.id ? null : id))}
            >
              <span
                className="spine"
                style={{ background: course.color ? `var(--tag-${course.color})` : "var(--tag-gray)" }}
              />
              <CourseBoardCover
                className="ca-deck-cover"
                course={course}
                hints={item.videos.slice(0, 20).map((video) => video.title)}
                number={course.video_count}
                unit={t("library.lectureUnit")}
                caption={course.name}
              >
                <span className="ca-deck-count">
                  {Math.min(item.watched, item.videos.length)} / {item.videos.length}
                </span>
                <span className="ca-deck-progress" aria-hidden="true">
                  <i
                    style={{
                      width: `${item.videos.length ? (item.watched / item.videos.length) * 100 : 0}%`,
                    }}
                  />
                </span>
              </CourseBoardCover>
              <span className="ca-deck-meta">
                <span className="ca-deck-name">{course.name}</span>
              </span>
            </div>
          );
        })}
      </div>

      <div className="ca-deck-info" aria-live="polite">
        <Tag color={current.course.color} size="md" className="self-start">
          {t("library.courseVideos", { count: current.course.video_count })}
        </Tag>
        <h3 className="ca-deck-title">{current.course.name}</h3>
        {current.next ? (
          <p className="ca-deck-next">
            {t("library.deckNextLecture")}
            <Mark>{displayTitle(current.next.title)}</Mark>
          </p>
        ) : (
          <p className="ca-deck-next">{t("library.deckDone")}</p>
        )}
        <div className="ca-deck-stats">
          <span>{t("library.deckWatched", { watched: done, total })}</span>
          <span>{done >= total ? t("library.deckDone") : t("library.deckLeft", { count: total - done })}</span>
        </div>
        <div className="ca-deck-bar" aria-hidden="true">
          <i style={{ width: `${ratio * 100}%` }} />
        </div>
        <div className="ca-deck-actions">
          {current.next && (
            <Button
              variant="primary"
              size="sm"
              onClick={() => onContinue(current.course.id, current.next!.id)}
            >
              <Play className="fill-current" />
              {t("library.deckContinue")}
            </Button>
          )}
          <Button variant="ghost" size="sm" onClick={() => onOpenCourse(current.course.id)}>
            {t("library.deckOpen")}
          </Button>
        </div>
      </div>
    </div>
  );
}
