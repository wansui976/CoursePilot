# 设计语言：最终总结（Final Summary）

> 2026-09-05。把本轮「苹果式克制与工艺 + 独创渐变/圆角」改版全部收拢成一份总览。
> 详尽的设计规则、token 定义、护栏详见配套文档：
> [2026-09-05-gradient-radius-design-language.md](./2026-09-05-gradient-radius-design-language.md)。
> 本文是「改了什么、在哪、怎么维护」的索引，不是规则全集。

---

## 1. 一句话

在苹果式系统观感（字体栈、分层灰阶、柔和动效、无障碍）的基座上，注入唯一的视觉记忆点——
**双渐变系统**，并让**圆角更软更统一**；最终覆盖课程库、学习面板、练习/复习、Dashboard、
对话气泡、播放器进度，全程由设计 token 驱动。

---

## 2. 设计 token（值域与位置）

定义在 `src/globals.css`：

| Token | 值 | 语义 |
|---|---|---|
| `--radius-sm/md/lg/xl` | `8/10/14/20px` | Tailwind 圆角档位 |
| `.ca-app --r-sm/md/lg` | `10/14/18px` | `.ca-*` 组件圆角 |
| `--surface-app` | `#f5f5f7` | 苹果式应用灰 |
| `--surface-rail/sidebar` | `#fcfcfd` | 导航面 |
| `--surface-panel/card/header` | `#ffffff` | 内容/浮层 |
| `--surface-stage-overlay` | `rgb(0 0 0 / .72)` | **舞台上方通知/手势徽标**底（近黑 scrim，深浅主题恒定） |
| `--surface-stage-scrim` | `rgb(0 0 0 / .2)` | 舞台手势反馈的整面压暗层 |
| `--border-subtle` | `#e3e4e8` | 调柔的发丝线 |
| `--grad-accent` | `accent→亮60%白` | **进度语义**渐变 |
| `--grad-brand` | `accent→偏紫` | **品牌语义**渐变 |
| `--grad-video-progress` | 主题感知 | **播放进度**（浅=accent / 深=近黑安全） |

`theme.ts` 的 `SURFACE_APP.light` 已同步为 `#f5f5f7`（主题切换圆盖底色一致）。

### 渐变工具类（`src/globals.css`，唯一入口，勿再裸写）

| 类 | 背景 | 用途 |
|---|---|---|
| `.ca-fill-grad` | `var(--grad-accent)` | 各类学习/处理**进度条** |
| `.ca-fill-brand` | `var(--grad-brand)` | **图形面**（logo/头像/图标钮） |
| `.ca-fill-video-grad` | `var(--grad-video-progress)` | **播放 seek 进度**（主题感知） |

---

## 3. 改动落地清单（按面）

### 3.1 课程库 / 壳层
- 圆角 token 放大并归一；浅色改苹果式灰阶；发丝线调柔。
- 进度（ca-sub-progress / ca-meta-progress / 封面 ov-bar）→ 渐变。
- logo（rail-logo / brand .logo）→ `--grad-brand`。
- 留白放大（topbar / scroll / grid / card-body）。

### 3.2 学习面板 / 练习 / 复习 / 处理进度
- QuizPanel 自评进度、ConceptsPanel 分析进度、ProcessingQueuePanel、JobProgress → `ca-fill-grad`。
- ProgressRing（SVG 得分环）→ 渐变描边（`useId` 唯一 id）。
- ReviewSession 新增顶部渐变完成度进度条。
- Quiz 题目卡片 `rounded` → `rounded-lg`。

### 3.3 Dashboard
- 今日目标（进行中 `ca-fill-grad` / 达标实色 accent-text）、继续学习行进度 → 渐变。

### 3.4 对话 / 问答气泡
- AI 头像、空态图标、发送键 → `ca-fill-brand` + `text-[var(--on-accent)]`。
- 用户气泡 → `bg-[var(--accent-weak-2)]`（强强调色 tint，区分"发出方"）。
- **铁律**：气泡承载正文，绝不用渐变当底（对比不达标）。

### 3.5 播放器
- seek（共享 ProgressBar）填充 → `.ca-fill-video-grad`（主题感知、近黑安全、已验对比）。
- 播放/暂停主按钮 → 实心强调色圆形；控制栏毛玻璃加发丝线 + 更强 `backdrop-blur`。
- 已核实 `.course-video-progress` 为未使用遗留类（音量滑条是 `.course-video-volume`）。

### 3.6 动效
- 卡片/行/续看 hero 封面 hover 细微缩放（transform，合成安全）。
- 续看播放钮 hover 呼吸（`scale 1.04↔1.08`，`@media (hover) + reduced-motion` 双重门）。

### 3.7 文稿 / 笔记（细排版 token 对齐）
- 时间戳 chip（`TimestampNode`）、当前句高亮行：`bg-primary/20` / `text-primary` → `bg-[var(--accent-weak-2)]` / `text-[var(--accent-text)]`，与全应用 token 纪律对齐、随主题可读。
- 决策：这些是**正文承载的 tint**，按铁律不做渐变（正文对比无法两段达标），只做 token 对齐。

### 3.8 知识点 / Dashboard 次要入口（品牌化）
- **图形图标箱**（继续学习 Play、复习 Brain、空态 Sparkles）：`bg-primary/12|15` → `ca-fill-brand` + `text-[var(--on-accent)]`，成为品牌记忆点。
- **文字 pill**（开始复习、复习按钮、课程到期数、概念复习按钮）：`bg-primary/15 text-primary` → `bg-[var(--accent-weak-2)]` / `text-[var(--accent-text)]`；实心"开始复习" CTA 加 `ca-sheen` 受光。
- 决策：图标箱是**图形面**可上品牌渐变；文字 pill 是**正文承载**按铁律只做 token 对齐不上渐变。
- 保留不动：Dashboard 热力图（`bg-primary/30/50/75`）——它是**强度不透明度刻度**，不是品牌渐变语义。

### 3.9 遗留 `bg-primary/*` 面审计对齐（最后扫尾）
- 文稿/搜索里**可点时间戳 chip** 的另一处（`src/lib/clickableTimestamps.tsx`）与笔记里的一致 → `accent-weak-2` / `accent-text`。
- 队列计数徽标（AppSidebar）、导入对话框选中项 pill（Playlist / Bilibili 清晰度）→ token 对齐。
- 导入进度条（PlaylistImportDialog）`bg-primary` → `ca-fill-grad`（进度语义）。
- 说明：各处 `text-primary` **保留不动**——它是**有意的**，globals.css 已 `.ca-app [class~="text-primary"] { color: var(--accent-text) !important; }` 全域重映射，等价于 accent-text、对比正确。
- 保留不动：Dashboard 热力图、Tab 选中 `border-primary`（描边指示符，非 tint/文字面）。

### 3.10 舞台上方的通知 / 手势提示徽标（近黑 scrim，非进度）
- 智能倍速、静音跳过、裁切提示等 toast 与手势反馈，统一改读新语义令牌 `bg-[var(--surface-stage-overlay)]`（0.72 近黑），整面压暗层读 `--surface-stage-scrim`（0.2）。
- 它们永远压在产品画面上，深浅主题都走近黑——不能用 `--surface-stage`（浅色下是白底）。
- 保留不动：视频封面上的快捷播放装饰钮（Home，`bg-black/55 + ring + blur`）——是轻量 affordance，非文本徽标，权重不同。

---

## 4. 对比度与无障碍纪律（已验 / 必须遵守）

1. 渐变填色只上**图形面**，不上正文承载面（气泡/大段文字），否则渐变两段明度跨度大、对比无法同时达标。
2. 渐变叠层上的前景读 `text-[var(--on-accent)]` 或 `--accent-text`，**不读裸 `--accent` 当文字色**（暗色下仅 ~3.7:1）。
3. seek 渐变做了主题感知：深色改走 `--video-accent`，起始端 ≥4.5:1，解决深色控制栏下 accent 仅 ~2.9:1 的问题。
4. 前景/背景对比以浅色 `#ffffff`、暗色 `#252a30`（或近黑面 `#1a1a1a`）为基准核算。

---

## 5. 质量护栏（已有测试兜底，勿破坏）

改样式前先对齐 `src/globals.test.ts`：
- 关键帧只动合成器安全属性（transform/opacity/clip-path/visibility/…）。
- 减动效全局兜底必须存在；每个关键帧都必须被引用。
- 前景不得拿 `--accent` 当文字色；组件/页面不裸写 `shadow-*` / `transition-all`。
- 自定义 `--shadow-*` 不与 Tailwind 同名档位重名；暗色阴影必须带顶部内高光。
- 新增渐变一律走本文 §2 的三个工具类，不新增第三条渐变。

改动后必须跑：
```
pnpm test          # 关键 src/globals.test.ts、src/stores/theme.test.ts、播放器测试
pnpm lint          # 0 errors
```

---

## 6. 已知待办 / 未覆盖（按 §2 只复用现有渐变）

- **深浅两套主题 + 各强调色（blue/purple/…/yellow）交付前建议人工过一遍渐变对比。** —— 唯一的剩余彩排项：强调色多、渐变跨明度大，需逐色在浅/深两底上目验对比。归属营修层面的手检，不是机械改码。
- ✅ 已完成：舞台上方的通知/手势提示徽标收敛为 `--surface-stage-overlay` / `--surface-stage-scrim` 语义令牌（§3.10）。
- ✅ 已完成：文稿/笔记时间戳 chip 与高亮行的 token 对齐（§3.7）；知识点 / Dashboard 次要入口品牌化（§3.8）。

---

## 7. 维护速查

> 圆角只认 token；渐变只用 `.ca-fill-grad`（进度）/ `.ca-fill-brand`（图形品牌）/ `.ca-fill-video-grad`
> （播放 seek）；强调前景读 on-accent/accent-text；阴影走 `--shadow-*`；动效只动 transform/opacity
> 且尊重减动效；改完跑 `pnpm test && pnpm lint`。