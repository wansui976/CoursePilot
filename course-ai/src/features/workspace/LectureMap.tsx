import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { ipc } from "@/lib/ipc";
import { queries } from "@/lib/queries";
import { qk } from "@/lib/queryKeys";
import { timelineMarks } from "@/lib/studyMarks";
import { formatMs } from "@/lib/time";
import { usePlayer } from "@/stores/player";

/**
 * 课程地图：把进度条上的学习痕迹展开成几条带标签的泳道——章节、重点、笔记、错题、闲聊。
 * 一眼看出这一讲哪里重要、哪里没懂。一条细黄线标出现在播到哪。空的泳道不画；全空就不显示。
 * 点泳道上的标记跳到那一秒。
 */
export function LectureMap({ videoId }: { videoId: string }) {
  const { t } = useTranslation();
  const durationMs = usePlayer((s) => s.durationMs);
  const currentMs = usePlayer((s) => s.currentMs);
  const requestSeek = usePlayer((s) => s.requestSeek);
  const { data: chapters = [] } = useQuery(queries.chapters(videoId));
  const { data: notes } = useQuery(queries.notes(videoId));
  const { data: cardMarks } = useQuery({
    queryKey: qk.srs.cardMarks(videoId),
    queryFn: () => ipc.srs.cardMarks(videoId),
    retry: false,
  });
  const { data: filler } = useQuery({
    queryKey: qk.artifact("highlights", videoId),
    queryFn: () => ipc.ai.getHighlights(videoId),
  });
  const marks = useMemo(() => timelineMarks(notes, cardMarks), [notes, cardMarks]);

  const total = durationMs > 0 ? durationMs : (chapters[chapters.length - 1]?.end_ms ?? 0);
  if (total <= 0) return null;
  const pct = (ms: number) => `${Math.min(100, Math.max(0, (ms / total) * 100))}%`;
  const fillerSegments = filler ?? [];
  const nowLine = <span className="now" style={{ left: pct(currentMs) }} aria-hidden="true" />;

  const lanes: { key: string; label: string; count: number; node: React.ReactNode }[] = [];
  if (marks.cards.length > 0) {
    lanes.push({
      key: "cards",
      label: t("lectureMap.highlights"),
      count: marks.cards.length,
      node: marks.cards.map((ms) => (
        <button
          key={ms}
          type="button"
          className="mk hl"
          style={{ left: pct(ms) }}
          aria-label={t("lectureMap.jump", { time: formatMs(ms) })}
          onClick={() => requestSeek(ms)}
        />
      )),
    });
  }
  if (marks.notes.length > 0) {
    lanes.push({
      key: "notes",
      label: t("lectureMap.notes"),
      count: marks.notes.length,
      node: marks.notes.map((ms) => (
        <button
          key={ms}
          type="button"
          className="mk nt"
          style={{ left: pct(ms) }}
          aria-label={t("lectureMap.jump", { time: formatMs(ms) })}
          onClick={() => requestSeek(ms)}
        />
      )),
    });
  }
  if (marks.mistakes.length > 0) {
    lanes.push({
      key: "mistakes",
      label: t("lectureMap.mistakes"),
      count: marks.mistakes.length,
      node: marks.mistakes.map((ms) => (
        <button
          key={ms}
          type="button"
          className="mk er"
          style={{ left: pct(ms) }}
          aria-label={t("lectureMap.jump", { time: formatMs(ms) })}
          onClick={() => requestSeek(ms)}
        />
      )),
    });
  }
  if (fillerSegments.length > 0) {
    lanes.push({
      key: "filler",
      label: t("lectureMap.filler"),
      count: fillerSegments.length,
      node: fillerSegments.map((segment) => (
        <span
          key={segment.start_ms}
          className="mk sk"
          style={{ left: pct(segment.start_ms), width: pct(segment.end_ms - segment.start_ms) }}
        />
      )),
    });
  }
  if (chapters.length === 0 && lanes.length === 0) return null;

  return (
    <section className="ca-map" aria-label={t("lectureMap.title")}>
      {chapters.length > 0 && (
        <>
          <span className="lbl">{t("lectureMap.chapters")}</span>
          <div className="lane chap">
            {chapters.map((chapter) => (
              <button
                key={chapter.start_ms}
                type="button"
                title={chapter.title}
                aria-label={chapter.title}
                className={
                  currentMs >= chapter.end_ms ? "done" : currentMs >= chapter.start_ms ? "now" : undefined
                }
                style={{ flex: Math.max(1, chapter.end_ms - chapter.start_ms) }}
                onClick={() => requestSeek(chapter.start_ms)}
              />
            ))}
          </div>
        </>
      )}
      {lanes.map((lane) => (
        <div key={lane.key} className="contents">
          <span className="lbl">
            {lane.label} <span className="n">{lane.count}</span>
          </span>
          <div className="lane">
            {lane.node}
            {nowLine}
          </div>
        </div>
      ))}
    </section>
  );
}
