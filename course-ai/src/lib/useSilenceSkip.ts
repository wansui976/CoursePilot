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
 * 但这一扫要好几秒，期间画面上什么都不发生，用户会以为按钮没反应；所以只要是
 * 用户自己点开的，就一路给回执：正在分析 → 找到几段 / 一段都没有。
 */
export function useSilenceSkip(videoId: string) {
  const [enabled, setEnabled] = useState(isSkipSilenceEnabled);
  const [notice, setNotice] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  // ref 供每次 timeupdate 的热路径用，state 供界面（试跳按钮）用。
  const [ranges, setRanges] = useState<SkipRange[]>([]);
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

  // 换视频就作废上一份区间，免得拿旧视频的时间点在新视频上乱跳。
  useEffect(() => {
    rangesRef.current = [];
    setRanges([]);
  }, [videoId]);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    const announce = announceRef.current;
    announceRef.current = false;
    setLoading(true);
    if (announce) showNotice("正在找可跳的停顿…", true);
    void ipc.videos
      .skips(videoId)
      .then((ranges) => {
        if (cancelled) return;
        rangesRef.current = ranges;
        setRanges(ranges);
        if (!announce) return;
        showNotice(
          ranges.length > 0
            ? `跳停顿已开启，可跳过 ${ranges.length} 处停顿`
            : "跳停顿已开启，这个视频没有可跳的停顿",
        );
      })
      .catch(() => {
        // 探测失败（缺 ffmpeg、文件不在）就当没有可跳的段，照常播放。
        if (cancelled) return;
        rangesRef.current = [];
        setRanges([]);
        if (announce) showNotice("停顿分析失败，暂时跳不了");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [enabled, showNotice, videoId]);

  useEffect(() => clearNoticeTimer, []);

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
      if (next) {
        // 分析要好几秒，这句先顶上，免得点了像没反应。
        announceRef.current = true;
        showNotice("正在找可跳的停顿…", true);
      } else {
        showNotice("已关闭跳停顿");
      }
      return next;
    });
  }, [showNotice]);

  return { enabled, toggle, notice, loading, ranges, handleTimeUpdate };
}
