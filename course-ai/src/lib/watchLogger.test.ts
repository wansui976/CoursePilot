import { describe, expect, it, vi } from "vitest";
import { WatchAccumulator, WatchLogQueue } from "./watchLogger";

/** 用一个可推进的假时钟驱动累加器。 */
function fakeClock(start = 0) {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

describe("WatchAccumulator", () => {
  it("accumulates wall-clock time only while playing", () => {
    const clock = fakeClock();
    const acc = new WatchAccumulator(clock.now);

    acc.setPlaying(true);
    clock.advance(5000);
    acc.setPlaying(false); // 暂停：这 5s 计入
    clock.advance(9999); // 暂停期间不计
    expect(acc.drain()).toBe(5000);
  });

  it("系统睡眠那几个小时不算学习时长", () => {
    // 用的是墙上时钟，而睡眠期间我们的代码一行都不跑：合上笔记本一夜，醒来后第一次
    // 结算算出来的是「现在 − 开始播放」，整晚都被记成学习时长。就算播放器在睡眠时
    // 发了暂停事件也救不回来——那个事件同样要等到醒来才被处理。
    let clock = 0;
    const acc = new WatchAccumulator(() => clock, 5 * 60_000);
    acc.setPlaying(true);
    clock += 8 * 60 * 60_000; // 睡了八小时
    acc.setPlaying(false);

    expect(acc.drain()).toBe(5 * 60_000);
  });

  it("不封顶时长期后台播放照常计入", () => {
    // 窗口在后台会被节流，一分钟才结算一次——那是真实的观看时间，不能一起砍掉。
    let clock = 0;
    const acc = new WatchAccumulator(() => clock, 5 * 60_000);
    acc.setPlaying(true);
    clock += 90_000;
    acc.setPlaying(false);

    expect(acc.drain()).toBe(90_000);
  });

  it("keeps counting across a drain while still playing", () => {
    const clock = fakeClock();
    const acc = new WatchAccumulator(clock.now);

    acc.setPlaying(true);
    clock.advance(5000);
    expect(acc.drain()).toBe(5000); // 周期 flush，仍在播放
    clock.advance(3000);
    expect(acc.drain()).toBe(3000); // 从上次 drain 继续算
  });

  it("drains to zero once settled and not replaying", () => {
    const clock = fakeClock();
    const acc = new WatchAccumulator(clock.now);

    acc.setPlaying(true);
    clock.advance(2000);
    acc.setPlaying(false);
    expect(acc.drain()).toBe(2000);
    clock.advance(1000);
    expect(acc.drain()).toBe(0); // 已暂停：无新增
  });

  it("ignores redundant play toggles without advancing the clock", () => {
    const clock = fakeClock();
    const acc = new WatchAccumulator(clock.now);

    acc.setPlaying(true);
    acc.setPlaying(true); // 重复 true 不应重置起点、丢失已计时间
    clock.advance(4000);
    expect(acc.drain()).toBe(4000);
  });
});

describe("WatchLogQueue", () => {
  it("retains a failed batch and retries it for the same video", async () => {
    const write = vi
      .fn<(videoId: string, watchedMs: number) => Promise<void>>()
      .mockRejectedValueOnce(new Error("db locked"))
      .mockResolvedValueOnce(undefined);
    const queue = new WatchLogQueue(write);

    await expect(queue.enqueue("v1", 30_000)).rejects.toThrow("db locked");
    expect(queue.pendingMs("v1")).toBe(30_000);

    await queue.retryAll();
    expect(write).toHaveBeenNthCalledWith(2, "v1", 30_000);
    expect(queue.pendingMs("v1")).toBe(0);
  });

  it("keeps failed time isolated from another video's writes", async () => {
    const write = vi
      .fn<(videoId: string, watchedMs: number) => Promise<void>>()
      .mockRejectedValueOnce(new Error("v1 failed"))
      .mockResolvedValue(undefined);
    const queue = new WatchLogQueue(write);

    await expect(queue.enqueue("v1", 5_000)).rejects.toThrow("v1 failed");
    await queue.enqueue("v2", 7_000);

    expect(write).toHaveBeenNthCalledWith(2, "v2", 7_000);
    expect(queue.pendingMs("v1")).toBe(5_000);
    expect(queue.pendingMs("v2")).toBe(0);
  });
});
