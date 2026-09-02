import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useQuery } from "@tanstack/react-query";
import { formatMs } from "@/lib/time";
import { ipc } from "@/lib/ipc";
import { usePlayer } from "@/stores/player";
import type { Chapter } from "@/lib/types";
import type { SkipRange } from "@/lib/silenceSkip";

const ARROW_SEEK_STEP_MS = 5_000;
const MIN_PAGE_SEEK_STEP_MS = 10_000;
const MAX_PAGE_SEEK_STEP_MS = 60_000;

/**
 * 播放进度条。桌面端从控制栏剥离、常驻视频底边：3px 细线，悬停加粗。
 * 在原生 range（键盘/读屏/拖动免费）之上叠加章节刻度：每个章节 start_ms 一条竖线，
 * 悬停显示章节名；跳停顿段灰显（这部分播放时会直接跃过）。
 */
export function ProgressBar({
  videoId,
  skipRanges,
  onSeek,
}: {
  videoId: string;
  skipRanges: SkipRange[];
  onSeek: (ms: number) => void;
}) {
  const { t } = useTranslation();
  // 只让进度条订阅进度（每秒约 4 次重渲染），不波及整个播放器。
  const currentMs = usePlayer((s) => s.currentMs);
  const durationMs = usePlayer((s) => s.durationMs);
  const [hoverPct, setHoverPct] = useState<number | null>(null);
  // 章节刻度数据与章节面板共用同一查询键，缓存命中即零成本。
  const { data: chapters = [] } = useQuery<Chapter[]>({
    queryKey: ["chapters", videoId],
    queryFn: () => ipc.ai.getChapters(videoId),
  });
  const safeDuration = Math.max(0, durationMs);
  const safeCurrentMs = Math.min(safeDuration, Math.max(0, currentMs));
  const progressPercent =
    safeDuration > 0 ? (safeCurrentMs / safeDuration) * 100 : 0;
  const pct = (ms: number) =>
    safeDuration > 0 ? Math.min(100, Math.max(0, (ms / safeDuration) * 100)) : 0;

  const hoverMs =
    hoverPct != null && safeDuration > 0 ? (hoverPct / 100) * safeDuration : null;
  const hoverChapter =
    hoverMs != null && chapters.length > 0
      ? (chapters.find((c) => c.start_ms <= hoverMs && hoverMs < c.end_ms) ??
        (hoverMs >= (chapters[chapters.length - 1]?.start_ms ?? 0)
          ? chapters[chapters.length - 1]
          : null))
      : null;

  function handlePointerMove(event: React.PointerEvent<HTMLDivElement>) {
    const rect = event.currentTarget.getBoundingClientRect();
    if (rect.width <= 0) return;
    setHoverPct(
      Math.min(100, Math.max(0, ((event.clientX - rect.left) / rect.width) * 100)),
    );
  }

  function handleKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    const pageStepMs = Math.min(
      safeDuration,
      Math.max(
        MIN_PAGE_SEEK_STEP_MS,
        Math.min(MAX_PAGE_SEEK_STEP_MS, safeDuration * 0.1),
      ),
    );
    let nextMs: number;

    switch (event.key) {
      case "ArrowLeft":
      case "ArrowDown":
        nextMs = safeCurrentMs - ARROW_SEEK_STEP_MS;
        break;
      case "ArrowRight":
      case "ArrowUp":
        nextMs = safeCurrentMs + ARROW_SEEK_STEP_MS;
        break;
      case "PageDown":
        nextMs = safeCurrentMs - pageStepMs;
        break;
      case "PageUp":
        nextMs = safeCurrentMs + pageStepMs;
        break;
      case "Home":
        nextMs = 0;
        break;
      case "End":
        nextMs = safeDuration;
        break;
      default:
        return;
    }

    event.preventDefault();
    onSeek(Math.min(safeDuration, Math.max(0, Math.round(nextMs))));
  }

  return (
    <div className="ca-progress-shell flex items-center">
      <div
        className="group/progress relative h-6 flex-1 cursor-pointer"
        onPointerMove={handlePointerMove}
        onPointerLeave={() => setHoverPct(null)}
      >
        {/* 原生 range：透明盖住整条命中区，键盘/读屏/拖动全交给它。 */}
        <input
          aria-label={t("videoPlayer.progress")}
          type="range"
          min={0}
          max={safeDuration}
          step={1}
          value={safeCurrentMs}
          aria-valuetext={`${formatMs(safeCurrentMs)} / ${formatMs(safeDuration)}`}
          onChange={(event) => onSeek(Number(event.target.value))}
          onKeyDown={handleKeyDown}
          className="peer absolute inset-0 h-full w-full cursor-pointer opacity-0"
        />
        {/* 视觉轨：3px 细线，悬停加粗成 5px。 */}
        <div className="pointer-events-none absolute inset-x-0 top-1/2 h-[3px] -translate-y-1/2 rounded-full bg-[var(--surface-card-hover)] transition-[height] duration-150 group-hover/progress:h-[5px]">
          <div
            className="h-full rounded-full bg-[var(--accent)]"
            style={{ width: `${progressPercent}%` }}
          />
          {/* 跳停顿段灰显：这部分播放时会直接跃过。 */}
          {skipRanges.map((range, index) => (
            <div
              key={`skip-${index}`}
              className="absolute top-0 h-full rounded-sm bg-[var(--text-faint)]"
              style={{
                left: `${pct(range.start_ms)}%`,
                width: `${Math.max(0.5, pct(range.end_ms) - pct(range.start_ms))}%`,
              }}
            />
          ))}
          {/* 章节刻度：竖线，悬停可读章节名。 */}
          {chapters.map((chapter) => (
            <div
              key={chapter.id}
              className="absolute top-[-2px] h-[calc(100%+4px)] w-px bg-[var(--border-strong)]"
              style={{ left: `${pct(chapter.start_ms)}%` }}
            />
          ))}
        </div>
        {/* 悬停章节名：锚在指针 x 处，边缘夹回可见范围。 */}
        {hoverChapter && hoverPct != null && (
          <div
            className="pointer-events-none absolute -top-8 z-10 max-w-[60%] -translate-x-1/2 truncate rounded-md bg-[var(--surface-panel)] px-2 py-1 text-[11px] text-[var(--text-strong)] shadow-[var(--shadow-pop)] ring-1 ring-[var(--border-subtle)]"
            style={{ left: `${Math.min(88, Math.max(12, hoverPct))}%` }}
          >
            {formatMs(hoverChapter.start_ms)} {hoverChapter.title}
          </div>
        )}
        {/* 焦点环：input 透明看不见，键盘聚焦时给整条命中区一个可见轮廓。 */}
        <div className="pointer-events-none absolute inset-0 rounded-full opacity-0 ring-2 ring-[var(--video-accent)] transition-opacity peer-focus-visible:opacity-100" />
      </div>
    </div>
  );
}
