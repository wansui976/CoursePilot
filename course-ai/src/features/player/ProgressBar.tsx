import { useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { queries } from "@/lib/queries";
import { useTranslation } from "react-i18next";
import { useQuery } from "@tanstack/react-query";
import { formatMs } from "@/lib/time";
import { usePlayer } from "@/stores/player";
import type { SkipRange } from "@/lib/silenceSkip";
import type { DanmakuEntry } from "@/lib/types";
import { danmakuHeat, heatAreaPath, heatPeaks } from "@/lib/danmakuHeat";

const ARROW_SEEK_STEP_MS = 5_000;
const MIN_PAGE_SEEK_STEP_MS = 10_000;
const MAX_PAGE_SEEK_STEP_MS = 60_000;
const NO_DANMAKU: DanmakuEntry[] = [];

/**
 * 播放进度条（YouTube / B 站式）：浮在画面底部、控制按钮行之上。
 * 在原生 range（键盘/读屏/拖动免费）之上叠加：章节处断开成一段段（悬停显示章节名）、
 * 悬停时轨道加粗并露出拖动圆点、从头到指针处浅色预览、指针处始终显示时间；
 * 跳停顿段灰显（这部分播放时会直接跃过）。
 * 传入弹幕时在轨道上方画弹幕热度曲线，高峰处打点、可点击跳转，悬停显示该处弹幕数。
 */
export function ProgressBar({
  videoId,
  skipRanges,
  danmaku = NO_DANMAKU,
  onSeek,
}: {
  videoId: string;
  skipRanges: SkipRange[];
  /** 弹幕开着时传入；不足以成曲线（太少）时不画。 */
  danmaku?: DanmakuEntry[];
  onSeek: (ms: number) => void;
}) {
  const { t } = useTranslation();
  // 只让进度条订阅进度（每秒约 4 次重渲染），不波及整个播放器。
  const currentMs = usePlayer((s) => s.currentMs);
  const durationMs = usePlayer((s) => s.durationMs);
  const [hover, setHover] = useState<{ pct: number; width: number } | null>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);
  // 章节数据与章节面板共用同一查询键，缓存命中即零成本。
  const { data: chapters = [] } = useQuery(queries.chapters(videoId));
  const safeDuration = Math.max(0, durationMs);
  const safeCurrentMs = Math.min(safeDuration, Math.max(0, currentMs));
  const progressPercent =
    safeDuration > 0 ? (safeCurrentMs / safeDuration) * 100 : 0;
  const pct = (ms: number) =>
    safeDuration > 0 ? Math.min(100, Math.max(0, (ms / safeDuration) * 100)) : 0;
  const heat = useMemo(() => danmakuHeat(danmaku, safeDuration), [danmaku, safeDuration]);
  const heatPath = useMemo(() => (heat ? heatAreaPath(heat.levels) : ""), [heat]);
  const peaks = useMemo(() => (heat ? heatPeaks(heat) : []), [heat]);
  // 章节分界（不含片头 0 处）：轨道在这些位置断开 2px，看得出一共几段、现在在哪段。
  const chapterGaps = useMemo(
    () =>
      safeDuration > 0
        ? chapters
            .map((chapter) => (chapter.start_ms / safeDuration) * 100)
            .filter((p) => p > 0.2 && p < 99.8)
        : [],
    [chapters, safeDuration],
  );
  const trackMask = useMemo(() => chapterGapMask(chapterGaps), [chapterGaps]);

  const hoverPct = hover?.pct ?? null;
  const hoverMs =
    hoverPct != null && safeDuration > 0 ? (hoverPct / 100) * safeDuration : null;
  const hoverChapter =
    hoverMs != null && chapters.length > 0
      ? (chapters.find((c) => c.start_ms <= hoverMs && hoverMs < c.end_ms) ??
        (hoverMs >= (chapters[chapters.length - 1]?.start_ms ?? 0)
          ? chapters[chapters.length - 1]
          : null))
      : null;
  const hoverDanmakuCount =
    heat && hoverMs != null
      ? heat.counts[Math.min(heat.counts.length - 1, Math.floor(hoverMs / heat.binMs))]
      : 0;

  // 悬停提示跟着指针走，但整块夹在进度条左右边界内——不能按百分比夹（提示宽窄不一）。
  useLayoutEffect(() => {
    const tip = tooltipRef.current;
    if (!tip || !hover) return;
    const x = (hover.pct / 100) * hover.width;
    const width = tip.offsetWidth;
    tip.style.left = `${Math.min(Math.max(0, hover.width - width), Math.max(0, x - width / 2))}px`;
  });

  function handlePointerMove(event: React.PointerEvent<HTMLDivElement>) {
    const rect = event.currentTarget.getBoundingClientRect();
    if (rect.width <= 0) return;
    setHover({
      pct: Math.min(100, Math.max(0, ((event.clientX - rect.left) / rect.width) * 100)),
      width: rect.width,
    });
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
        className="group/progress relative h-4 flex-1 cursor-pointer"
        onPointerMove={handlePointerMove}
        onPointerLeave={() => setHover(null)}
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
        {/* 弹幕热度：轨道上方一条面积曲线，平时淡、悬停清晰。 */}
        {heat && (
          <svg
            data-testid="danmaku-heat"
            aria-hidden="true"
            viewBox="0 0 1000 100"
            preserveAspectRatio="none"
            className="pointer-events-none absolute inset-x-0 bottom-[calc(50%+3px)] h-3 w-full text-white opacity-30 transition-opacity duration-150 group-hover/progress:opacity-50"
          >
            <path d={heatPath} fill="currentColor" />
          </svg>
        )}
        {/* 视觉轨：3px 细线，悬停加粗成 5px；章节处用遮罩断开。 */}
        <div
          data-chapter-gaps={chapterGaps.length}
          className="pointer-events-none absolute inset-x-0 top-1/2 h-[3px] -translate-y-1/2 transition-[height] duration-150 group-hover/progress:h-[5px] peer-focus-visible:h-[5px]"
          style={trackMask}
        >
          <div className="absolute inset-0 rounded-full bg-white/25" />
          {/* 悬停预览：从头到指针处浅一层，看得出点下去会跳到哪。 */}
          {hoverPct != null && (
            <div
              className="absolute inset-y-0 left-0 rounded-full bg-white/35"
              style={{ width: `${hoverPct}%` }}
            />
          )}
          <div
            className="ca-fill-video-grad absolute inset-y-0 left-0 rounded-full"
            style={{ width: `${progressPercent}%` }}
          />
          {/* 跳停顿段灰显：这部分播放时会直接跃过。 */}
          {skipRanges.map((range, index) => (
            <div
              key={`skip-${index}`}
              className="absolute top-0 h-full bg-white/55"
              style={{
                left: `${pct(range.start_ms)}%`,
                width: `${Math.max(0.5, pct(range.end_ms) - pct(range.start_ms))}%`,
              }}
            />
          ))}
        </div>
        {/* 拖动圆点：平时收起，悬停 / 键盘聚焦时弹出（触屏常显，见 .ca-progress-thumb）。 */}
        <div
          aria-hidden="true"
          className="ca-progress-thumb pointer-events-none absolute top-1/2 h-3 w-3 -translate-x-1/2 -translate-y-1/2 scale-0 rounded-full bg-[var(--video-accent)] shadow-[0_0_0_3px_rgb(0_0_0/0.18)] transition-transform duration-150 group-hover/progress:scale-100 peer-focus-visible:scale-100"
          style={{ left: `${progressPercent}%` }}
        />
        {/* 弹幕高峰：曲线顶上的小圆点，点击直接跳过去。 */}
        {peaks.map((peak) => (
          <button
            key={`peak-${peak.ms}`}
            type="button"
            aria-label={t("videoPlayer.danmakuPeak", { time: formatMs(peak.ms) })}
            title={`${formatMs(peak.ms)} · ${t("videoPlayer.danmakuCount", { count: peak.count })}`}
            onClick={() => onSeek(peak.ms)}
            className="absolute z-[1] h-1.5 w-1.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-white/90 ring-1 ring-black/30 transition-transform hover:scale-150"
            // 曲线占轨道上方 12px（顶边在命中区 -3px 处），圆点落在该处曲线高度上。
            style={{ left: `${pct(peak.ms)}%`, top: `${-3 + (1 - peak.level) * 12}px` }}
          />
        ))}
        {/* 悬停提示：章节名 + 指针处时间（+ 该处弹幕数），锚在指针 x 处，夹在进度条内。 */}
        {hoverMs != null && (
          <div
            ref={tooltipRef}
            className="pointer-events-none absolute bottom-full z-10 mb-2 flex max-w-[min(320px,100%)] flex-col items-center rounded-md bg-black/80 px-2 py-1 text-center text-white shadow-lg ring-1 ring-white/10 backdrop-blur-sm"
          >
            {hoverChapter && (
              <span className="max-w-full truncate text-xs font-medium">{hoverChapter.title}</span>
            )}
            <span className="text-xs tabular-nums text-white/85">
              {formatMs(hoverMs)}
              {hoverDanmakuCount > 0 &&
                ` · ${t("videoPlayer.danmakuCount", { count: hoverDanmakuCount })}`}
            </span>
          </div>
        )}
        {/* 焦点环：input 透明看不见，键盘聚焦时给整条命中区一个可见轮廓。 */}
        <div className="pointer-events-none absolute inset-0 rounded-full opacity-0 ring-2 ring-white/70 transition-opacity peer-focus-visible:opacity-100" />
      </div>
    </div>
  );
}

/** 章节分界处挖 2px 空隙的遮罩；没有章节时不加遮罩。 */
function chapterGapMask(gaps: number[]): CSSProperties | undefined {
  if (gaps.length === 0) return undefined;
  const stops = ["#000 0"];
  for (const p of gaps) {
    stops.push(
      `#000 calc(${p}% - 1px)`,
      `transparent calc(${p}% - 1px)`,
      `transparent calc(${p}% + 1px)`,
      `#000 calc(${p}% + 1px)`,
    );
  }
  stops.push("#000 100%");
  const mask = `linear-gradient(to right, ${stops.join(", ")})`;
  return { maskImage: mask, WebkitMaskImage: mask };
}

/**
 * 控制栏收起时贴在画面最底边的 2px 进度细线（B 站式）：不挡画面，又随时看得到进度。
 */
export function MiniProgress() {
  const currentMs = usePlayer((s) => s.currentMs);
  const durationMs = usePlayer((s) => s.durationMs);
  const percent =
    durationMs > 0 ? Math.min(100, Math.max(0, (currentMs / durationMs) * 100)) : 0;
  return (
    <div aria-hidden="true" className="h-[2px] w-full bg-white/20">
      <div className="ca-fill-video-grad h-full" style={{ width: `${percent}%` }} />
    </div>
  );
}
