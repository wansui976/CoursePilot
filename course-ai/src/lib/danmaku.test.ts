import { describe, expect, it } from "vitest";
import {
  DanmakuEngine,
  SCROLL_TRAVEL_MS,
  SPAWN_TOLERANCE_MS,
  firstIndexAtOrAfter,
  type DanmakuGeometry,
} from "./danmaku";
import type { DanmakuEntry } from "./types";

function entry(overrides: Partial<DanmakuEntry> = {}): DanmakuEntry {
  return {
    mode: "scroll",
    start_ms: 1000,
    text: "测试弹幕",
    color: null,
    font_size: null,
    ...overrides,
  };
}

// 固定测宽：每字符 10px，方便断言滚动位置。
const GEOMETRY: DanmakuGeometry = {
  width: 800,
  height: 600,
  laneHeight: 34,
  scrollLanes: 10,
  staticLanes: 5,
  measure: (text) => text.length * 10,
};

describe("firstIndexAtOrAfter", () => {
  const entries = [entry({ start_ms: 10 }), entry({ start_ms: 20 }), entry({ start_ms: 30 })];

  it("finds the first entry at or after the given time", () => {
    expect(firstIndexAtOrAfter(entries, 0)).toBe(0);
    expect(firstIndexAtOrAfter(entries, 15)).toBe(1);
    expect(firstIndexAtOrAfter(entries, 20)).toBe(1);
    expect(firstIndexAtOrAfter(entries, 31)).toBe(3);
  });

  it("handles an empty list", () => {
    expect(firstIndexAtOrAfter([], 100)).toBe(0);
  });
});

describe("DanmakuEngine", () => {
  it("spawns entries whose time has come and reports them as active", () => {
    const engine = new DanmakuEngine([entry({ start_ms: 1000 })]);
    engine.advance(900, GEOMETRY);
    expect(engine.active).toHaveLength(0);

    engine.advance(1000, GEOMETRY);
    expect(engine.active).toHaveLength(1);
    expect(engine.active[0].entry.text).toBe("测试弹幕");
    expect(engine.active[0].bornMs).toBe(1000);
  });

  it("drops entries that missed their spawn window instead of back-flooding", () => {
    const engine = new DanmakuEngine([entry({ start_ms: 1000 })]);
    // 一次 tick 迟到太多（如后台标签页恢复）：直接跳过，不发射。
    engine.advance(1000 + SPAWN_TOLERANCE_MS + 1, GEOMETRY);
    expect(engine.active).toHaveLength(0);
  });

  it("assigns different lanes to simultaneous entries and drops the overflow", () => {
    const entries = Array.from({ length: GEOMETRY.scrollLanes + 3 }, (_, i) =>
      entry({ start_ms: 1000, text: `弹幕${i}` }),
    );
    const engine = new DanmakuEngine(entries);
    engine.advance(1000, GEOMETRY);

    expect(engine.active).toHaveLength(GEOMETRY.scrollLanes);
    const lanes = new Set(engine.active.map((item) => item.lane));
    expect(lanes.size).toBe(GEOMETRY.scrollLanes);
  });

  it("frees a scroll lane only after the previous item has fully crossed", () => {
    const narrow: DanmakuGeometry = { ...GEOMETRY, scrollLanes: 1 };
    const engine = new DanmakuEngine([
      entry({ start_ms: 1000 }),
      entry({ start_ms: 5000 }),
      entry({ start_ms: 9200 }),
    ]);
    engine.advance(1000, narrow);
    // 按正常播放节奏推进（步长 <1500ms，不触发 seek 重置）。
    for (let t = 1800; t <= 5000; t += 800) {
      engine.advance(t, narrow);
    }
    // 唯一轨道还被第一条占着（没走完横穿时长）：第二条被丢弃，不排队。
    expect(engine.active).toHaveLength(1);

    for (let t = 5800; t <= 9200; t += 850) {
      engine.advance(t, narrow);
    }
    // 9200ms 处第三条入场：轨道已在 9000ms 空出来。
    expect(engine.active).toHaveLength(1);
    expect(engine.active[0].entry.start_ms).toBe(9200);
  });

  it("expires top and bottom entries after their display duration", () => {
    const engine = new DanmakuEngine([
      entry({ start_ms: 1000, mode: "top" }),
      entry({ start_ms: 1000, mode: "bottom" }),
    ]);
    engine.advance(1000, GEOMETRY);
    expect(engine.active).toHaveLength(2);

    // 按正常播放节奏推进（步长 <1500ms，不触发 seek 重置）到接近停留时长末尾。
    for (let t = 1500; t <= 5000; t += 500) {
      engine.advance(t, GEOMETRY);
    }
    expect(engine.active).toHaveLength(2);

    engine.advance(5500, GEOMETRY);
    expect(engine.active).toHaveLength(0);
  });

  it("clears the stage and reschedules from the new position after a seek back", () => {
    const engine = new DanmakuEngine([
      entry({ start_ms: 1000 }),
      entry({ start_ms: 60_000 }),
    ]);
    engine.advance(60_000, GEOMETRY);
    expect(engine.active).toHaveLength(1);

    // 跳回开头：场上清空，1s 处的弹幕重新按期发射。
    engine.advance(500, GEOMETRY);
    expect(engine.active).toHaveLength(0);
    engine.advance(1000, GEOMETRY);
    expect(engine.active).toHaveLength(1);
    expect(engine.active[0].entry.start_ms).toBe(1000);
  });

  it("treats a big forward jump as a seek and skips the danmaku in between", () => {
    const engine = new DanmakuEngine([
      entry({ start_ms: 1000 }),
      entry({ start_ms: 30_000 }),
    ]);
    engine.advance(1000, GEOMETRY);
    expect(engine.active).toHaveLength(1);

    engine.advance(60_000, GEOMETRY);
    expect(engine.active).toHaveLength(0);

    engine.advance(90_000 + SCROLL_TRAVEL_MS, GEOMETRY);
    // 60s 处没有弹幕；再往后没有更多弹幕，场上保持为空。
    expect(engine.active).toHaveLength(0);
  });

  it("does not treat normal playback ticks as seeks", () => {
    const engine = new DanmakuEngine([entry({ start_ms: 1000 })]);
    engine.advance(1000, GEOMETRY);
    // 智能倍速 / 2x 长按下的帧间推进（<1500ms）不清场。
    engine.advance(1000 + 800, GEOMETRY);
    expect(engine.active).toHaveLength(1);
  });
});
