import { useEffect, useRef, useState } from "react";
import type { Course, Video } from "@/lib/types";
import { playSound } from "@/lib/feedback";
import { prefersReducedMotion } from "@/lib/viewTransition";
import { LectureCover } from "@/features/library/LectureCover";

/** 擦掉 0.7 秒 + 新板书 0.6 秒 + 停一下再退场。 */
const DURATION_MS = 1700;

/**
 * 切到同一门课的另一讲时：盖在舞台上的一块黑板，先把上一讲的板书擦掉（留下一层粉笔灰），
 * 再写上这一讲，然后淡出露出视频。只在这一个时刻用，别处不用，保持它的仪式感。
 * 减弱动态效果时不播。
 */
export function EraseTransition({
  video,
  course,
  courseVideos,
}: {
  video: Video;
  course: Course | undefined;
  courseVideos: Video[];
}) {
  const previous = useRef<Video | null>(null);
  const [pair, setPair] = useState<{ from: Video; to: Video } | null>(null);

  useEffect(() => {
    const from = previous.current;
    previous.current = video;
    if (!from || from.id === video.id || from.course_id !== video.course_id) return;
    if (prefersReducedMotion()) return;
    setPair({ from, to: video });
    playSound("erase");
    const timer = window.setTimeout(() => setPair(null), DURATION_MS);
    return () => window.clearTimeout(timer);
  }, [video]);

  if (!pair) return null;
  const indexOf = (id: string) => courseVideos.findIndex((item) => item.id === id);
  return (
    <div className="ca-erase run" aria-hidden="true">
      <div className="layer new">
        <LectureCover title={pair.to.title} course={course} index={indexOf(pair.to.id)} className="cover" />
      </div>
      <div className="smudge" />
      <div className="layer old">
        <LectureCover title={pair.from.title} course={course} index={indexOf(pair.from.id)} className="cover" />
      </div>
      <div className="eraser" />
    </div>
  );
}
