import type { DanmakuEntry } from "./types";

// 弹幕排期的纯逻辑：何时发射、占哪条轨道、何时离场。不碰 canvas / DOM，
// 组件只负责按 engine.active 逐帧绘制（见 VideoPlayer/DanmakuOverlay.tsx）。

/** 滚动弹幕从右缘走到左缘离开画面的时长。 */
export const SCROLL_TRAVEL_MS = 8000;
/** 顶部/底部弹幕的停留时长。 */
export const STATIC_SHOW_MS = 4500;
/** 视频时间一帧间跳变超过该值视为 seek（正常播放 tick 只有 ~250ms）。 */
export const SEEK_RESET_MS = 1500;
/** 发射窗口：tick 到达时最多晚这么多毫秒还算「准时」，再晚（如后台标签页）直接丢弃。 */
export const SPAWN_TOLERANCE_MS = 450;

/** 场上的一条活动弹幕。组件按 bornMs/lane/width 算出像素位置来画。 */
export interface ActiveDanmaku {
  entry: DanmakuEntry;
  /** 轨道号：滚动/顶部从上往下数，底部从下往上数。 */
  lane: number;
  /** 出现时的视频时间（ms）。 */
  bornMs: number;
  /** 文本实测宽度（CSS 像素），组件用同一字体测量后传回。 */
  width: number;
}

/** 一帧的画布几何。laneHeight 由组件按字号算好传入。 */
export interface DanmakuGeometry {
  width: number;
  height: number;
  laneHeight: number;
  /** 滚动弹幕可用轨道数（画面上部 ~75% 均分）。 */
  scrollLanes: number;
  /** 顶部/底部各自可用轨道数。 */
  staticLanes: number;
  /** 文本测宽（组件用 ctx.measureText；测试用字符数近似）。 */
  measure: (text: string, fontSize: number) => number;
}

export function compareByStartMs(a: DanmakuEntry, b: DanmakuEntry) {
  return a.start_ms - b.start_ms;
}

/** 二分找第一条 start_ms >= ms 的弹幕下标；没有则返回 length。 */
export function firstIndexAtOrAfter(entries: DanmakuEntry[], ms: number) {
  let lo = 0;
  let hi = entries.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (entries[mid].start_ms < ms) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * 弹幕排期器。持有一条按时间排序的弹幕列表，随视频时间推进：
 * 发射到点的弹幕、分配轨道、剔除离场的。seek（大幅跳变）时清场并重定位。
 *
 * 轨道占用用 busyUntil 记「该轨道到什么视频时间才空出来」：滚动轨道按整段
 * 横穿时长算（上一条完全离场才给下一条用），顶部/底部按停留时长算。
 * 没有空轨道时直接丢弃这条——和 B 站拥挤时丢弹幕一致，不排队（排队会整屏滞后）。
 */
export class DanmakuEngine {
  readonly active: ActiveDanmaku[] = [];
  private entries: DanmakuEntry[];
  private cursor = 0;
  private lastMs: number | null = null;
  private scrollBusyUntil: number[] = [];
  private staticBusyUntil: number[] = [];

  constructor(entries: DanmakuEntry[]) {
    // 防御性排序：后端 ORDER BY start_ms，但组件里重新拼装过（如启用开关切换）。
    this.entries = [...entries].sort(compareByStartMs);
  }

  /** 视频时间推进到 ms（组件每帧调用）。advance 后读 active 绘制。 */
  advance(ms: number, geo: DanmakuGeometry) {
    this.syncSeek(ms);
    this.spawnDue(ms, geo);
    this.cull(ms);
    this.lastMs = ms;
  }

  /** seek 检测：倒退或大步前进都清场重来；从当前时间点起重新排期。 */
  private syncSeek(ms: number) {
    if (
      this.lastMs != null &&
      (ms < this.lastMs - SEEK_RESET_MS || ms > this.lastMs + SEEK_RESET_MS)
    ) {
      this.active.length = 0;
      this.cursor = firstIndexAtOrAfter(this.entries, ms);
      this.scrollBusyUntil = [];
      this.staticBusyUntil = [];
    }
  }

  /** 发射所有「已到点且还在窗口内」的弹幕。窗口外的（后台回来）随 cursor 跳过。 */
  private spawnDue(ms: number, geo: DanmakuGeometry) {
    while (
      this.cursor < this.entries.length &&
      this.entries[this.cursor].start_ms <= ms
    ) {
      const entry = this.entries[this.cursor];
      this.cursor += 1;
      if (entry.start_ms < ms - SPAWN_TOLERANCE_MS) continue;
      this.spawn(entry, ms, geo);
    }
  }

  private spawn(entry: DanmakuEntry, ms: number, geo: DanmakuGeometry) {
    const fontSize = danmakuFontSize(geo.height);
    const width = geo.measure(entry.text, fontSize);
    const scrolling = entry.mode === "scroll";
    const laneCount = Math.max(
      1,
      scrolling ? geo.scrollLanes : geo.staticLanes,
    );
    const busy = scrolling ? this.scrollBusyUntil : this.staticBusyUntil;
    for (let lane = 0; lane < laneCount; lane += 1) {
      if (ms < (busy[lane] ?? 0)) continue;
      busy[lane] = ms + (scrolling ? SCROLL_TRAVEL_MS : STATIC_SHOW_MS);
      this.active.push({ entry, lane, bornMs: ms, width });
      return;
    }
    // 全部轨道都占着：丢弃，不排队。
  }

  /** 剔除已离场（滚动走完）/到时（顶部底部停留结束）的弹幕。 */
  private cull(ms: number) {
    for (let i = this.active.length - 1; i >= 0; i -= 1) {
      const item = this.active[i];
      const life = item.entry.mode === "scroll" ? SCROLL_TRAVEL_MS : STATIC_SHOW_MS;
      if (ms - item.bornMs >= life) {
        this.active.splice(i, 1);
      }
    }
  }
}

/** 弹幕字号随播放器高度缩放（600px 高 ≈ 24px，B 站观感），窄分栏下限 13px。 */
export function danmakuFontSize(stageHeight: number) {
  const scale = Math.min(1.3, Math.max(0.7, stageHeight / 600));
  return Math.round(24 * scale);
}
