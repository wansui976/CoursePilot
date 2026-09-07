# 渐变 + 圆角设计语言（Design Language）

> 2026-09-05 引入。目标：在「苹果式克制与工艺」的基座上，注入一两个可持续复用的
> 独创视觉记忆点，让整套界面高度统一、规范、可控，同时动效丰富、圆角柔和。

本文档是整个应用的**设计语言事实源（source of truth）**。改动界面时先读它，新增
渐变/圆角/动效一律从这里取定义，不要裸写数值。

---

## 1. 设计立场

这套语言是「**两者融合**」：

- **基底 = 苹果式**：系统字体栈、分层灰阶代替硬描边、克制留白、合成器友好的轻动效、
  预先考虑 `prefers-reduced-motion`。
- **独创记忆点 = 双渐变系统**：全应用唯一反复出现的动态渐变（进度 + 品牌），构成
  「学习中」的辨识感。它永远跟随当前强调色派生，所以换强调色后整套语言依然和谐统一。

一切决策优先级（务必遵守）：
1. 跟随用户/产品要求与既有约束；
2. 保留既有品牌与设计系统，除非明确要求改变；
3. 保证任务完成、无障碍、内容清晰、性能；
4. 以上三条满足后，才谈美化。

---

## 2. 圆角尺度（Rounded Corners）

### 2.1 Token 定义

圆角只有**一套**刻度，定义在 `src/globals.css`，分为两层：

| Token | 值 | 用途 |
|---|---|---|
| `--radius-sm` | `8px` | 细分隔/小控件，Tailwind `rounded-sm` |
| `--radius-md` | `10px` | 常规控件，Tailwind `rounded-md` |
| `--radius-lg` | `14px` | 较大控件 / 浮层，Tailwind `rounded-lg` |
| `--radius-xl` | `20px` | 醒目大面，Tailwind `rounded-xl` |

`--radius-*` 让 Tailwind 的 `rounded-*` 工具类对齐设计 token。

`.ca-app` 壳层另有 `--r-sm/md/lg`（`10 / 14 / 18px`），供 `.ca-*` 自定义组件
（卡片、面板、hero 等）直接引用：`border-radius: var(--r-lg);`。

> **为什么不用 Tailwind 原生档位？** Tailwind 的圆角是通用目测值，不反映本语言
> 「软一两档」的观感。统一到 token 后，改一处即可全局调整圆角气质。

### 2.2 用法原则

- 卡片、面板、浮层一律走 token，不裸写 `12px`/`16px` 等魔法数字。
- 层级越接近用户（浮层 > 面板 > 卡片 > 内嵌行），圆角可越圆；但**同层级保持同一值**，
  不要在同一张卡片里混用两档内边角。
- 裁剪圆角用 `overflow: hidden` 交由最外层的 `.ca-thumb` 承担；卡片本体不要设
  `overflow: hidden`（会裁掉绝对定位的菜单/重命名框），而是让内部图片元素走 token 顶角。

---

## 3. 签名渐变系统（Signature Gradient System）

这是本语言最核心的独创点，也是唯一的强视觉记忆点。全应用只有**两个**渐变 token，
新增任何渐变前先问：能不能复用这两个？

定义在 `.ca-app` 壳层（内部引用 `var(--accent)`，跟随用户强调色）：

```css
--grad-accent: linear-gradient(
  120deg,
  var(--accent) 0%,
  color-mix(in srgb, var(--accent) 60%, #ffffff) 100%
);
--grad-brand: linear-gradient(
  135deg,
  var(--accent) 12%,
  color-mix(in srgb, var(--accent) 46%, #7d6bf0) 100%
);
```

### 3.1 两个渐变的职责

| Token | 感官 | 用途 | 反例（不要用） |
|---|---|---|---|
| `--grad-accent` | 柔和、扫光、安静 | **进度语义**：所有进度条、进度环、cover 上的 ov-bar、顶栏完成度 | 大块按钮底色、渐变文字 |
| `--grad-brand` | 浓、彩、有品牌存在感 | **品牌/主语义**：logo、主强调面、需要「重量」的实心强调块 | 正文面积、进度、小字 |

- 进度走 `--grad-accent`：方向统一 `120deg`，弱对比、不抢内容。
- 品牌走 `--grad-brand`：末段混入固定紫 `#7d6bf0`，制造与蓝色强调色体系的差异记忆点。
  换强调色后末段仍偏心紫，保持品牌识别稳定。

### 3.2 用法原则

1. **优先复用，禁用裸渐变**。需要「强调→亮调」就把 `linear-gradient(...)` 直接写成
   `var(--grad-accent)`；需要浓彩品牌面就写 `var(--grad-brand)`。不要随手 new 一个渐变。
2. **渐变永远从当前强调色派生**。设计上没有第三条固定色；若要固定色，先在 3.1 里
   "新记忆点" 立项评审，避免颜色系统膨胀。
3. **前景色读 `--accent-text`，不读 `--accent`**。渐变内部用 `var(--accent)` 是底色面包，
   但放在渐变叠层上的图标/文字（尤其是实心强调块）要用随主题变亮的 `--accent-text`，
   否则暗色下近黑底只有约 3.7:1，对比失效。
4. 渐变不应用于小字号文字或大面积正文（可读性/油腻），只服务图形面积（进度、logo、图标底）。

### 3.3 落地现状

**壳层 / 课程库**
- `.ca-sub-progress i`、`.ca-meta-progress i`、`.ca-thumb / .row-thumb / .ca-continue-cover 的 .ov-bar > i`
  → `background: var(--grad-accent)`
- `.rail .rail-logo`、`.ca-brand .logo` → `background: var(--grad-brand)`

**工作台内部（进度承载面）**
- 新增工具类 `.ca-fill-grad { background: var(--grad-accent); }`。**注意**：不要用 Tailwind
  的 `bg-[var(--grad-accent)]`——那是 `background-color`，而渐变是图像，直接 bg 会被浏览器忽略。
- 已应用的进度条（组件里用 `ca-fill-grad`）：
  - `QuizPanel`（练习自评进度）、`ConceptsPanel`（知识点分析进度）、
    `JobProgress`（处理后端阶段进度）、`ProcessingQueuePanel`（处理队列进度）、
    `ReviewSession`（复习会话完成度，顶部细进度条）
- `ProgressRing`（得分/计数环）：填充弧用 SVG `linearGradient`，两段 stop 与 `--grad-accent`
  同源，跟随强调色；每个实例用 `useId` 生成独立渐变 id，避免 `url(#…)` 冲突。
- **Dashboard**：今日目标（进行中 `ca-fill-grad` / 达标保持实色 accent-text）、继续学习行
  进度条统一为重进渐变。

**对话 / 问答（品牌化，遵循「渐变只上图形面」铁律）**
- AI 头像（Sparkles 圆形）、空态图标、发送键（图标钮）→ `ca-fill-brand` + `text-[var(--on-accent)]`。
  这些是**不含正文的图形面**，可用浓彩品牌渐变；前景走 on-accent，随当前强调色自动选黑白。
- 用户问题气泡 → `bg-[var(--accent-weak-2)]`（强一档的强调色 tint），形成「发出方」与 AI 中性
  卡的区分，同时正文对比度在深浅两主题都达标。
- **刻意不用渐变做消息气泡底色**：气泡承载正文，渐变两端明度跨度大，正文对比度无法在
  `--grad-brand` 两段同时满足，违反 §3.2「渐变不应用于小字号文字或大面积正文」。

---

## 4. 分层灰阶（表面层级）

浅色主题退到「苹果式分层灰」：chrome 更安静的灰、内容层纯白，靠明度差 + 柔和投影
分层，刻意**少用 1px 硬描边**。

| Token | 值 | 角色 |
|---|---|---|
| `--surface-app` | `#f5f5f7` | 应用最底，全局背景 |
| `--surface-rail` / `--surface-sidebar` | `#fcfcfd` | 导航/细侧栏 |
| `--surface-panel` / `--surface-card` / `--surface-header` | `#ffffff` | 内容与浮层 |
| `--surface-card-hover` | `#f2f2f5` | 悬停承接面 |
| `--surface-card-active` | `#eff3fc` | 选中承接面（轻蓝） |
| `--surface-input` | `#fcfcfd` | 输入框底 |
| `--border-subtle` | `#e3e4e8` | 发丝线（最常用） |

三条工程约束（有测试兜底，见 §7）：
- 发丝线整体调柔；能靠明度/投影分层的地方不依赖重描边。
- 阴影一律走 `--shadow-raise/card/card-hover/pop` 令牌，不用 Tailwind 原生 `shadow-*` 档位。
- 暗色主题每档阴影都必须带顶部内高光 `inset 0 1px 0 rgb(255 255 255 / …)`，否则近黑底上
  层次全糊。

---

## 5. 动效（Motion）

目标：**丰富但不喧宾夺主**，只动合成器安全的属性，且尊重减弱动效。

### 5.1 硬约束（有测试）

`@keyframes` 内**只允许**这些属性：`transform` / `opacity` / `clip-path` /
`visibility` / `animation-timing-function`。动 `width/height/top/margin/box-shadow`
会让每帧重排整棵子树，长列表掉帧——被 `src/globals.test.ts` 拦截。

> 反例教训：首个版本的播放钮光晕用的是 `box-shadow` 关键帧，被该测试打回，改为
> `transform` 呼吸缩放。新增关键帧前先照这条自查。

### 5.2 现有动效清单

| 动效 | 实现 | 触发 |
|---|---|---|
| 卡片/行/hero 整体上浮 + 阴影加深 | 已存在 `.ca-card:hover` | hover |
| **封面图细微放大** `scale(1.05)` | `transition: transform .5s var(--ease)` | hover（`.ca-thumb/.row-thumb/.ca-continue-cover`） |
| **续看播放钮呼吸** | `@keyframes ca-play-pulse` `scale(1.04↔1.08)` | hover 且未减弱动效 |
| 主题切换 | 圆形揭开 / 交叉淡化（`theme.ts`） | 点击切换钮 |
| 视图入场 / 页签淡入 / 卡片翻页 / 对话框进出 | `.ca-view` / `@keyframes ca-*` | 视图/状态切换 |
| 打字指示点 / 流式光标 | `@keyframes ca-typing-dot` / `ca-stream-caret` | 助手生成中 |

### 5.3 使用原则

- 新动效优先 `transform` / `opacity`，并放在对应 `@media (hover: hover)` 与
  `@media (prefers-reduced-motion: no-preference)` 里；减动效时由全局兜底压到 `0.01ms`。
- `will-change: transform` 只在 **hover 作用域内**声明，避免常驻所有缩略图的 GPU 开销。
- 关键帧一旦声明就**必须被引用**（有测试检查无用关键帧），别留死代码。
- 缓动统一走 `var(--ease)`（`cubic-bezier(.22,.61,.36,1)`，苹果观感）。

---

## 6. 留白节奏

为契合灰阶分层，宽档留白整体放大一档（紧凑档同步）：

| 区域 | 旧 | 新 |
|---|---|---|
| `.ca-topbar` 内边距 | `20px 30px 14px` | `24px 34px 16px` |
| `.ca-scroll` 内边距 | `10px 30px 34px` | `16px 34px 40px` |
| `.ca-grid` 间距 | `18px` | `20px` |
| `.ca-card-body` 内边距 / 行距 | `12px 14px / 9px` | `14px 16px / 12px` |

移动紧凑档：顶栏 `18px 18px 14px`，滚动区 `12px 18px 34px`。

---

## 7. 质量护栏（回归怎么守）

设计语言有几条被 `src/globals.test.ts` 认真锁定的约定，改样式前务必知道：

1. **关键帧只动合成器属性**（`transform/opacity/clip-path/visibility/…`）。
2. **减少动效的全局兜底在**：`@keyframes` 必须有完整 `prefers-reduced-motion: reduce`
   压平（`transition/animation-duration 0.01ms !important`、`animation-iteration-count 1`）。
3. **每个关键帧都被使用**，不留死代码。
4. 前景色不得拿 `--accent` 当文字色（要在暗色下能亮，读 `--accent-text`）。
5. 组件/页面层不得裸写 `shadow-*`（Tailwind 原生档），一律 `shadow-[var(--*)]`。
6. 自定义 `--shadow-*` token 不与 Tailwind 同名档位重名（避免污染工具类）。
7. 暗色阴影必须带顶部内高光。
8. `.ca-sheen` 受光层只能 `background-image`，不占 `box-shadow`。
9. 不用 `transition-all`。

改完后跑 `pnpm test`（重点 `src/globals.test.ts`）。对灰阶数值类改动，跑
`pnpm vitest run src/stores/theme.test.ts` 确认主题/圆层常量与新 `--surface-app` 同步
（`theme.ts` 的 `SURFACE_APP.light` 必须等于 CSS 里的 `--surface-app`，否则主题切换圆
底色与真实背景错位）。

---

## 8. 暂未覆盖 / 后续扩展

- 已覆盖：**课程库与工作台壳层**、练习（Quiz）、知识点分析（Concepts）、处理队列 / 任务阶段
  （ProcessingQueue / JobProgress）、复习（ReviewSession）、**数据台 Dashboard 达成进度**、
  以及**课程问答 / 文稿搜索（Chat）** 的气泡品牌化。圆角随 token 自动提升。
- 待延伸、但按 §3.2 只复用 `--grad-accent` / `--grad-brand`、不新增第三条渐变：
  - ✅ **文稿 / 笔记**细排版颗粒（时间戳 chip、当前句高亮行）已完成 token 对齐：
    `bg-primary/20` → `bg-[var(--accent-weak-2)]`、`text-primary` → `text-[var(--accent-text)]`，
    与全应用纪律一致、随主题可读；因是正文承载的 tint，按 §3.2 铁律**不做渐变**。
  - **其它 `bg-primary/*` 平色语义面**（知识点卡片、仪表盘次要入口等）——这类是
    大面积 tint 承载交互，是否升级为品牌渐层属产品级取舍，留待评审。

**播放器（VideoPlayer，嵌入式控制栏已完成；舞台徽标仍待）**
- 已完成：
  - **进度条（seek）**填充 → `.ca-fill-video-grad`（主题感知）：浅色为 `--grad-accent`，深色
    自动切换为基于 `--video-accent` 的近黑安全渐层——解决深色控制栏下 `--accent` 仅 ~2.9:1
    （低于非文字 3:1）的问题，已验对比。
  - **播放/暂停主按钮** → 实心强调色圆形（主要操作面）；控制栏加顶部发丝线 + 更高 `backdrop-blur`，
    强化浮层玻璃观感。
- 说明：沉浸式（手机）与桌面**共用同一个 ProgressBar** 作为 seek，不是独立滑条；CSS 里的
  `.course-video-progress` 是未被组件使用的遗留类（`.course-video-volume` 才是音量滑条）。
- 仍未动（纯黑面上方）：舞台上方的通知 / 手势提示徽标（`bg-black/*` 语义，非进度，与渐变语言无关）。
- 深浅两套主题：浅色已做灰阶分层；暗色维持既有近黑分层 + 内高光，渐变由 `--accent`
  自动适配，理论上双主题一致，交付前仍需在各强调色下人工过一遍对比度。

---

## 附：一句话速查

> 圆角·只认 token；渐变·只用 `--grad-accent`（进度）/ `--grad-brand`（品牌）；
> 强调前景·读 `--accent-text`；阴影·走 `--shadow-*`；动效·只动 transform/opacity、
> 记得尊重减动效；改完跑 `pnpm test`。