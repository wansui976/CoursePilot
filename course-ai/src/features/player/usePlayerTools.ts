import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { useTranslation } from "react-i18next";
import {
  chapterTimer,
  closeLoop,
  loopRestartOnEnd,
  loopSeekTarget,
  minutesTimer,
  sentenceLoop,
  sleepDue,
  stepLoop,
  type AbLoop,
} from "@/lib/abLoop";
import { formatMs } from "@/lib/time";
import type { Chapter, TranscriptSegment } from "@/lib/types";
import { usePlaybackTools } from "@/stores/playbackTools";

const NOTICE_MS = 2200;

function currentMsOf(videoRef: RefObject<HTMLVideoElement | null>) {
  return Math.round((videoRef.current?.currentTime ?? 0) * 1000);
}

export type LoopAction = "start" | "end" | "sentence" | "clear" | "step";
export type SleepChoice = "off" | "chapter" | number;

/**
 * 播放器里的区间复读和定时停止：timeupdate 时问一下要不要跳回起点、要不要停，
 * 动了设置就在画面上方说一句（「复读 01:20 – 01:35」「30 分钟后停止播放」）。
 */
export function usePlayerTools(
  videoRef: RefObject<HTMLVideoElement | null>,
  videoId: string,
  segments: readonly TranscriptSegment[],
  chapters: readonly Chapter[],
) {
  const { t } = useTranslation();
  const loop = usePlaybackTools((s) => s.loop);
  const sleep = usePlaybackTools((s) => s.sleep);
  const [notice, setNotice] = useState<string | null>(null);
  const noticeTimer = useRef(0);

  const say = useCallback((text: string) => {
    window.clearTimeout(noticeTimer.current);
    setNotice(text);
    noticeTimer.current = window.setTimeout(() => setNotice(null), NOTICE_MS);
  }, []);
  useEffect(() => () => window.clearTimeout(noticeTimer.current), []);

  // 别的视频的区间不带过来：换了视频就清掉，菜单里也不会显示一个对不上的区间。
  useEffect(() => {
    const current = usePlaybackTools.getState().loop;
    if (current && current.videoId !== videoId) usePlaybackTools.getState().setLoop(null);
    const timer = usePlaybackTools.getState().sleep;
    if (timer?.kind === "chapter" && timer.videoId !== videoId) {
      usePlaybackTools.getState().setSleep(null);
    }
  }, [videoId]);

  const describeLoop = useCallback(
    (next: AbLoop | null) => {
      if (!next) return t("playbackTools.loopCleared");
      if (next.endMs == null) return t("playbackTools.loopStartSet", { time: formatMs(next.startMs) });
      return t("playbackTools.loopOn", { start: formatMs(next.startMs), end: formatMs(next.endMs) });
    },
    [t],
  );

  const applyLoop = useCallback(
    (action: LoopAction) => {
      const store = usePlaybackTools.getState();
      const current = store.loop?.videoId === videoId ? store.loop : null;
      const now = currentMsOf(videoRef);
      let next: AbLoop | null;
      switch (action) {
        case "step":
          next = stepLoop(current, videoId, now);
          break;
        case "start":
          next =
            current?.endMs != null && now < current.endMs - 500
              ? { ...current, startMs: now }
              : { videoId, startMs: now, endMs: null };
          break;
        case "end":
          next = closeLoop(current ?? { videoId, startMs: 0, endMs: null }, now);
          break;
        case "sentence":
          next = sentenceLoop(segments, videoId, now);
          break;
        case "clear":
          next = null;
          break;
      }
      store.setLoop(next);
      // 定好区间时人多半在终点附近：直接回到起点开始复读。
      const video = videoRef.current;
      if (next?.endMs != null && video && (now >= next.endMs || now < next.startMs || action === "sentence")) {
        video.currentTime = next.startMs / 1000;
        if (video.paused) void video.play();
      }
      say(describeLoop(next));
    },
    [videoId, segments, say, describeLoop, videoRef],
  );

  const applySleep = useCallback(
    (choice: SleepChoice) => {
      const store = usePlaybackTools.getState();
      if (choice === "off") {
        store.setSleep(null);
        say(t("playbackTools.sleepOff"));
        return;
      }
      if (choice === "chapter") {
        const video = videoRef.current;
        const duration = Math.round((video?.duration || 0) * 1000);
        const timer = chapterTimer(chapters, videoId, currentMsOf(videoRef), duration);
        store.setSleep(timer);
        say(
          t("playbackTools.sleepChapterSet", {
            time: formatMs(timer.kind === "chapter" ? timer.endMs : 0),
          }),
        );
        return;
      }
      store.setSleep(minutesTimer(choice));
      say(t("playbackTools.sleepMinutesSet", { count: choice }));
    },
    [chapters, videoId, say, t, videoRef],
  );

  const stopForSleep = useCallback(() => {
    videoRef.current?.pause();
    usePlaybackTools.getState().setSleep(null);
    say(t("playbackTools.sleepFired"));
  }, [say, t, videoRef]);

  // 分钟定时：暂停着也照样走（墙钟），每秒看一次。
  useEffect(() => {
    if (sleep?.kind !== "minutes") return;
    const timer = window.setInterval(() => {
      if (sleepDue(usePlaybackTools.getState().sleep, videoId, 0)) stopForSleep();
    }, 1000);
    return () => window.clearInterval(timer);
  }, [sleep, videoId, stopForSleep]);

  /** 每次 timeupdate 调一下；跳回了起点返回 true（这一轮不再按旧位置记进度）。 */
  const handleTimeUpdate = useCallback(
    (video: HTMLVideoElement) => {
      const ms = video.currentTime * 1000;
      const state = usePlaybackTools.getState();
      if (state.sleep?.kind === "chapter" && sleepDue(state.sleep, videoId, ms)) {
        stopForSleep();
        return false;
      }
      const target = loopSeekTarget(state.loop, videoId, ms);
      if (target == null) return false;
      video.currentTime = target / 1000;
      return true;
    },
    [videoId, stopForSleep],
  );

  /** 播完了：终点贴着片尾的区间从头再来；「本章结束」落在片尾也算到点。 */
  const handleEnded = useCallback(
    (video: HTMLVideoElement) => {
      const state = usePlaybackTools.getState();
      if (state.sleep?.kind === "chapter" && state.sleep.videoId === videoId) {
        stopForSleep();
        return;
      }
      const target = loopRestartOnEnd(state.loop, videoId, video.duration * 1000);
      if (target == null) return;
      video.currentTime = target / 1000;
      void video.play();
    },
    [videoId, stopForSleep],
  );

  return {
    loop: loop?.videoId === videoId ? loop : null,
    sleep: sleep?.kind === "chapter" && sleep.videoId !== videoId ? null : sleep,
    notice,
    applyLoop,
    applySleep,
    handleTimeUpdate,
    handleEnded,
  };
}
