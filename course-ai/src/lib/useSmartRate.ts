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
export function useSmartRate(segments: TranscriptSegment[]) {
  const [enabled, setEnabled] = useState(isSmartRateEnabled);
  const [multiplier, setMultiplier] = useState(1);
  const [notice, setNotice] = useState<string | null>(null);
  const noticeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // 倍率表只随字幕变化重算：一节 90 分钟的课有上千句，不该每次 timeupdate 都排一遍。
  const spans = useMemo(() => planSmartRates(segments), [segments]);

  const clearNoticeTimer = () => {
    if (noticeTimerRef.current) {
      clearTimeout(noticeTimerRef.current);
      noticeTimerRef.current = null;
    }
  };
  useEffect(() => clearNoticeTimer, []);

  // 关掉就立刻回到用户选的倍速，不留残留倍率。
  useEffect(() => {
    if (!enabled) setMultiplier(1);
  }, [enabled]);

  /**
   * 播放器每次 timeupdate 调一次，返回该用的倍率（相对基础倍速）。
   * `baseRate` 只用于提示文案，实际乘算由播放器做。
   */
  const update = useCallback(
    (positionMs: number, baseRate: number): number => {
      if (!enabled || spans.length === 0) return 1;
      const next = multiplierAt(spans, positionMs);
      setMultiplier((current) => {
        if (current === next) return current;
        // 变速要有交代：不然画面语速忽然变了，像是播放器出了毛病。
        setNotice(formatRateNotice(baseRate, next));
        clearNoticeTimer();
        noticeTimerRef.current = setTimeout(() => setNotice(null), NOTICE_MS);
        return next;
      });
      return next;
    },
    [enabled, spans],
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
    setNotice(formatSmartRateSummary(spans));
    clearNoticeTimer();
    noticeTimerRef.current = setTimeout(() => setNotice(null), NOTICE_MS);
  }, [enabled, spans]);

  return { enabled, toggle, multiplier, notice, available: spans.length > 0, update };
}
