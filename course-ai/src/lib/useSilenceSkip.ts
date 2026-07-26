import { useCallback, useEffect, useRef, useState } from "react";
import { ipc } from "@/lib/ipc";
import {
  formatSkipNotice,
  isSkipSilenceEnabled,
  setSkipSilenceEnabled,
  skipTargetMs,
  type SkipRange,
} from "@/lib/silenceSkip";

/** 提示停留多久。够看清「跳过了多少」，又不至于压在画面上碍事。 */
const NOTICE_MS = 2200;

/**
 * 跳停顿的播放器侧接线：管开关、拉区间、在播放中该跳时跳，并给一句提示。
 *
 * 区间只在开关打开后才去后端要——首次要会扫一遍音轨，没打算用的人不该为此等。
 */
export function useSilenceSkip(videoId: string) {
  const [enabled, setEnabled] = useState(isSkipSilenceEnabled);
  const [notice, setNotice] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const rangesRef = useRef<SkipRange[]>([]);
  const noticeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // 换视频就作废上一份区间，免得拿旧视频的时间点在新视频上乱跳。
  useEffect(() => {
    rangesRef.current = [];
  }, [videoId]);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    setLoading(true);
    void ipc.videos
      .skips(videoId)
      .then((ranges) => {
        if (!cancelled) rangesRef.current = ranges;
      })
      .catch(() => {
        // 探测失败（缺 ffmpeg、文件不在）就当没有可跳的段，照常播放。
        if (!cancelled) rangesRef.current = [];
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [enabled, videoId]);

  useEffect(
    () => () => {
      if (noticeTimerRef.current) clearTimeout(noticeTimerRef.current);
    },
    [],
  );

  const showNotice = useCallback((text: string) => {
    setNotice(text);
    if (noticeTimerRef.current) clearTimeout(noticeTimerRef.current);
    noticeTimerRef.current = setTimeout(() => setNotice(null), NOTICE_MS);
  }, []);

  /** 播放器每次 timeupdate 调一次；该跳就跳，并返回是否跳了。 */
  const handleTimeUpdate = useCallback(
    (video: HTMLVideoElement): boolean => {
      if (!enabled || video.paused || video.seeking) return false;
      const target = skipTargetMs(rangesRef.current, video.currentTime * 1000);
      if (target == null) return false;
      const fromMs = video.currentTime * 1000;
      video.currentTime = target / 1000;
      showNotice(formatSkipNotice(fromMs, target));
      return true;
    },
    [enabled, showNotice],
  );

  const toggle = useCallback(() => {
    setEnabled((on) => {
      const next = !on;
      setSkipSilenceEnabled(next);
      if (!next) setNotice(null);
      return next;
    });
  }, []);

  return { enabled, toggle, notice, loading, handleTimeUpdate };
}
