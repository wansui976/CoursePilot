# 视频自动裁黑边（非破坏式）

> **2026-06-05 方案修订**：**检测**从「前端 canvas 逐帧扫描」改为「后端 **ffmpeg `cropdetect`**」。
> 原因：播放器走本地 HTTP 媒体服务（`http://127.0.0.1`，与应用跨源），离屏 `<video>` + canvas
> 读像素受 CORS 限制、且对非方形像素(SAR)视频不稳。改为**导入/下载时**用 ffmpeg cropdetect
> 探测一次，把四边占比 insets（0~1）写入 `videos` 表（迁移 `0010_crop.sql`），播放器从视频记录
> 读出 insets，**复用原有 `cropStyle`/`contentAspect` 显示裁剪**（渲染层不变，仍非破坏式、带开关）。
>
> 落地要点：
> - 后端 `pipeline/crop_detect.rs`：`detect_crop`(跑 ffmpeg cropdetect 采样一段) +
>   `parse_cropdetect`(解析整帧分辨率与最后一个 `crop=W:H:X:Y` → insets) + `detect_and_store_crop`(写库)。
>   cropdetect 在时间窗内累积非黑包围盒，天然保守、不误切内容；insets 为比例，与 SAR 无关。
> - `commands/videos.rs::apply_detected_crop` 在 `cmd_add_local_video` 与 `cmd_import_bilibili` 末尾调用。
> - 前端：`Video` 增 `crop_top/right/bottom/left`；`Home` 把 insets 作 `crop` prop 传给 `VideoPlayer`；
>   删除前端 canvas 检测（`useBlackBarCrop`、`detectBlackBars`），保留 `cropStyle`/`contentAspect`/`Insets`。
> - 渲染修复仍生效：`object-fit: fill` 防 SAR 视频内部补黑；开关移入播放栏「裁黑边」文字按钮。
>
> 下文为初版（前端 canvas 检测）设计，渲染/开关部分仍适用，检测部分以本修订为准。

---

# 视频自动裁黑边（非破坏式、前端实现 — 初版，检测部分已被上方修订取代）

## 背景与目标

部分课程视频（尤其 B 站下载、录屏转制）画面里**烧进了黑边**（上下 letterbox 或左右 pillarbox）。
目标：播放时自动把黑边裁掉，让有效画面铺满播放区；**不重新编码、不改原文件**，并提供开关随时切回原画。

非目标：

- 不做破坏式重编码（明确排除，避免画质损失与等待）。
- 不写后端 / 数据库 / 迁移（纯前端，对所有视频——含未跑流水线的本地导入——即时生效）。
- 不持久化开关偏好（首版只做会话内状态，后续可加）。

## 整体结构

纯前端，三个互相解耦、可独立单测的单元：

1. **`detectBlackBars(data, w, h) → Insets`**（纯函数）
   输入一帧缩略图像素（`Uint8ClampedArray` RGBA + 宽高），从四边向内扫描「整行/整列接近纯黑」，
   输出四边黑边占比 `Insets = { top, right, bottom, left }`（各为 0~1 小数）。不碰 DOM。

2. **`useBlackBarCrop(src) → { crop: Insets, hasBars: boolean }`**（React hook）
   每个视频 `src` 跑一次：用**离屏隐藏 `<video>`**（不打扰主播放器）加载同一 `src`，
   seek 到靠前的多个时间点采样 2~3 帧，画到小 canvas 取像素，逐帧调 `detectBlackBars`，
   **每条边取多帧最小黑边**，得到最终 `crop`；任意边 > 0 则 `hasBars=true`。

3. **`cropStyle(stageBox, crop) → { wrapperStyle, videoStyle }`**（纯函数）
   把裁剪矩形换算成渲染样式（见「渲染数学」）。

## 渲染数学

黑边烧进画面，`videoWidth/videoHeight` 含黑边。设四边占比 `L,R,T,B`，
内容占比为宽 `(1-L-R)`、高 `(1-T-B)`。

做法：**`overflow:hidden` 包裹层 + 放大并负偏移的 `<video>`，让内容区铺满包裹层**。

- 包裹层尺寸 = `stageBox`，其 `aspect` 改用**内容宽高比**：
  `contentAspect = videoW(1-L-R) / videoH(1-T-B)`。
- `<video>` 样式：
  - `width  = stageBox.width  / (1 - L - R)`
  - `height = stageBox.height / (1 - T - B)`
  - `left   = -width  * L`
  - `top    = -height * T`

**零变形证明**：上式 `width/height` 比值 = `videoW/videoH`（原视频固有比例），
故视频等比放大，仅把黑边推出 `overflow:hidden` 之外，纯裁剪、无拉伸。

**无裁剪等价原行为**：`L=R=T=B=0` → `width=stageBox.width`、`height=stageBox.height`、偏移 0，
与现有渲染逐像素一致，不引入回归。

叠加层（overlay/标注）继续锚定 `stageBox`，自动对齐裁剪后的画面。

## 播放器集成与开关（`VideoPlayer/index.tsx`）

- 调 `useBlackBarCrop(src)` 取 `{ crop, hasBars }`。
- 本地 state `cropEnabled`，**默认 = `hasBars`**；`src` 变化时重置为新视频的 `hasBars`。
- `activeCrop = cropEnabled ? crop : 零边`。
- `stageBox` 的 `aspect` 由「裸 `videoAspect`」改为按 `activeCrop` 修正的 `contentAspect`。
- 渲染：现有 `<video>` 外套一层 `overflow:hidden` 包裹层（尺寸 = `stageBox`），
  `<video>` 套用 `cropStyle` 的样式；`activeCrop` 为零边时该层无副作用。
- **开关按钮**：仅 `hasBars` 时显示，置于播放器控制条/右上角，图标 `Crop`（lucide），
  点按在裁剪/原画间切换，tooltip「裁掉黑边 ↔ 显示原画」。
- 开关为会话内本地 state，不持久化。

## 采样与安全阈值

- **采样时间点**：避开片头黑屏，取 `duration * [0.25, 0.5, 0.75]`；
  拿不到 duration 时退化为固定 `[2s, 5s, 10s]`。每点 seek 隐屏 video，`seeked` 后画帧。
- **缩略尺寸**：约 160×90 小 canvas，检测足够且开销极低。
- **整行/列算黑**：该行/列像素 luma 几乎都 `< 16/255` 才算黑边；
  允许 ≤2% 像素离群超阈值（容忍噪点/角标）。
- **每边取多帧最小黑边**：三帧同一边取最小占比——暗场景会误报大黑边，取最小可保证
  「只裁所有采样帧都一致为黑的部分」，绝不误切内容。
- **下限**：某边 `< 1.5%` 视为 0（避免 1~2px 抖动裁剪）。
- **上限保护**：某边 `> 40%` 视为异常（整帧偏暗等）→ 该边记 0 不裁。
- **失败兜底**：取帧失败 / canvas 被污染 / 读不到像素 → 返回零边（无黑边），播放器走原行为，不报错。

## 测试（Vitest，纯函数为主）

- `detectBlackBars`：合成 `ImageData`——上下黑边、左右黑边、无黑边、整帧全黑（上限保护→不裁）、
  含离群亮点的黑边行（仍判黑）。断言四边占比。
- `cropStyle`：无裁剪 = `stageBox` 原样且零偏移；letterbox 时 `width/height` 比值 == 原视频比例
  （验证零变形）、偏移为负、包裹层为内容比例。
- hook：核心逻辑都在两个纯函数里覆盖；hook 的取帧/seek 用轻量 mock 或留作集成测试。

## 文件改动清单

- 新增 `src/lib/blackBars.ts`：`detectBlackBars`、`cropStyle`、类型 `Insets`。
- 新增 `src/lib/blackBars.test.ts`：上述纯函数测试。
- 新增 `src/components/VideoPlayer/useBlackBarCrop.ts`：检测 hook。
- 改 `src/components/VideoPlayer/index.tsx`：集成 hook、包裹层、开关按钮。
