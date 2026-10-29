import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { ipc } from "@/lib/ipc";
import { qk } from "@/lib/queryKeys";
import { useAiGeneration } from "@/lib/useAiGeneration";
import {
  activeSegments,
  HIGHLIGHT_FAST_RATE,
  savedMs,
  segmentAt,
} from "@/lib/highlights";
import type { HighlightSegment } from "@/lib/types";
import { useHighlightPrefs } from "@/stores/highlightPrefs";

const NOTICE_MS = 4500;
const EMPTY: HighlightSegment[] = [];

export type HighlightNotice = { text: string; actionLabel: string; onAction: () => void };

/**
 * 精华压缩版的播放器侧接线：拉段落、按档位在 timeupdate 里跳过或给出快放倍速，
 * 每次动作都给一条带「撤回 / 这段有用」的提示——判断错了，用户一下就能拿回来。
 */
export function useHighlights(videoId: string, { maxRate }: { maxRate?: number }) {
  const { t } = useTranslation();
  const mode = useHighlightPrefs((state) => state.mode);
  const strength = useHighlightPrefs((state) => state.strength);
  const keptForVideo = useHighlightPrefs((state) => state.kept[videoId]);
  const query = useQuery({
    queryKey: qk.artifact("highlights", videoId),
    queryFn: () => ipc.ai.getHighlights(videoId),
  });
  const generate = useAiGeneration(videoId, "highlights");
  const segments = useMemo(
    () => activeSegments(query.data ?? EMPTY, strength, keptForVideo ?? []),
    [keptForVideo, query.data, strength],
  );
  const fastRate = maxRate ? Math.min(maxRate, HIGHLIGHT_FAST_RATE) : HIGHLIGHT_FAST_RATE;

  const segmentsRef = useRef(segments);
  segmentsRef.current = segments;
  const modeRef = useRef(mode);
  modeRef.current = mode;
  /** 快放提示只在进入一段时出一次。 */
  const announcedRef = useRef<number | null>(null);
  const [notice, setNotice] = useState<HighlightNotice | null>(null);
  const timerRef = useRef<number | undefined>(undefined);

  const show = useCallback((next: HighlightNotice) => {
    window.clearTimeout(timerRef.current);
    setNotice(next);
    timerRef.current = window.setTimeout(() => setNotice(null), NOTICE_MS);
  }, []);
  const dismiss = useCallback(() => {
    window.clearTimeout(timerRef.current);
    setNotice(null);
  }, []);
  useEffect(() => () => window.clearTimeout(timerRef.current), []);
  useEffect(() => {
    announcedRef.current = null;
    setNotice(null);
  }, [videoId]);

  const keep = useCallback(
    (segment: HighlightSegment) => useHighlightPrefs.getState().keep(videoId, segment.start_ms),
    [videoId],
  );
  const reasonOf = useCallback(
    (segment: HighlightSegment) => segment.reason || t(`highlights.kind.${segment.kind}`),
    [t],
  );

  /** 跳过档：落进水分段就跳到段尾。跳了返回 true，调用方这一轮不再记进度。 */
  const handleTimeUpdate = useCallback(
    (video: HTMLVideoElement): boolean => {
      if (modeRef.current !== "skip" || video.paused || video.seeking) return false;
      const ms = video.currentTime * 1000;
      const segment = segmentAt(segmentsRef.current, ms);
      // 离段尾不到半秒就让它自己播完，免得来回跳。
      if (!segment || segment.end_ms - ms < 500) return false;
      video.currentTime = segment.end_ms / 1000;
      show({
        text: t("highlights.skipped", {
          seconds: Math.max(1, Math.round((segment.end_ms - ms) / 1000)),
          reason: reasonOf(segment),
        }),
        actionLabel: t("highlights.undo"),
        onAction: () => {
          keep(segment);
          video.currentTime = segment.start_ms / 1000;
          dismiss();
        },
      });
      return true;
    },
    [dismiss, keep, reasonOf, show, t],
  );

  /** 快放档：此刻该用的倍速；不在水分段（或没开快放）返回 null。 */
  const rateFor = useCallback(
    (ms: number): number | null => {
      if (modeRef.current !== "fast") return null;
      const segment = segmentAt(segmentsRef.current, ms);
      if (!segment) {
        announcedRef.current = null;
        return null;
      }
      if (announcedRef.current !== segment.start_ms) {
        announcedRef.current = segment.start_ms;
        show({
          text: t("highlights.fastForwarding", { reason: reasonOf(segment) }),
          actionLabel: t("highlights.keep"),
          onAction: () => {
            keep(segment);
            dismiss();
          },
        });
      }
      return fastRate;
    },
    [dismiss, fastRate, keep, reasonOf, show, t],
  );

  return {
    /** 生成过（哪怕一段都没有）。 */
    available: query.data != null,
    generating: generate.isPending,
    generateError: generate.isError ? generate.error : null,
    generate: generate.start,
    segments,
    mode,
    strength,
    fastRate,
    notice,
    dismissNotice: dismiss,
    handleTimeUpdate,
    rateFor,
    savedMs: (baseRate: number) => savedMs(segments, mode, baseRate, fastRate),
  };
}
