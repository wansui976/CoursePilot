# 视频自动裁黑边 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 播放时自动检测并裁掉视频画面里烧进的黑边（非破坏式、纯前端），并提供切回原画的开关。

**Architecture:** 两个纯函数（`detectBlackBars` 像素扫描 + `cropStyle`/`contentAspect` 渲染换算）放在 `src/lib/blackBars.ts`；一个 React hook `useBlackBarCrop` 用离屏隐藏 `<video>` 采样几帧调纯函数得出裁剪矩形；`VideoPlayer` 集成 hook，用 `overflow:hidden` 包裹层 + 放大负偏移的 `<video>` 把黑边推出视野，并加一个右上角开关。

**Tech Stack:** React 19 + TypeScript, Vitest（jsdom），Tailwind，lucide-react 图标。

---

### Task 1: 像素扫描纯函数 `detectBlackBars`

**Files:**
- Create: `src/lib/blackBars.ts`
- Test: `src/lib/blackBars.test.ts`

- [ ] **Step 1: Write the failing test**

写 `src/lib/blackBars.test.ts`：

```ts
import { describe, expect, it } from "vitest";
import { detectBlackBars, type Insets } from "./blackBars";

/** 造一帧 RGBA 像素：paint(x,y) 返回 [r,g,b]。 */
function makeFrame(
  w: number,
  h: number,
  paint: (x: number, y: number) => [number, number, number],
): Uint8ClampedArray {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const [r, g, b] = paint(x, y);
      data[i] = r;
      data[i + 1] = g;
      data[i + 2] = b;
      data[i + 3] = 255;
    }
  }
  return data;
}

const BLACK: [number, number, number] = [0, 0, 0];
const GRAY: [number, number, number] = [128, 128, 128];

describe("detectBlackBars", () => {
  it("detects top/bottom letterbox bars", () => {
    const data = makeFrame(100, 100, (_x, y) =>
      y < 10 || y >= 90 ? BLACK : GRAY,
    );
    const insets: Insets = detectBlackBars(data, 100, 100);
    expect(insets.top).toBeCloseTo(0.1, 5);
    expect(insets.bottom).toBeCloseTo(0.1, 5);
    expect(insets.left).toBe(0);
    expect(insets.right).toBe(0);
  });

  it("detects left/right pillarbox bars", () => {
    const data = makeFrame(100, 100, (x, _y) =>
      x < 10 || x >= 90 ? BLACK : GRAY,
    );
    const insets = detectBlackBars(data, 100, 100);
    expect(insets.left).toBeCloseTo(0.1, 5);
    expect(insets.right).toBeCloseTo(0.1, 5);
    expect(insets.top).toBe(0);
    expect(insets.bottom).toBe(0);
  });

  it("returns no insets for a clean frame", () => {
    const data = makeFrame(100, 100, () => GRAY);
    expect(detectBlackBars(data, 100, 100)).toEqual({
      top: 0,
      right: 0,
      bottom: 0,
      left: 0,
    });
  });

  it("does not crop an all-black frame (over-MAX guard)", () => {
    const data = makeFrame(100, 100, () => BLACK);
    expect(detectBlackBars(data, 100, 100)).toEqual({
      top: 0,
      right: 0,
      bottom: 0,
      left: 0,
    });
  });

  it("tolerates a few outlier bright pixels inside a black bar", () => {
    const data = makeFrame(100, 100, (x, y) => {
      const inBar = y < 10 || y >= 90;
      if (inBar && x === 0) return [255, 255, 255]; // 1% 离群点
      return inBar ? BLACK : GRAY;
    });
    expect(detectBlackBars(data, 100, 100).top).toBeCloseTo(0.1, 5);
  });

  it("ignores a sub-threshold 1px bar (under MIN guard)", () => {
    const data = makeFrame(100, 100, (_x, y) => (y < 1 ? BLACK : GRAY));
    expect(detectBlackBars(data, 100, 100).top).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node_modules/.bin/vitest run src/lib/blackBars.test.ts`
Expected: FAIL —「Failed to resolve import "./blackBars"」/ `detectBlackBars is not a function`。

> 若报 rollup 原生二进制缺失（`Cannot find module '@rollup/rollup-linux-arm64-gnu'`），先修复：
> `CI=true pnpm install --store-dir /workspace/.pnpm-store/v10 --offline` 然后
> `ln -sfn ../.pnpm/@rollup+rollup-linux-arm64-gnu@4.60.4/node_modules/@rollup/rollup-linux-arm64-gnu node_modules/@rollup/rollup-linux-arm64-gnu`

- [ ] **Step 3: Write minimal implementation**

写 `src/lib/blackBars.ts`：

```ts
/** 四边黑边占比（0~1）。 */
export interface Insets {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export const NO_INSETS: Insets = { top: 0, right: 0, bottom: 0, left: 0 };

// 三通道都 ≤ 此值才算「黑」（通道级判定，避免把深色内容误判成黑边）。
const BLACK_LEVEL = 16;
// 一行/列里允许超阈值的离群像素比例（容忍噪点、角标）。
const OUTLIER_FRAC = 0.02;
// 黑边占比下限：低于此值视为 0（避免 1~2px 抖动裁剪）。
const MIN_INSET = 0.015;
// 黑边占比上限：高于此值视为异常（整帧偏暗等），该边不裁。
const MAX_INSET = 0.4;

function isBlack(data: Uint8ClampedArray, i: number): boolean {
  return (
    data[i] <= BLACK_LEVEL &&
    data[i + 1] <= BLACK_LEVEL &&
    data[i + 2] <= BLACK_LEVEL
  );
}

function rowIsBlack(data: Uint8ClampedArray, w: number, y: number): boolean {
  let nonBlack = 0;
  const limit = w * OUTLIER_FRAC;
  for (let x = 0; x < w; x++) {
    if (!isBlack(data, (y * w + x) * 4) && ++nonBlack > limit) return false;
  }
  return true;
}

function colIsBlack(
  data: Uint8ClampedArray,
  w: number,
  h: number,
  x: number,
): boolean {
  let nonBlack = 0;
  const limit = h * OUTLIER_FRAC;
  for (let y = 0; y < h; y++) {
    if (!isBlack(data, (y * w + x) * 4) && ++nonBlack > limit) return false;
  }
  return true;
}

/** 把「连续黑行/列数 / 总数」换算成最终占比，套用上下限保护。 */
function toInset(blackCount: number, total: number): number {
  const frac = blackCount / total;
  if (frac < MIN_INSET || frac > MAX_INSET) return 0;
  return frac;
}

/** 扫描一帧 RGBA 像素，返回四边黑边占比。 */
export function detectBlackBars(
  data: Uint8ClampedArray,
  w: number,
  h: number,
): Insets {
  let top = 0;
  while (top < h && rowIsBlack(data, w, top)) top++;
  let bottom = 0;
  while (bottom < h && rowIsBlack(data, w, h - 1 - bottom)) bottom++;
  let left = 0;
  while (left < w && colIsBlack(data, w, h, left)) left++;
  let right = 0;
  while (right < w && colIsBlack(data, w, h, w - 1 - right)) right++;

  return {
    top: toInset(top, h),
    bottom: toInset(bottom, h),
    left: toInset(left, w),
    right: toInset(right, w),
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node_modules/.bin/vitest run src/lib/blackBars.test.ts`
Expected: PASS（6 个用例全过）。

- [ ] **Step 5: Commit**

```bash
git add src/lib/blackBars.ts src/lib/blackBars.test.ts
git commit -m "feat(player): detectBlackBars pixel scan for letterbox/pillarbox"
```

---

### Task 2: 渲染换算纯函数 `cropStyle` 与 `contentAspect`

**Files:**
- Modify: `src/lib/blackBars.ts`（追加导出）
- Test: `src/lib/blackBars.test.ts`（追加用例）

- [ ] **Step 1: Write the failing test**

在 `src/lib/blackBars.test.ts` 顶部 import 改为：

```ts
import {
  contentAspect,
  cropStyle,
  detectBlackBars,
  NO_INSETS,
  type Insets,
} from "./blackBars";
```

在文件末尾追加：

```ts
describe("cropStyle", () => {
  it("fills the stage box exactly when there is no crop", () => {
    const s = cropStyle({ width: 1280, height: 720 }, NO_INSETS);
    expect(s.width).toBe(1280);
    expect(s.height).toBe(720);
    expect(s.left).toBe(0);
    expect(s.top).toBe(0);
    expect(s.position).toBe("absolute");
  });

  it("scales and offsets to push letterbox bars out of view, no distortion", () => {
    const crop: Insets = { top: 0.1, right: 0, bottom: 0.1, left: 0 };
    const s = cropStyle({ width: 1280, height: 720 }, crop);
    // height 放大到 720 / 0.8 = 900，宽不变，向上偏移 -900*0.1 = -90。
    expect(s.width).toBe(1280);
    expect(s.height).toBeCloseTo(900, 5);
    expect(s.top).toBeCloseTo(-90, 5);
    expect(s.left).toBe(0);
  });
});

describe("contentAspect", () => {
  it("returns the raw aspect when there is no crop", () => {
    expect(contentAspect(16 / 9, NO_INSETS)).toBeCloseTo(16 / 9, 5);
  });

  it("widens the aspect for letterbox (top/bottom) crop", () => {
    const crop: Insets = { top: 0.1, right: 0, bottom: 0.1, left: 0 };
    expect(contentAspect(16 / 9, crop)).toBeCloseTo((16 / 9) / 0.8, 5);
  });

  it("narrows the aspect for pillarbox (left/right) crop", () => {
    const crop: Insets = { top: 0, right: 0.1, bottom: 0, left: 0.1 };
    expect(contentAspect(16 / 9, crop)).toBeCloseTo((16 / 9) * 0.8, 5);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node_modules/.bin/vitest run src/lib/blackBars.test.ts`
Expected: FAIL —「cropStyle is not a function」/「contentAspect is not a function」。

- [ ] **Step 3: Write minimal implementation**

在 `src/lib/blackBars.ts` 顶部加 import，并在文件末尾追加两个函数：

文件第一行加：

```ts
import type { CSSProperties } from "react";
```

文件末尾追加：

```ts
export interface Box {
  width: number;
  height: number;
}

/**
 * 把裁剪矩形换算成 `<video>` 的绝对定位样式：放大并负偏移，使内容区正好铺满
 * 尺寸为 stageBox 的 `overflow:hidden` 包裹层，黑边被推出视野。
 * 无裁剪时即 width=stageBox.width、height=stageBox.height、零偏移（等价原渲染）。
 * width/height 比值恒等于原视频固有比例，故纯裁剪、零拉伸。
 */
export function cropStyle(stageBox: Box, crop: Insets): CSSProperties {
  const denomW = 1 - crop.left - crop.right;
  const denomH = 1 - crop.top - crop.bottom;
  const width = stageBox.width / denomW;
  const height = stageBox.height / denomH;
  return {
    position: "absolute",
    left: -width * crop.left,
    top: -height * crop.top,
    width,
    height,
  };
}

/** 裁剪后内容区的宽高比 = 原比例 × (1-左-右) / (1-上-下)。 */
export function contentAspect(videoAspect: number, crop: Insets): number {
  const w = 1 - crop.left - crop.right;
  const h = 1 - crop.top - crop.bottom;
  return (videoAspect * w) / h;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node_modules/.bin/vitest run src/lib/blackBars.test.ts`
Expected: PASS（含新增 cropStyle/contentAspect 共 5 个用例）。

- [ ] **Step 5: Commit**

```bash
git add src/lib/blackBars.ts src/lib/blackBars.test.ts
git commit -m "feat(player): cropStyle + contentAspect render math for black-bar crop"
```

---

### Task 3: 检测 hook `useBlackBarCrop`

**Files:**
- Create: `src/components/VideoPlayer/useBlackBarCrop.ts`
- Test: `src/components/VideoPlayer/useBlackBarCrop.test.tsx`

- [ ] **Step 1: Write the failing test**

在 jsdom 里没有真正的视频解码 / canvas 2d，检测会优雅失败回退到无黑边——本测试覆盖这条兜底路径（hook 不抛错、初值为无黑边）。

写 `src/components/VideoPlayer/useBlackBarCrop.test.tsx`：

```ts
import { renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useBlackBarCrop } from "./useBlackBarCrop";

describe("useBlackBarCrop", () => {
  it("returns no bars synchronously and never throws in jsdom", () => {
    const { result } = renderHook(() => useBlackBarCrop("asset://fake.mp4"));
    expect(result.current.hasBars).toBe(false);
    expect(result.current.crop).toEqual({
      top: 0,
      right: 0,
      bottom: 0,
      left: 0,
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node_modules/.bin/vitest run src/components/VideoPlayer/useBlackBarCrop.test.tsx`
Expected: FAIL —「Failed to resolve import "./useBlackBarCrop"」。

- [ ] **Step 3: Write minimal implementation**

写 `src/components/VideoPlayer/useBlackBarCrop.ts`：

```ts
import { useEffect, useState } from "react";
import { detectBlackBars, type Insets, NO_INSETS } from "@/lib/blackBars";

const SAMPLE_W = 160; // 缩略宽，检测足够且开销极低
const FALLBACK_TIMES = [2, 5, 10]; // 拿不到 duration 时的固定采样点（秒）

/** 取每条边在多帧里的最小黑边（暗场景会误报，取最小绝不误切内容）。 */
function minInsets(frames: Insets[]): Insets {
  return frames.reduce(
    (acc, f) => ({
      top: Math.min(acc.top, f.top),
      right: Math.min(acc.right, f.right),
      bottom: Math.min(acc.bottom, f.bottom),
      left: Math.min(acc.left, f.left),
    }),
    { top: 1, right: 1, bottom: 1, left: 1 },
  );
}

/** seek 到 t 秒并在 seeked 后把当前帧画进 canvas，取像素跑 detectBlackBars。 */
function sampleAt(
  video: HTMLVideoElement,
  ctx: CanvasRenderingContext2D,
  canvas: HTMLCanvasElement,
  t: number,
): Promise<Insets | null> {
  return new Promise((resolve) => {
    const onSeeked = () => {
      video.removeEventListener("seeked", onSeeked);
      try {
        const vw = video.videoWidth || SAMPLE_W;
        const vh = video.videoHeight || Math.round(SAMPLE_W * 0.5625);
        const cw = SAMPLE_W;
        const ch = Math.max(1, Math.round((SAMPLE_W * vh) / vw));
        canvas.width = cw;
        canvas.height = ch;
        ctx.drawImage(video, 0, 0, cw, ch);
        const { data } = ctx.getImageData(0, 0, cw, ch);
        resolve(detectBlackBars(data, cw, ch));
      } catch {
        resolve(null); // 跨域污染 / 取帧失败 → 放弃这帧
      }
    };
    video.addEventListener("seeked", onSeeked);
    try {
      video.currentTime = t;
    } catch {
      video.removeEventListener("seeked", onSeeked);
      resolve(null);
    }
  });
}

/**
 * 用离屏隐藏 <video> 加载同一 src，采样靠前的几帧检测黑边。
 * 任何失败都回退到无黑边，播放器走原行为。每个 src 仅检测一次。
 */
export function useBlackBarCrop(src: string): {
  crop: Insets;
  hasBars: boolean;
} {
  const [crop, setCrop] = useState<Insets>(NO_INSETS);

  useEffect(() => {
    setCrop(NO_INSETS);
    if (!src) return;
    let cancelled = false;

    const video = document.createElement("video");
    video.muted = true;
    video.preload = "auto";
    video.crossOrigin = "anonymous";
    video.src = src;

    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d");
    if (!ctx) return; // jsdom 等无 2d 上下文 → 维持无黑边

    const run = async () => {
      const dur = video.duration;
      const times =
        Number.isFinite(dur) && dur > 0
          ? [0.25, 0.5, 0.75].map((f) => dur * f)
          : FALLBACK_TIMES;
      const frames: Insets[] = [];
      for (const t of times) {
        if (cancelled) return;
        const f = await sampleAt(video, ctx, canvas, t);
        if (f) frames.push(f);
      }
      if (cancelled || frames.length === 0) return;
      setCrop(minInsets(frames));
    };

    const onMeta = () => void run();
    video.addEventListener("loadedmetadata", onMeta);

    return () => {
      cancelled = true;
      video.removeEventListener("loadedmetadata", onMeta);
      video.removeAttribute("src");
      video.load();
    };
  }, [src]);

  const hasBars =
    crop.top > 0 || crop.right > 0 || crop.bottom > 0 || crop.left > 0;
  return { crop, hasBars };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node_modules/.bin/vitest run src/components/VideoPlayer/useBlackBarCrop.test.tsx`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add src/components/VideoPlayer/useBlackBarCrop.ts src/components/VideoPlayer/useBlackBarCrop.test.tsx
git commit -m "feat(player): useBlackBarCrop hook samples frames to detect bars"
```

---

### Task 4: 在 `VideoPlayer` 里集成裁剪与开关

**Files:**
- Modify: `src/components/VideoPlayer/index.tsx`

无独立单测：`VideoPlayer` 依赖 Zustand store、ipc、Tauri window，整体渲染测试脆弱；裁剪逻辑已全部由 Task 1/2/3 的纯函数与 hook 覆盖。本任务靠 `tsc` 类型检查 + 全量 vitest 回归 + 手动验证把关。

- [ ] **Step 1: 引入依赖与 hook**

在 `src/components/VideoPlayer/index.tsx` 顶部 import 区追加（与现有 import 同风格）：

```ts
import { Crop } from "lucide-react";
import { contentAspect, cropStyle, NO_INSETS } from "@/lib/blackBars";
import { useBlackBarCrop } from "./useBlackBarCrop";
```

在组件内、`const [videoAspect, setVideoAspect] = useState(16 / 9);` 之后追加：

```ts
  const { crop, hasBars } = useBlackBarCrop(src);
  const [cropEnabled, setCropEnabled] = useState(true);
  // 检测到黑边即默认开启；换视频 / 检测结果变化时复位为新视频的判定。
  useEffect(() => {
    setCropEnabled(hasBars);
  }, [src, hasBars]);
  const activeCrop = cropEnabled ? crop : NO_INSETS;
```

- [ ] **Step 2: 用 activeCrop 修正舞台宽高比**

把现有：

```ts
  const aspect = videoAspect > 0 ? videoAspect : 16 / 9;
```

改为：

```ts
  const aspect = contentAspect(videoAspect > 0 ? videoAspect : 16 / 9, activeCrop);
```

- [ ] **Step 3: 用 cropStyle 渲染 `<video>` 并加开关按钮**

把现有 `<video ... className="h-full w-full bg-black object-contain" style={{ transform... }}>` 这段的 `className` 与 `style` 改为：

```tsx
            className={stageBox ? "bg-black" : "h-full w-full bg-black object-contain"}
            // 提升到独立 GPU 合成层：暂停后让这一帧留在自己的层上，减少回退到
            // 「栅格化再缩放」的软化；backface-visibility 进一步固定层、避免半像素抖动。
            // stageBox 就绪时叠加 cropStyle（绝对定位 + 放大负偏移）把黑边推出包裹层；
            // 无裁剪时 cropStyle 等价于铺满 stageBox，与原渲染一致。
            style={{
              transform: "translateZ(0)",
              willChange: "transform",
              backfaceVisibility: "hidden",
              ...(stageBox ? cropStyle(stageBox, activeCrop) : {}),
            }}
```

然后在 `{captionsOn && caption && (...)}` 这段之后、舞台 `</div>` 之前，追加开关按钮：

```tsx
          {hasBars && (
            <button
              type="button"
              aria-label={cropEnabled ? "显示原画（还原黑边）" : "裁掉黑边"}
              title={cropEnabled ? "显示原画（还原黑边）" : "裁掉黑边"}
              onClick={() => setCropEnabled((v) => !v)}
              className={`absolute right-2 top-2 z-10 flex h-8 w-8 items-center justify-center rounded-lg text-white/90 transition hover:bg-white/10 hover:text-white ${
                cropEnabled ? "bg-black/40" : "bg-black/20"
              }`}
            >
              <Crop className="h-4 w-4" />
            </button>
          )}
```

- [ ] **Step 4: 类型检查与全量回归**

Run: `node_modules/.bin/tsc --noEmit`
Expected: 退出码 0，无报错。

Run: `node_modules/.bin/vitest run src/lib/blackBars.test.ts src/components/VideoPlayer/useBlackBarCrop.test.tsx`
Expected: 全部 PASS。

- [ ] **Step 5: Commit**

```bash
git add src/components/VideoPlayer/index.tsx
git commit -m "feat(player): auto-crop black bars on playback with a toggle"
```

---

## 自查（Self-Review）

- **Spec 覆盖**：`detectBlackBars`（Task 1）↔ 采样与阈值；`cropStyle`/`contentAspect`（Task 2）↔ 渲染数学；`useBlackBarCrop`（Task 3）↔ hook 与采样时间点/多帧最小/兜底；`VideoPlayer` 集成 + 开关（Task 4）↔ 播放器集成与开关。全部命中。
- **类型一致**：`Insets`/`NO_INSETS`/`Box` 在各任务签名一致；hook 返回 `{ crop, hasBars }` 与集成处解构一致；`cropStyle` 返回 `CSSProperties` 与 `<video>` style 展开一致。
- **占位符**：无 TODO/TBD，所有步骤含完整代码与命令。
