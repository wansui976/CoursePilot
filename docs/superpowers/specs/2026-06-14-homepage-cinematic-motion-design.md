# 主页炫酷动效优化 — 设计文档

**日期:** 2026-06-14
**目标文件:** `website/index.html`(单文件官网,GitHub Pages 部署)
**关联设计规范:** `DESIGN-apple.md`(单一 Action Blue、SF Pro/Inter、唯一产品投影、负字距等令牌体系)

## 1. 背景与目标

`website/index.html` 是 CoursePilot 的 Apple 风官网主页。当前已有一套克制的动效系统:
scroll-reveal(blur 渐入)、scroll parallax、产品图 3D 指针倾斜、nav 滚动态、sheen/shimmer 扫光、循环 pulse,且全部带 `prefers-reduced-motion` 回退。

用户希望「优化主页、增加炫酷动效」,方向已确认为:
**重做 Hero 大动效(载入电影式开场)**,并在功能/卡片区、产品截图 mock、全局氛围四个区块整体提升。

非目标(YAGNI):不改文案信息架构;不引入构建步骤;不改 DESIGN-apple.md 的色彩/排版令牌;不做与动效无关的重构。

## 2. 关键决策(已与用户确认)

| 决策点 | 选择 |
| --- | --- |
| 动效基调 | 重做 Hero 大动效,整体更有存在感 |
| Hero 形态 | 载入电影式开场:标题逐词浮现 + 极光渐变背景 + 产品图深度推近 |
| 技术约束 | 可引入 GSAP + ScrollTrigger(均已免费) |
| 开场播放频率 | 每会话一次(`sessionStorage` 记录) |
| 优化范围 | Hero 首屏 / 功能·卡片区 / 产品截图 mock / 全局氛围 |

## 3. 架构

保持**单文件** `website/index.html`,零构建。新增:

- 通过 **CDN 异步加载 GSAP 3.13 + ScrollTrigger**。
- 所有动效「隐藏初态」**仅在确认 GSAP 加载成功后**通过 JS 添加 class 施加。
  → CDN 被墙 / JS 失败 / 无 JS 时,页面完整可见(渐进增强,沿用现有 `motion-ready` 思路)。
- 新增极光背景层(hero 内 + 全局淡持续)。
- 新增顶部滚动进度条(nav 下方)。

### 加载与降级流程

```
DOMContentLoaded
  ├─ prefers-reduced-motion?  ── 是 ──▶ 直接显示全部内容,绑定最小交互(nav 态),结束
  ├─ 加载 GSAP(async)
  │     ├─ 失败/超时 ──▶ 显示全部内容(fallback),结束
  │     └─ 成功 ──▶ 注册 ScrollTrigger
  ├─ sessionStorage 有 "intro-played"?
  │     ├─ 有 ──▶ 跳过开场,内容直接到位
  │     └─ 无 ──▶ 播放 Hero 电影式 timeline,完成后写入 sessionStorage
  └─ 初始化页面级 ScrollTrigger(reveal / 产品图 scrub / 进度条)
```

## 4. 组件(各自单一职责)

### 4.1 Aurora 极光背景层
- **做什么:** hero 区后方一层柔和、缓慢漂移的渐变光(Action-Blue 系,克制低饱和),并在全页面以更淡形式持续。
- **怎么用:** 一个 `.aurora` 绝对/固定定位层,CSS `@keyframes` 缓慢位移 + GSAP 控制 hero 内的淡入。
- **依赖:** CSS;GSAP 仅用于开场淡入时序。
- **约束:** 不抢前景对比度,不影响文字可读性;reduced-motion 下静止或隐藏。

### 4.2 Hero 电影式开场 timeline
- **做什么:** 载入后约 ~1.2s 的 GSAP timeline:
  1. 极光淡入。
  2. 主标题逐词/逐段 上移 + 去模糊 staggered 浮现。
  3. eyebrow → lead → CTA → caption 依次级联。
  4. 产品 mock 深度推近:由远(小、模糊、Z 轴推后)平滑落位,交棒给现有 shine/sheen + 指针倾斜。
- **怎么用:** 读取 hero 内带 `data-*` 标记的元素构建 timeline。
- **依赖:** GSAP core;4.5 的逐词拆分助手。
- **约束:** 每会话仅一次;reduced-motion 完全跳过;不长时间遮挡首屏内容(LCP 友好)。

### 4.3 滚动进度条
- **做什么:** nav 下方一条细进度条,随页面滚动百分比增长。
- **怎么用:** 固定定位元素,ScrollTrigger 或 scroll 比例驱动宽度。
- **约束:** reduced-motion 下可保留(纯比例、无缓动)或隐藏;不遮挡内容。

### 4.4 区块 scroll-reveal(迁移到 ScrollTrigger.batch)
- **做什么:** 将现有 `[data-animate]` 的进场迁移到 `ScrollTrigger.batch`,保留现有标记与 `--motion-delay` stagger 语义。
- **怎么用:** 复用现有 `data-animate` 属性与 `is-visible` 视觉效果。
- **约束:** 行为等价或更顺,不改变各区块进场观感的基调。

### 4.5 逐词拆分助手
- **做什么:** 把 hero 标题按词/段包裹为可独立动画的 `<span>`。
- **怎么用:** 一个小函数,在构建 timeline 前对标题节点执行。
- **约束:** 保持原有换行(`<br>`)与语义文本;对屏幕阅读器friendly(整体文本仍可读)。

### 4.6 产品图 scroll-scrub(替换 rAF parallax)
- **做什么:** 用 ScrollTrigger scrub 替换现有手写 rAF parallax,过视口时做细微 scale/translate。
- **怎么用:** 复用 `.product-shot[data-parallax]`;保留指针倾斜与 sheen。
- **约束:** 幅度克制,延续唯一产品投影质感;reduced-motion 下静止。

## 5. 数据流 / 状态

- `sessionStorage["coursepilot-intro-played"]`:控制开场是否播放。
- `documentElement` class:`motion-ready`(GSAP 就绪后施加隐藏初态)。
- 媒体查询:`prefers-reduced-motion`、`(hover:hover) and (pointer:fine)`(沿用)。
- 无服务端、无网络状态;纯前端。

## 6. 错误处理与降级

- **GSAP 加载失败/超时:** 设超时兜底,触发「显示全部内容」路径,页面静态完整可用。
- **prefers-reduced-motion:** 全程跳过 timeline、scrub、扫光循环;内容静态;扩展现有处理。
- **无 JS:** 不施加任何隐藏初态,页面默认即完整内容。
- **运行中切换 reduced-motion:** 沿用现有监听,即时回退到静态。

## 7. 性能与可访问性

- GSAP + ScrollTrigger 经 CDN 异步加载(约 ~50KB gz),不阻塞首屏渲染。
- 开场 timeline 短(~1.2s),且每会话一次;绝不长时间遮挡首屏(保护 LCP)。
- 动画优先 `transform` / `opacity` / `filter`,配 `will-change`,避免布局抖动。
- 保留所有 `focus-visible`、aria-label、语义结构与 DESIGN-apple.md 令牌。

## 8. 测试 / 验收

由于是静态单文件官网,验收以**手动 + 浏览器观察**为主:

1. 首次加载:Hero 电影式开场按序播放,极光漂移,产品图深度推近落位。
2. 同会话二次进入/返回首页:开场跳过,内容直接到位。
3. 向下滚动:各区块 reveal 顺滑;产品图 scrub 细微;进度条随滚动增长。
4. `prefers-reduced-motion: reduce`:无开场、无 scrub、无循环扫光,内容静态完整。
5. 禁用 JS / 阻断 GSAP CDN:页面内容完整可见,无空白/FOUC。
6. 移动端宽度(<833px / <480px):布局与动效不破版,触摸下无指针倾斜。
7. 键盘 Tab:焦点环正常,可达所有链接/按钮。
8. `website/check_site.py`(若适用)仍通过。

## 9. 范围外 / 后续

- 不改信息架构与文案。
- 不引入打包/构建。
- 暂不做逐区块差异化主题色(全局氛围统一即可)。
