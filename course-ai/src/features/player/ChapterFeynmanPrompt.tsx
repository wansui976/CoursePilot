import { useEffect, useRef, useState } from "react";
import { GraduationCap, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useFeynman } from "@/stores/feynman";
import { usePlayer } from "@/stores/player";
import type { Chapter } from "@/lib/types";

/** 提示自动消失的时间：不打断下一节的观看。 */
const PROMPT_MS = 12_000;
/** 超过这个跨度就不算「自然播到章末」——用户拖了进度条，不该弹提示。 */
const NATURAL_STEP_MS = 2_500;

/**
 * 一章播完时轻提示「讲一讲」：费曼复述最有效的时机就是刚看完、还没忘的时候。
 *
 * 只在自然播放跨过章末时出现，拖进度条不算；同一章本次会话只提示一次。
 * 提示不抢焦点、不暂停播放，几秒后自己消失，不打断下一节。
 */
export function ChapterFeynmanPrompt({
  videoId,
  chapters,
}: {
  videoId: string;
  chapters: Chapter[] | undefined;
}) {
  const { t } = useTranslation();
  const currentMs = usePlayer((state) => state.currentMs);
  const [prompt, setPrompt] = useState<Chapter | null>(null);
  const lastMsRef = useRef(currentMs);
  const shownRef = useRef<Set<number>>(new Set());

  useEffect(() => {
    // 切视频时重置记录；用 getState 读一次，避免把 currentMs 放进依赖后每个 tick 清空提示。
    lastMsRef.current = usePlayer.getState().currentMs;
    shownRef.current = new Set();
    setPrompt(null);
  }, [videoId]);

  useEffect(() => {
    const previous = lastMsRef.current;
    lastMsRef.current = currentMs;
    if (!chapters?.length || currentMs <= previous || currentMs - previous > NATURAL_STEP_MS) {
      return;
    }
    for (const chapter of chapters) {
      const end = chapter.end_ms || 0;
      if (
        end > chapter.start_ms &&
        previous < end &&
        currentMs >= end &&
        !shownRef.current.has(chapter.id)
      ) {
        shownRef.current.add(chapter.id);
        setPrompt(chapter);
        break;
      }
    }
  }, [chapters, currentMs]);

  useEffect(() => {
    if (!prompt) return;
    const timer = window.setTimeout(() => setPrompt(null), PROMPT_MS);
    return () => window.clearTimeout(timer);
  }, [prompt]);

  if (!prompt) return null;

  const explain = () => {
    useFeynman.getState().open(
      {
        kind: "range",
        video_id: videoId,
        start_ms: prompt.start_ms,
        end_ms: prompt.end_ms,
        title: prompt.title,
      },
      prompt.title,
      videoId,
    );
    setPrompt(null);
  };

  return (
    <div
      role="status"
      aria-live="polite"
      onClick={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
      className="absolute bottom-24 left-4 z-30 flex max-w-[calc(100%-2rem)] items-center gap-2 rounded-xl border border-white/15 bg-[var(--surface-stage-overlay)] px-3 py-2 text-xs text-white shadow-[var(--shadow-raise)] backdrop-blur"
    >
      <GraduationCap className="h-4 w-4 flex-none text-white/80" aria-hidden="true" />
      <span className="min-w-0 truncate">
        {t("feynman.chapterEndText", { chapter: prompt.title })}
      </span>
      <button
        type="button"
        onClick={explain}
        className="ca-touch-44 flex-none rounded-full bg-white/15 px-2.5 py-1 font-medium hover:bg-white/25"
      >
        {t("feynman.chapterEndAction")}
      </button>
      <button
        type="button"
        aria-label={t("common.close")}
        onClick={() => setPrompt(null)}
        className="ca-touch-44 grid h-6 w-6 flex-none place-items-center rounded-full text-white/60 hover:text-white"
      >
        <X className="h-3.5 w-3.5" aria-hidden="true" />
      </button>
    </div>
  );
}
