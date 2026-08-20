import { useQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ipc } from "@/lib/ipc";
import { isMobile } from "@/lib/platform";
import {
  isSkipSilenceEnabled,
  setSkipSilenceEnabled,
  silenceSkipQueryKey,
  skipTargetMs,
  type SkipRange,
} from "@/lib/silenceSkip";

/** 提示停留多久。够看清「跳过了多少」，又不至于压在画面上碍事。 */
const NOTICE_MS = 2200;
const EMPTY_RANGES: SkipRange[] = [];

/**
 * 跳停顿的播放器侧接线：管开关、拉区间、在播放中该跳时跳，并给一句提示。
 *
 * 区间只在开关打开后才去后端要——首次要会扫一遍音轨，没打算用的人不该为此等。
 * 但这一扫要好几秒，期间画面上什么都不发生，用户会以为按钮没反应；所以只要是
 * 用户自己点开的，就一路给回执：正在分析 → 找到几段 / 一段都没有。
 */
export function useSilenceSkip(videoId: string) {
  const { t } = useTranslation();
  const available = !isMobile();
  const [enabled, setEnabled] = useState(() => available && isSkipSilenceEnabled());
  const [notice, setNotice] = useState<string | null>(null);
  // ref 供每次 timeupdate 的热路径用，query data 供界面（试跳按钮）用。
  const rangesRef = useRef<SkipRange[]>([]);
  const noticeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // 只有用户亲手点开时才播报分析过程；开着开关切换视频时静悄悄地准备就好。
  const announceRef = useRef(false);

  const clearNoticeTimer = () => {
    if (noticeTimerRef.current) {
      clearTimeout(noticeTimerRef.current);
      noticeTimerRef.current = null;
    }
  };

  /** `persist` 用于「正在分析」这类要一直挂到有结果为止的提示。 */
  const showNotice = useCallback((text: string, persist = false) => {
    clearNoticeTimer();
    setNotice(text);
    if (!persist) {
      noticeTimerRef.current = setTimeout(() => setNotice(null), NOTICE_MS);
    }
  }, []);

  const skipsQuery = useQuery({
    queryKey: silenceSkipQueryKey(videoId),
    queryFn: () => ipc.videos.skips(videoId),
    enabled: enabled && available,
    retry: false,
    // 课件提取完成时由调用方精确 invalidate；平时不要重复扫描或查库。
    staleTime: Infinity,
  });
  const ranges = skipsQuery.data ?? EMPTY_RANGES;

  useEffect(() => {
    rangesRef.current = ranges;
  }, [ranges, videoId]);

  useEffect(() => {
    if (available) return;
    // 桌面上留下的全局偏好不能让移动端长期显示一个实际不可用的开启状态。
    setEnabled(false);
    setSkipSilenceEnabled(false);
  }, [available]);

  useEffect(() => {
    if (!enabled || !available || skipsQuery.isFetching) return;
    if (skipsQuery.isError) {
      announceRef.current = false;
      rangesRef.current = [];
      setEnabled(false);
      setSkipSilenceEnabled(false);
      showNotice(t("videoPlayer.skipSilenceFailed"));
      return;
    }
    if (!skipsQuery.isSuccess || !announceRef.current) return;
    announceRef.current = false;
    showNotice(
      ranges.length > 0
        ? t("videoPlayer.skipSilenceFound", { count: ranges.length })
        : t("videoPlayer.skipSilenceNone"),
    );
  }, [
    available,
    enabled,
    ranges,
    showNotice,
    skipsQuery.isError,
    skipsQuery.isFetching,
    skipsQuery.isSuccess,
    t,
  ]);

  useEffect(() => clearNoticeTimer, []);

  /** 播放器每次 timeupdate 调一次；该跳就跳，并返回是否跳了。 */
  const handleTimeUpdate = useCallback(
    (video: HTMLVideoElement): boolean => {
      if (!enabled || video.paused || video.seeking) return false;
      const target = skipTargetMs(rangesRef.current, video.currentTime * 1000);
      if (target == null) return false;
      const fromMs = video.currentTime * 1000;
      video.currentTime = target / 1000;
      const seconds = Math.max(1, Math.round((target - fromMs) / 1000));
      showNotice(t("videoPlayer.skippedSilence", { count: seconds }));
      return true;
    },
    [enabled, showNotice, t],
  );

  const toggle = useCallback(() => {
    if (!available) {
      setSkipSilenceEnabled(false);
      showNotice(t("videoPlayer.skipSilenceUnsupported"));
      return;
    }
    setEnabled((on) => {
      const next = !on;
      setSkipSilenceEnabled(next);
      if (next) {
        // 分析要好几秒，这句先顶上，免得点了像没反应。
        announceRef.current = true;
        showNotice(t("videoPlayer.skipSilenceFinding"), true);
      } else {
        showNotice(t("videoPlayer.skipSilenceClosed"));
      }
      return next;
    });
  }, [available, showNotice, t]);

  return {
    enabled,
    available,
    toggle,
    notice,
    loading: enabled && skipsQuery.isFetching,
    ranges,
    handleTimeUpdate,
  };
}
