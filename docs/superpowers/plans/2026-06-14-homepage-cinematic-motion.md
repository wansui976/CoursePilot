# 主页电影式炫酷动效 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 `website/index.html` 增加一段「载入电影式开场」的 Hero 大动效(极光渐变背景 + 标题逐词浮现 + 产品图深度推近,每会话播放一次),并以 GSAP 提升全局氛围,同时完整保留无 JS / reduced-motion 回退。

**Architecture:** 保持单文件零构建官网。通过 CDN `defer` 引入 GSAP 3.13 + ScrollTrigger;所有动效初态在 `DOMContentLoaded` 后、确认 `window.gsap` 存在时才施加。现有 IntersectionObserver reveal + rAF parallax + nav 态原样保留,既满足 `check_site.py` 守卫,也作为无 GSAP 时的降级路径。GSAP 仅叠加三件事:极光层淡入、Hero 开场 timeline、产品图 ScrollTrigger scrub;另加纯 JS 滚动进度条。

**Tech Stack:** HTML/CSS/原生 JS、GSAP 3.13 core + ScrollTrigger(CDN)、Python 3(`check_site.py` 作为自动化守卫)。

---

## 不可破坏的约束(check_site.py 守卫)

实现期间 `website/index.html` 必须始终保留以下字符串/计数,否则 `python3 website/check_site.py` 失败:

- `IntersectionObserver`、`is-visible`、`nav-scrolled`
- `data-animate` 出现 ≥ 12 次、`data-parallax` 出现 ≥ 2 次
- `var(--primary)` 出现 ≥ 8 次
- `matchMedia("(prefers-reduced-motion: reduce)")`
- 现有所有页面文案与资产名(promo-hero.png 等)

**因此:现有 reveal / parallax / nav 代码与标记一律保留,新动效为叠加层。**

## 文件结构

- **Modify:** `website/index.html` — 唯一改动文件。CSS 在 `<style>`(行 30–1084),markup 在 `<body>`(行 1087+),JS 在末尾 `<script>`(行 1541–1692)。
- **Modify:** `website/check_site.py` — 新增对新动效 hook 的断言,充当自动化测试。
- **Verify only:** 浏览器手动观察(动效观感无法自动断言)。

每个任务:先在 `check_site.py` 写失败断言 → 跑出 FAIL → 在 `index.html` 实现 → 跑出 PASS → 手动浏览器确认 → commit。

---

### Task 1: 引入 GSAP 并改为 DOMContentLoaded 初始化(不改观感)

**Files:**
- Modify: `website/index.html`(`<head>` 末尾加 script 标签;`<script>` 行 1691 `enableMotion();` 调用方式)
- Test: `website/check_site.py`

- [ ] **Step 1: 写失败断言**

在 `website/check_site.py` 的 `required_text` 列表(行 9–25)末尾追加:

```python
    "gsap@3.13",
    "ScrollTrigger.min.js",
    "DOMContentLoaded",
```

- [ ] **Step 2: 跑测试确认失败**

Run: `python3 website/check_site.py`
Expected: FAIL — `Missing required page copy/assets: ['gsap@3.13', 'ScrollTrigger.min.js', 'DOMContentLoaded']`

- [ ] **Step 3: 加 GSAP CDN 标签**

在 `website/index.html` 的 `</head>`(行 1085)之前插入:

```html
    <!-- GSAP(免费):仅作增强层,CDN 不可用时页面照常完整显示 -->
    <script src="https://cdn.jsdelivr.net/npm/gsap@3.13.0/dist/gsap.min.js" defer></script>
    <script src="https://cdn.jsdelivr.net/npm/gsap@3.13.0/dist/ScrollTrigger.min.js" defer></script>
```

- [ ] **Step 4: 改为 DOMContentLoaded 初始化**

`defer` 脚本在 `DOMContentLoaded` 前按序执行;内联脚本须等到那时 `window.gsap` 才就绪。
把 `website/index.html` 末尾内联 `<script>` 的最后一行(行 1691)`enableMotion();` 替换为:

```js
      function bootstrap() {
        if (window.__cpBooted) return;
        window.__cpBooted = true;
        enableMotion();
      }
      if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", bootstrap);
      } else {
        bootstrap();
      }
```

- [ ] **Step 5: 跑测试确认通过**

Run: `python3 website/check_site.py`
Expected: `site checks passed`

- [ ] **Step 6: 浏览器确认无回归**

打开 `website/index.html`:首屏内容正常显示、滚动 reveal 正常、nav 滚动变态、reduced-motion 下静态。控制台无报错。

- [ ] **Step 7: Commit**

```bash
git add website/index.html website/check_site.py
git commit -m "feat(site): load GSAP and init on DOMContentLoaded"
```

---

### Task 2: 极光渐变背景层(CSS,静默叠加)

**Files:**
- Modify: `website/index.html`(`<style>` 加 `.aurora` 样式 + keyframes;Hero section 内加 markup;reduced-motion 块加规则)
- Test: `website/check_site.py`

- [ ] **Step 1: 写失败断言**

在 `website/check_site.py` 的 `required_text` 列表末尾追加:

```python
    "class=\"aurora\"",
    "auroraDrift",
```

- [ ] **Step 2: 跑测试确认失败**

Run: `python3 website/check_site.py`
Expected: FAIL — 缺 `['class="aurora"', 'auroraDrift']`

- [ ] **Step 3: 加极光 CSS**

在 `website/index.html` 的 `<style>` 内、`.tile {` 规则(行 245)之前插入:

```css
      /* ---------------- 极光背景层(克制、低饱和,只在浅色 Hero 内) ---------------- */
      .aurora {
        position: absolute;
        inset: -25% -10% auto -10%;
        height: 150%;
        z-index: 0;
        pointer-events: none;
        opacity: 0;
        filter: blur(60px);
        background:
          radial-gradient(40% 50% at 22% 30%, rgba(41, 151, 255, 0.28), transparent 70%),
          radial-gradient(38% 46% at 78% 22%, rgba(0, 102, 204, 0.22), transparent 72%),
          radial-gradient(45% 55% at 60% 78%, rgba(120, 180, 255, 0.18), transparent 70%);
        background-size: 160% 160%;
        animation: auroraDrift 22s ease-in-out infinite alternate;
        transition: opacity 1.4s cubic-bezier(0.16, 1, 0.3, 1);
      }
      .aurora.is-lit {
        opacity: 1;
      }
      @keyframes auroraDrift {
        0% {
          background-position: 0% 0%;
          transform: translate3d(0, 0, 0) scale(1);
        }
        100% {
          background-position: 100% 100%;
          transform: translate3d(0, -3%, 0) scale(1.08);
        }
      }
```

- [ ] **Step 4: 让 Hero 容纳极光层**

Hero `<section class="tile tile--parchment">`(行 1112)改为:

```html
      <section class="tile tile--parchment" data-hero-section style="position: relative; overflow: hidden;">
        <div class="aurora" aria-hidden="true"></div>
```

(其余内容不变;`.tile__inner` 已在文档流上方,极光在其后。)
注:`.aurora` 在 `.tile__inner` 之前,但 `.tile__inner` 内元素无显式 z-index,会盖住极光。为确保前景在上,给该 Hero 的 `.tile__inner` 加内联 `style="position: relative; z-index: 1;"`(行 1113)。

- [ ] **Step 5: reduced-motion 与无 GSAP 兜底**

在 `<style>` 的 `@media (prefers-reduced-motion: reduce)` 块内(行 1059 起),`.product-shot::after { display:none; }` 旁追加:

```css
        .aurora {
          animation: none !important;
          opacity: 0.5;
        }
```

在内联 `<script>` 的 `revealImmediately()` 函数(行 1551)体内追加,让无动效/无 GSAP 时极光也淡淡可见:

```js
        document.querySelectorAll(".aurora").forEach((el) => el.classList.add("is-lit"));
```

- [ ] **Step 6: 跑测试确认通过**

Run: `python3 website/check_site.py`
Expected: `site checks passed`

- [ ] **Step 7: 浏览器确认**

正常模式:Hero 后方有缓慢漂移的蓝色极光,不影响文字可读性。reduced-motion:极光静止、半透明。前景文字/产品图清晰在上层。

- [ ] **Step 8: Commit**

```bash
git add website/index.html website/check_site.py
git commit -m "feat(site): add aurora gradient backdrop to hero"
```

---

### Task 3: Hero 电影式开场 timeline(GSAP)

**Files:**
- Modify: `website/index.html`(`<style>` 加 `.intro-active` 规则;`<script>` 加 word-split、playHeroIntro、改 enableMotion 分流)
- Test: `website/check_site.py`

- [ ] **Step 1: 写失败断言**

在 `website/check_site.py` 的 `required_text` 列表末尾追加:

```python
    "coursepilot-intro-played",
    "playHeroIntro",
    "hero-word",
```

- [ ] **Step 2: 跑测试确认失败**

Run: `python3 website/check_site.py`
Expected: FAIL — 缺这三项

- [ ] **Step 3: 加开场期禁用过渡的 CSS**

在 `<style>` 内 `html.motion-ready [data-animate]` 规则(行 99)之后插入:

```css
      html.intro-active [data-hero-section] [data-animate] {
        transition: none !important;
      }
      .hero-word {
        display: inline-block;
        will-change: opacity, transform, filter;
      }
```

- [ ] **Step 4: 加 JS——常量、word-split、开场 timeline**

在内联 `<script>` 顶部、`document.getElementById("year")...`(行 1542)之后插入:

```js
      const INTRO_KEY = "coursepilot-intro-played";
      const heroSection = document.querySelector("[data-hero-section]");
      const heroItems = heroSection
        ? Array.from(heroSection.querySelectorAll("[data-animate]"))
        : [];

      function hasGSAP() {
        return typeof window.gsap !== "undefined";
      }

      function splitHeadline() {
        const h1 = heroSection && heroSection.querySelector("h1.hero-display");
        if (!h1 || h1.dataset.split === "1") return [];
        h1.dataset.split = "1";
        const words = [];
        h1.childNodes.forEach((node) => {
          if (node.nodeType === Node.TEXT_NODE) {
            const frag = document.createDocumentFragment();
            node.textContent.split(/(\s+)/).forEach((part) => {
              if (part.trim() === "") {
                frag.appendChild(document.createTextNode(part));
              } else {
                const span = document.createElement("span");
                span.className = "hero-word";
                span.textContent = part;
                frag.appendChild(span);
                words.push(span);
              }
            });
            h1.replaceChild(frag, node);
          }
          // <br> 等元素节点原样保留
        });
        return words;
      }

      function playHeroIntro() {
        const tl = window.gsap.timeline({
          defaults: { ease: "power3.out" },
          onComplete: () => {
            document.documentElement.classList.remove("intro-active");
            heroItems.forEach((el) => {
              el.classList.add("is-visible");
              window.gsap.set(el, { clearProps: "opacity,transform,filter" });
            });
            window.gsap.set(".hero-word", { clearProps: "opacity,transform,filter" });
            const shot = heroSection.querySelector(".product-shot");
            if (shot) shot.classList.add("is-visible");
          },
        });

        const words = splitHeadline();
        const eyebrow = heroSection.querySelector(".eyebrow");
        const lead = heroSection.querySelector(".lead");
        const cta = heroSection.querySelector(".cta-row");
        const caption = heroSection.querySelector(".caption");
        const shot = heroSection.querySelector(".product-shot");

        document.documentElement.classList.add("intro-active");
        document.querySelectorAll(".aurora").forEach((el) => el.classList.add("is-lit"));

        if (eyebrow) tl.fromTo(eyebrow, { opacity: 0, y: 18, filter: "blur(8px)" }, { opacity: 1, y: 0, filter: "blur(0px)", duration: 0.6 }, 0.05);
        if (words.length) tl.fromTo(words, { opacity: 0, y: 30, filter: "blur(10px)" }, { opacity: 1, y: 0, filter: "blur(0px)", duration: 0.7, stagger: 0.08 }, 0.15);
        if (lead) tl.fromTo(lead, { opacity: 0, y: 22, filter: "blur(8px)" }, { opacity: 1, y: 0, filter: "blur(0px)", duration: 0.6 }, "-=0.35");
        if (cta) tl.fromTo(cta, { opacity: 0, y: 18 }, { opacity: 1, y: 0, duration: 0.5 }, "-=0.35");
        if (caption) tl.fromTo(caption, { opacity: 0, y: 14 }, { opacity: 1, y: 0, duration: 0.45 }, "-=0.3");
        if (shot) tl.fromTo(shot, { opacity: 0, y: 90, scale: 0.82, filter: "blur(14px)" }, { opacity: 1, y: 0, scale: 1, filter: "blur(0px)", duration: 1.0, onComplete: () => shot.classList.add("is-visible") }, "-=0.45");

        return tl;
      }
```

- [ ] **Step 5: 让 enableMotion 分流(开场 vs 普通 reveal)**

把内联 `<script>` 的 `enableMotion()` 函数(行 1634–1657)整体替换为:

```js
      function observeReveals(items) {
        const observer = new IntersectionObserver(
          (entries) => {
            entries.forEach((entry) => {
              if (entry.isIntersecting) {
                entry.target.classList.add("is-visible");
                observer.unobserve(entry.target);
              }
            });
          },
          { rootMargin: "0px 0px -12% 0px", threshold: 0.12 }
        );
        items.forEach((item) => observer.observe(item));
      }

      function enableMotion() {
        if (reducedMotionQuery.matches) {
          revealImmediately();
          updateNavState();
          return;
        }

        document.documentElement.classList.add("motion-ready");

        const heroSet = new Set(heroItems);
        const restItems = animatedItems.filter((el) => !heroSet.has(el));
        const introPlayed = sessionStorage.getItem(INTRO_KEY) === "1";

        if (hasGSAP() && heroSection && !introPlayed) {
          playHeroIntro();
          try {
            sessionStorage.setItem(INTRO_KEY, "1");
          } catch (e) {
            /* 隐私模式下 sessionStorage 不可用,忽略 */
          }
          observeReveals(restItems);
        } else {
          // 无 GSAP / 已播放过 / 无 hero:Hero 直接显示,其余照常 IO reveal
          heroItems.forEach((el) => el.classList.add("is-visible"));
          document.querySelectorAll(".aurora").forEach((el) => el.classList.add("is-lit"));
          const shot = heroSection && heroSection.querySelector(".product-shot");
          if (shot) shot.classList.add("is-visible");
          observeReveals(restItems);
        }

        updateNavState();
        requestStageUpdate();
      }
```

- [ ] **Step 6: 跑测试确认通过**

Run: `python3 website/check_site.py`
Expected: `site checks passed`

- [ ] **Step 7: 浏览器确认**

- 清除 sessionStorage 后首次加载:eyebrow → 标题逐词浮现 → lead/CTA/caption 级联 → 产品图由远推近落位,极光点亮。约 ~1.5s 内完成,首屏文字不长时间空白。
- 同会话刷新/返回:开场跳过,Hero 直接到位。
- reduced-motion:无开场,内容静态。
- 阻断 GSAP CDN(DevTools 离线或屏蔽 jsdelivr):Hero 立即完整显示,无空白。

- [ ] **Step 8: Commit**

```bash
git add website/index.html website/check_site.py
git commit -m "feat(site): cinematic hero intro timeline (once per session)"
```

---

### Task 4: 顶部滚动进度条

**Files:**
- Modify: `website/index.html`(`<style>` 加 `.scroll-progress`;`<body>` 加元素;`<script>` 在 scroll 回调更新;reduced-motion 块)
- Test: `website/check_site.py`

- [ ] **Step 1: 写失败断言**

在 `website/check_site.py` 的 `required_text` 列表末尾追加:

```python
    "scroll-progress",
```

- [ ] **Step 2: 跑测试确认失败**

Run: `python3 website/check_site.py`
Expected: FAIL — 缺 `['scroll-progress']`

- [ ] **Step 3: 加进度条 CSS**

在 `<style>` 内 `.global-nav.nav-scrolled { ... }` 规则(行 195)之后插入:

```css
      .scroll-progress {
        position: fixed;
        top: 44px;
        left: 0;
        height: 2px;
        width: 100%;
        transform: scaleX(0);
        transform-origin: 0 50%;
        background: linear-gradient(90deg, var(--primary), var(--primary-on-dark));
        z-index: 99;
        pointer-events: none;
        transition: transform 0.1s linear;
      }
```

- [ ] **Step 4: 加进度条元素**

在 `website/index.html` 的 `</nav>`(行 1108)之后插入:

```html
    <div class="scroll-progress" aria-hidden="true"></div>
```

- [ ] **Step 5: JS 更新进度**

在内联 `<script>` 的 `updateNavState()` 函数(行 1559)体内末尾追加:

```js
        const progress = document.querySelector(".scroll-progress");
        if (progress) {
          const max = document.documentElement.scrollHeight - window.innerHeight;
          const ratio = max > 0 ? Math.min(1, Math.max(0, window.scrollY / max)) : 0;
          progress.style.transform = `scaleX(${ratio.toFixed(4)})`;
        }
```

- [ ] **Step 6: reduced-motion 去除缓动**

在 `@media (prefers-reduced-motion: reduce)` 块内追加:

```css
        .scroll-progress {
          transition: none !important;
        }
```

- [ ] **Step 7: 跑测试确认通过**

Run: `python3 website/check_site.py`
Expected: `site checks passed`

- [ ] **Step 8: 浏览器确认**

滚动时 nav 下方细蓝条按滚动比例增长,到底为满;`updateNavState` 在加载与 resize 时也被调用,初始比例正确。

- [ ] **Step 9: Commit**

```bash
git add website/index.html website/check_site.py
git commit -m "feat(site): add scroll progress indicator"
```

---

### Task 5: 产品图 ScrollTrigger scrub(GSAP 增强,rAF 兜底保留)

**Files:**
- Modify: `website/index.html`(`<script>` 注册 ScrollTrigger;有 GSAP 时接管 parallax)
- Test: `website/check_site.py`

- [ ] **Step 1: 写失败断言**

在 `website/check_site.py` 的 `required_text` 列表末尾追加:

```python
    "ScrollTrigger.create",
```

- [ ] **Step 2: 跑测试确认失败**

Run: `python3 website/check_site.py`
Expected: FAIL — 缺 `['ScrollTrigger.create']`

- [ ] **Step 3: 加 GSAP scrub,并在启用时停用 rAF 路径**

在内联 `<script>` 的 `enableMotion()` 末尾(`requestStageUpdate();` 之前)插入:

```js
        if (hasGSAP() && typeof window.ScrollTrigger !== "undefined") {
          window.gsap.registerPlugin(window.ScrollTrigger);
          window.__cpScrub = true; // 标记:由 GSAP 接管产品图位移,跳过 rAF
          parallaxItems.forEach((item) => {
            window.gsap.fromTo(
              item,
              { "--motion-y": "26px", "--motion-scale": 0.985 },
              {
                "--motion-y": "-26px",
                "--motion-scale": 1.012,
                ease: "none",
                scrollTrigger: {
                  trigger: item,
                  start: "top bottom",
                  end: "bottom top",
                  scrub: 0.6,
                },
              }
            );
          });
        }
```

- [ ] **Step 4: 让 rAF parallax 在 GSAP 接管时让路**

在内联 `<script>` 的 `updateProductStage()` 函数(行 1578)开头、`stageTicking = false;` 之后插入:

```js
        if (window.__cpScrub) return; // GSAP scrub 已接管,避免双重驱动
```

(指针倾斜 `handleProductPointer` 不受影响,继续生效;`data-parallax` 标记保留,守卫不受影响。)

- [ ] **Step 5: 跑测试确认通过**

Run: `python3 website/check_site.py`
Expected: `site checks passed`

- [ ] **Step 6: 浏览器确认**

有 GSAP:滚动经过两处产品图时,有细微、跟手的 scale/位移;鼠标移入仍有 3D 倾斜与扫光。reduced-motion:无 scrub。无 GSAP:回退到原 rAF parallax(仍有细微位移)。

- [ ] **Step 7: Commit**

```bash
git add website/index.html website/check_site.py
git commit -m "feat(site): GSAP scroll-scrub for product shots with rAF fallback"
```

---

### Task 6: 全量集成验证与收尾

**Files:**
- Verify: `website/index.html`、`website/check_site.py`

- [ ] **Step 1: 自动化守卫**

Run: `python3 website/check_site.py`
Expected: `site checks passed`

- [ ] **Step 2: 首屏开场(首次会话)**

清 sessionStorage → 刷新:极光点亮 + 标题逐词 + 级联 + 产品图深度推近,~1.5s 内完成,无长时间空屏。控制台无报错。

- [ ] **Step 3: 重复访问(同会话)**

同会话内刷新/点 logo 回顶:开场跳过,Hero 直接到位。

- [ ] **Step 4: 滚动行为**

各区块 reveal 顺滑;两处产品图 scrub 细微跟手;进度条随滚动到满;nav 滚动变深态。

- [ ] **Step 5: reduced-motion**

DevTools 模拟 `prefers-reduced-motion: reduce`:无开场、无 scrub、无进度条缓动、极光静止;内容静态完整、可读。

- [ ] **Step 6: 无 JS / GSAP CDN 被阻断**

(a) 禁用 JS:页面完整内容可见,无 FOUC。
(b) DevTools 屏蔽 `jsdelivr.net` 后刷新:Hero 立即完整显示,reveal 走 IO,parallax 走 rAF,无空屏。

- [ ] **Step 7: 响应式**

宽度 833px、480px:布局不破版;触摸(无 hover)下无指针倾斜;开场与进度条正常。

- [ ] **Step 8: 键盘可达性**

Tab 遍历:所有链接/按钮 focus 环正常,顺序合理。

- [ ] **Step 9: 最终 commit(如有微调)**

```bash
git add website/index.html website/check_site.py
git commit -m "test(site): verify cinematic motion across fallbacks"
```

---

## Self-Review 记录

- **Spec 覆盖:** §2 极光→Task 2;§2 Hero timeline/word-split/深度推近→Task 3;§2 进度条→Task 4;§2 产品图 scrub→Task 5;§2 reveal 保留(IO)→Task 1/3;§4.5 word-split→Task 3;§6 降级(无 JS/CDN/reduced-motion)→各任务 + Task 6;§3 GSAP 异步 + 就绪后施加初态→Task 1/3;每会话一次→Task 3。
- **偏差说明(对 spec 的有意调整):** spec §4.4 提到把 reveal「迁移到 ScrollTrigger.batch」。为不破坏 `check_site.py` 对 `IntersectionObserver` 的硬性断言、并保留无 GSAP 降级,本计划保留 IntersectionObserver 驱动 reveal,GSAP 仅用于 Hero 开场与产品图 scrub。用户可见效果等价或更稳。
- **Placeholder 扫描:** 无 TODO/TBD;每个代码步骤含完整代码。
- **命名一致性:** `INTRO_KEY`/`coursepilot-intro-played`、`heroItems`、`heroSection`、`playHeroIntro`、`splitHeadline`、`observeReveals`、`hasGSAP`、`window.__cpScrub`、`.hero-word`、`.aurora`/`is-lit`、`.scroll-progress`、`.intro-active`/`data-hero-section` 在各任务间一致。
