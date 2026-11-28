import { describe, expect, it } from "vitest";
import {
  chapterTimer,
  closeLoop,
  loopRestartOnEnd,
  loopSeekTarget,
  minutesTimer,
  sentenceLoop,
  sleepDue,
  sleepRemainingMs,
  stepLoop,
} from "./abLoop";

describe("stepLoop", () => {
  it("cycles start → end → cleared", () => {
    const a = stepLoop(null, "v", 10_000);
    expect(a).toEqual({ videoId: "v", startMs: 10_000, endMs: null });
    const ab = stepLoop(a, "v", 15_000);
    expect(ab).toEqual({ videoId: "v", startMs: 10_000, endMs: 15_000 });
    expect(stepLoop(ab, "v", 20_000)).toBeNull();
  });

  it("starts over when the loop belongs to another video", () => {
    const other = { videoId: "x", startMs: 1, endMs: 5000 };
    expect(stepLoop(other, "v", 3000)).toEqual({ videoId: "v", startMs: 3000, endMs: null });
  });

  it("swaps ends set backwards and pads too-short loops", () => {
    expect(closeLoop({ videoId: "v", startMs: 9000, endMs: null }, 4000)).toEqual({
      videoId: "v",
      startMs: 4000,
      endMs: 9000,
    });
    expect(closeLoop({ videoId: "v", startMs: 9000, endMs: null }, 9200).endMs).toBe(10_000);
  });
});

describe("loopSeekTarget", () => {
  const loop = { videoId: "v", startMs: 2000, endMs: 6000 };
  it("jumps back only right after crossing the end", () => {
    expect(loopSeekTarget(loop, "v", 5900)).toBeNull();
    expect(loopSeekTarget(loop, "v", 6100)).toBe(2000);
    // 用户自己拖到后面很远：不拽回来。
    expect(loopSeekTarget(loop, "v", 30_000)).toBeNull();
    expect(loopSeekTarget(loop, "other", 6100)).toBeNull();
    expect(loopSeekTarget({ ...loop, endMs: null }, "v", 6100)).toBeNull();
  });

  it("restarts on ended when the loop reaches the tail", () => {
    expect(loopRestartOnEnd({ videoId: "v", startMs: 1000, endMs: 59_500 }, "v", 60_000)).toBe(1000);
    expect(loopRestartOnEnd(loop, "v", 60_000)).toBeNull();
  });
});

describe("sentenceLoop", () => {
  const segments = [
    { start_ms: 0, end_ms: 2000 },
    { start_ms: 2500, end_ms: 2800 },
    { start_ms: 5000, end_ms: 9000 },
  ];
  it("loops the sentence under the playhead", () => {
    expect(sentenceLoop(segments, "v", 6000)).toEqual({ videoId: "v", startMs: 5000, endMs: 9000 });
    // 太短的句子补到 1 秒。
    expect(sentenceLoop(segments, "v", 2600)?.endMs).toBe(3500);
    expect(sentenceLoop([], "v", 0)).toBeNull();
  });
});

describe("sleep timer", () => {
  it("minutes timers fire by wall clock", () => {
    const timer = minutesTimer(15, 1_000);
    expect(sleepDue(timer, "v", 0, 1_000 + 14 * 60_000)).toBe(false);
    expect(sleepDue(timer, "v", 0, 1_000 + 15 * 60_000)).toBe(true);
    expect(sleepRemainingMs(timer, 1_000 + 60_000)).toBe(14 * 60_000);
  });

  it("chapter timers stop at the end of the current chapter", () => {
    const chapters = [
      { start_ms: 0, end_ms: 60_000 },
      { start_ms: 60_000, end_ms: 120_000 },
    ];
    const timer = chapterTimer(chapters, "v", 70_000, 120_000);
    expect(timer).toEqual({ kind: "chapter", videoId: "v", endMs: 120_000 });
    expect(sleepDue(timer, "v", 100_000)).toBe(false);
    expect(sleepDue(timer, "v", 119_900)).toBe(true);
    expect(sleepDue(timer, "w", 119_900)).toBe(false);
    expect(chapterTimer([], "v", 10, 5000)).toEqual({ kind: "chapter", videoId: "v", endMs: 5000 });
  });
});
