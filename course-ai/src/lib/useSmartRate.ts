import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  formatRateNotice,
  formatSmartRateSummary,
  isSmartRateEnabled,
  multiplierAt,
  planSmartRates,
  setSmartRateEnabled,
} from "@/lib/smartRate";
import type { TranscriptSegment } from "@/lib/types";

/** 提示停留多久。够看清速度变成了多少，又不至于压在画面上碍事。 */
const NOTICE_MS = 2000;

/**
 * 智能倍速的播放器侧接线：管开关、按字幕排好倍率表、播到哪就用哪档。
 *
 * 倍率是**相对**用户自己选的倍速叠加的：选了 1.25x，慢段落会到 1.5x 左右，
 * 密集处回到 1.25x，绝不会比他选的更慢。
 */
type SmartRateOptions = {
  /** 视频切换时即使复用了同一份字幕数组，也必须丢掉上一段的倍率。 */
  resetKey?: string;
  /** Apple 播放内核超过 2x 会退化成关键帧播放。 */
  maxEffectiveRate?: number;
};

type MultiplierState = {
  resetKey?: string;
  value: number;
};

export function useSmartRate(segments: TranscriptSegment[], options: SmartRateOptions = {}) {
  const [enabled, setEnabled] = useState(isSmartRateEnabled);
  const [notice, setNotice] = useState<string | null>(null);
  const noticeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // 倍率表只随字幕变化重算：一节 90 分钟的课有上千句，不该每次 timeupdate 都排一遍。
  const spans = useMemo(() => planSmartRates(segments), [segments]);
  const summary = useMemo(() => formatSmartRateSummary(spans), [spans]);
  const appliedSpansRef = useRef(spans);
  const [multiplierState, setMultiplierState] = useState<MultiplierState>(() => ({
    resetKey: options.resetKey,
    value: 1,
  }));
  // 新视频/新倍率表的第一帧就按 1x 派生，不能等 effect 后才清掉旧倍率。
  const planChanged = appliedSpansRef.current !== spans;
  const scopeChanged = multiplierState.resetKey !== options.resetKey;
  const multiplier =
    enabled && spans.length > 0 && !planChanged && !scopeChanged
      ? multiplierState.value
      : 1;

  const clearNoticeTimer = () => {
    if (noticeTimerRef.current) {
      clearTimeout(noticeTimerRef.current);
      noticeTimerRef.current = null;
    }
  };
  useEffect(() => clearNoticeTimer, []);

  // 关掉或换视频/字幕表就回到用户选的倍速，不留残留倍率。
  useEffect(() => {
    appliedSpansRef.current = spans;
    setMultiplierState((current) =>
      current.resetKey === options.resetKey && current.value === 1
        ? current
        : { resetKey: options.resetKey, value: 1 },
    );
  }, [enabled, options.resetKey, spans]);

  /**
   * 播放器每次 timeupdate 调一次，返回该用的倍率（相对基础倍速）。
   * `baseRate` 只用于提示文案，实际乘算由播放器做。
   */
  const update = useCallback(
    (positionMs: number, baseRate: number): number => {
      if (!enabled || spans.length === 0) {
        if (multiplierState.resetKey !== options.resetKey || multiplierState.value !== 1) {
          setMultiplierState({ resetKey: options.resetKey, value: 1 });
        }
        return 1;
      }
      const planned = multiplierAt(spans, positionMs);
      const maxMultiplier = Math.max(
        1,
        (options.maxEffectiveRate ?? Number.POSITIVE_INFINITY) / baseRate,
      );
      const next = Math.min(planned, maxMultiplier);
      if (
        !planChanged &&
        multiplierState.resetKey === options.resetKey &&
        multiplierState.value === next
      ) {
        return next;
      }
      appliedSpansRef.current = spans;
      setMultiplierState({ resetKey: options.resetKey, value: next });
      if (multiplier !== next) {
        // 变速要有交代：不然画面语速忽然变了，像是播放器出了毛病。
        const capped = next < planned;
        const effective = Math.round(baseRate * next * 100) / 100;
        setNotice(
          capped
            ? `${effective}x（已达设备流畅播放上限）`
            : formatRateNotice(baseRate, next, options.maxEffectiveRate),
        );
        clearNoticeTimer();
        noticeTimerRef.current = setTimeout(() => setNotice(null), NOTICE_MS);
      }
      return next;
    },
    [
      enabled,
      multiplier,
      multiplierState,
      options.maxEffectiveRate,
      options.resetKey,
      planChanged,
      spans,
    ],
  );

  const toggle = useCallback(() => {
    setEnabled((on) => {
      const next = !on;
      setSmartRateEnabled(next);
      return next;
    });
  }, []);

  useEffect(() => {
    if (!enabled) return;
    // 打开时先给个回执，并说清这节课大约有多少会加速——不然「有没有生效」全靠猜。
    setNotice(summary);
    clearNoticeTimer();
    noticeTimerRef.current = setTimeout(() => setNotice(null), NOTICE_MS);
  }, [enabled, summary]);

  return { enabled, toggle, multiplier, notice, available: spans.length > 0, update };
}
