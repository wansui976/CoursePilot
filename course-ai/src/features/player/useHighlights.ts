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
export function useHighlights(
  videoId: string,
  { maxRate, baseRate = 1 }: { maxRate?: number; baseRate?: number },
) {
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
  // 用户本来就开着 2x + 智能倍速时，有效倍速可能已经高过快放档；那就别再「快放」到更慢。
  const faster = fastRate > baseRate + 0.001;

  const segmentsRef = useRef(segments);
  segmentsRef.current = segments;
  const modeRef = useRef(mode);
  modeRef.current = mode;
  const fasterRef = useRef(faster);
  fasterRef.current = faster;
  /** seek 序号：每次用户拖进度条 / 按方向键 / 点文稿都 +1（播放器在 onSeeking 里调 noteSeek）。 */
  const seekTokenRef = useRef(0);
  const handledSeekTokenRef = useRef(0);
  /** 用户手动拖进的那一段，放过直到段尾：拖进去就把他弹走，等于「后退失灵」。 */
  const suppressUntilRef = useRef(0);
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
    seekTokenRef.current = 0;
    handledSeekTokenRef.current = 0;
    suppressUntilRef.current = 0;
    setNotice(null);
  }, [videoId]);

  /** 刚发生过一次 seek（用户主动、或我们自己跳的）：下一次 timeupdate 不要当成「自然播进来」。 */
  const noteSeek = useCallback(() => {
    seekTokenRef.current += 1;
  }, []);

  const keep = useCallback(
    (segment: HighlightSegment) => useHighlightPrefs.getState().keep(videoId, segment.start_ms),
    [videoId],
  );
  const reasonOf = useCallback(
    (segment: HighlightSegment) => segment.reason || t(`highlights.kind.${segment.kind}`),
    [t],
  );

  /**
   * 跳过档：自然播进水分段就跳到段尾。跳了返回 true，调用方这一轮不再记进度。
   *
   * 手动 seek（拖进度条、按 ←、点文稿行 / 章节）落进水分段时放行这一次：
   * 否则用户想往回听一段，脚刚落地就被弹走，看起来像「后退失灵」。
   */
  const handleTimeUpdate = useCallback(
    (video: HTMLVideoElement): boolean => {
      if (modeRef.current !== "skip" || video.paused || video.seeking) return false;
      const ms = video.currentTime * 1000;
      // seek 之后的第一帧：位置是用户自己选的。落进水分段就放过这一整段（到段尾为止），
      // 否则他刚拖回去听一句，250ms 后又被弹到段尾。
      if (handledSeekTokenRef.current !== seekTokenRef.current) {
        handledSeekTokenRef.current = seekTokenRef.current;
        suppressUntilRef.current = segmentAt(segmentsRef.current, ms)?.end_ms ?? 0;
        return false;
      }
      if (ms < suppressUntilRef.current) return false;
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

  /** 快放档：此刻该用的倍速；不在水分段、没开快放、或本来就比基础倍速快时返回 null。 */
  const rateFor = useCallback(
    (ms: number): number | null => {
      if (modeRef.current !== "fast" || !fasterRef.current) return null;
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
    /** 播放器在 onSeeking 里调：这一次 seek 之后的第一帧别当自然播放。 */
    noteSeek,
    rateFor,
    savedMs: (baseRate: number) => savedMs(segments, mode, baseRate, fastRate),
  };
}
