# CoursePilot 官网主页

一个自包含的静态营销主页（`index.html`），按 `DESIGN-apple.md`（Apple 风格设计系统）生成：单一 Action Blue 强调色、明暗整幅 tile 交替、SF Pro / Inter 字体、pill 形 CTA、唯一产品投影、负字距、17px 正文。页面文案来自项目当前 README 和功能实现边界，强调本地优先、Bilibili / URL 下载、ASR、字幕纠错、AI 笔记、课件 / OCR、课程问答和导出能力。

## 本地预览

```bash
cd website
python3 -m http.server 8000   # 然后打开 http://localhost:8000
```

## 截图资产

页面里的产品图都是真实 CoursePilot 界面截图，统一放在 `screenshots/`：

- `workbench-overview.webp`、`slides.webp`、`assistant.webp`：首屏、课件、提问三处大图。
- `local-asr` / `mobile-local-asr` / `keep-alive` / `bilibili-cache`：「v0.3.9 新功能」轮播的四张图，与仓库 `assets/screenshots/` 同名文件一致。界面来自截图工具（`course-ai/tools/ui-shots` 的 `local-asr*`、`bilibili-cache` 场景），`keep-alive` 右侧的 Android 通知栏是模拟器上的真实截图。
- `feynman` / `guided` / `find-explanation` / `highlights`：「v0.3.8 新功能」轮播的四张图，与仓库 `assets/screenshots/` 同名文件一致（演示课程「机器学习导论」）。
- `mindmap` / `notes` / `quiz` / `concepts` / `dashboard` / `dark-mode`：「界面一览」画廊。每张都有完整截图（点开看）和一张 4:3 的 `*-thumb.webp` 局部缩略图（卡片里显示）。
- 其余（`library`、`transcript`、`settings`）暂未在主页使用。

由截图派生的三张 PNG：

- `promo-hero.png`：首屏产品介绍图，仓库 README 顶部也用它。
- `promo-workbench.png`：课件 / OCR 介绍图，可作应用商店说明图底稿。
- `og-image.png`：Open Graph / 社交分享卡片，`og:image` 用绝对地址指向它。

替换截图后重新生成：

```bash
python3 website/generate_mock_screenshots.py
```

`screenshot-studio.html` 仍保留为备用的静态模拟截图源。

## 动效

主页模仿 Apple 官网的克制产品动效：

- 首屏文字、CTA 和产品图按层级轻微淡入上浮。
- 每个 full-bleed tile 进入视野时做一次 scroll reveal。
- 两张主产品图带低幅度 parallax 和极淡高光扫过。
- 顶部黑色导航在滚动后切到 frosted / translucent 状态。
- `prefers-reduced-motion: reduce` 下关闭 reveal、parallax 和高光，只保留静态页面。

## 交互

- **新功能轮播**（`[data-showcase]`）：分段控件切换截图，进度条走完自动下一项；不在视口、鼠标悬停、页面切到后台时暂停，手动点过就不再自动轮播；左右方向键可切换；reduced-motion 下不自动轮播。没有 JS 时四项依次排开。
- **截图放大**：「界面一览」卡片和新功能截图点开在页内 `<dialog>` 里看大图，Esc 或点遮罩关闭。
- **下载卡片**：按访客系统推荐安装包（Windows / Android / iOS 看 UA；Mac 用 `userAgentData` 的架构或 WebGL 显卡名区分 Apple 芯片和 Intel，分不出来就显示「怎么看芯片」的提示）。版本号、文件大小和直链从 GitHub API 的最新 release 取（会话内缓存一次），取不到时卡片仍指向 release 页。新增平台时同步改卡片的 `data-asset`（按文件名结尾匹配）。

## 访问统计（Umami Cloud）

`<head>` 里的加载代码默认不启用，在 [Umami Cloud](https://cloud.umami.is) 添加站点 `wansui976.github.io` 后，把 Website ID 填进 `UMAMI_WEBSITE_ID` 即可。不用 Cookie、不收集个人信息；`data-domains` 只统计正式站点，本地预览不计数。

- **自定义事件**：`download`（属性 `platform`：`mac-arm` / `mac-intel` / `windows` / `windows-msi` / `android` / `ios` / `auto`）、`github`（属性 `from`）、`hero-download`、`hero-whats-new`、`changelog`。
- **渠道来源**：B 站、抖音、微信这类 App 打开链接时通常不带来源，发链接时加上 `?utm_source=bilibili`（或 `xiaohongshu`、`zhihu`、`v2ex`…），Umami 会按 UTM 参数分组。

## 验证

```bash
python3 website/check_site.py
```

脚本会检查页面是否包含关键产品能力文案、是否继续使用单一 Action Blue 设计 token、是否包含 Apple 风格动效钩子与 reduced-motion 保护，以及三张宣传图是否存在且是真 PNG。

## 部署

直接把 `website/` 整个目录托管即可（纯静态）：

- **GitHub Pages**：本仓库已提供 `.github/workflows/pages.yml`。在 GitHub 仓库的 **Settings → Pages → Build and deployment** 中把 Source 设为 **GitHub Actions**，之后推送 `main` 上的 `website/**` 改动会自动发布。
- **Vercel / Netlify / Cloudflare Pages**：根目录指向 `website/`，无构建命令。

默认 Pages 地址通常是：

```text
https://wansui976.github.io/CoursePilot/
```

## 上架（App Store / Google Play）前需补齐

这页是营销主页，距离正式上架还差几块**必备资产**，下面是清单：

1. **商店链接**：上架后在 `#download` 区加上 App Store / Google Play 的**官方徽章**和链接（目前手机版走 GitHub release 的 apk / ipa）。
2. **隐私政策 / 使用条款页**：两家商店审核都**强制要求隐私政策 URL**。footer 与导航里的「隐私政策 / 使用条款」目前指向锚点，需替换为真实页面（可在 `website/` 下新增 `privacy.html`、`terms.html`）。
3. **产品截图**：当前 `promo-hero.png`、`promo-workbench.png`、`og-image.png` 已可用于介绍页与分享卡片；上架商店前仍建议换成带真实运行数据的设备截图。
4. **OG 分享图**：`<meta property="og:image">` 指向 `./og-image.png`，已生成 1200×630 方向的分享图。
5. **域名与 theme-color**：按品牌确认。

## 设计令牌来源

所有颜色 / 字号 / 圆角 / 间距 / 组件都取自仓库根的 `DESIGN-apple.md`，并在 `index.html` 顶部的 `:root` 里落为 CSS 变量。改主题色只需改 `--primary` 一处（全站交互色单一，不引入第二强调色）。
