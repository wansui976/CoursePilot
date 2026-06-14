# CoursePilot 官网主页

一个自包含的静态营销主页（`index.html`），按 `DESIGN-apple.md`（Apple 风格设计系统）生成：单一 Action Blue 强调色、明暗整幅 tile 交替、SF Pro / Inter 字体、pill 形 CTA、唯一产品投影、负字距、17px 正文。页面文案来自项目当前 README 和功能实现边界，强调本地优先、Bilibili / URL 下载、ASR、字幕纠错、AI 笔记、课件 / OCR、课程问答和导出能力。

## 本地预览

```bash
cd website
python3 -m http.server 8000   # 然后打开 http://localhost:8000
```

## 宣传截图资产

当前主页直接引用三张由 `screenshot-studio.html` 生成的真实 UI 模拟宣传图：

- `promo-hero.png`：首屏产品介绍图。
- `promo-workbench.png`：工作台 / 课件 / OCR 联动介绍图。
- `og-image.png`：Open Graph / 社交分享卡片，`index.html` 的 `og:image` 指向它。

重新生成时，先启动本地静态服务，再打开 `screenshot-studio.html`，分别截图 `#hero-shot`、`#workbench-shot` 和 `#og-shot`。这个 studio 页面填入了模拟课程、字幕、笔记、课件、OCR、问答和导出数据，只作为宣传截图源使用。

## 动效

主页模仿 Apple 官网的克制产品动效：

- 首屏文字、CTA 和产品图按层级轻微淡入上浮。
- 每个 full-bleed tile 进入视野时做一次 scroll reveal。
- 两张主产品图带低幅度 parallax 和极淡高光扫过。
- 顶部黑色导航在滚动后切到 frosted / translucent 状态。
- `prefers-reduced-motion: reduce` 下关闭 reveal、parallax 和高光，只保留静态页面。

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

1. **真实下载链接**：`#download` 区里两个 `store-badge` 的 `href="#"` 是占位，拿到 App Store / Google Play 链接后替换。建议同时换成两家的**官方徽章图**（当前用的是简化版图标，仅作排版占位）。
2. **隐私政策 / 使用条款页**：两家商店审核都**强制要求隐私政策 URL**。footer 与导航里的「隐私政策 / 使用条款」目前指向锚点，需替换为真实页面（可在 `website/` 下新增 `privacy.html`、`terms.html`）。
3. **产品截图**：当前 `promo-hero.png`、`promo-workbench.png`、`og-image.png` 已可用于介绍页与分享卡片；上架商店前仍建议换成带真实运行数据的设备截图。
4. **OG 分享图**：`<meta property="og:image">` 指向 `./og-image.png`，已生成 1200×630 方向的分享图。
5. **GitHub / 联系方式**：footer 的开源与联系链接待填真实地址。
6. **域名与 theme-color**：按品牌确认。

## 设计令牌来源

所有颜色 / 字号 / 圆角 / 间距 / 组件都取自仓库根的 `DESIGN-apple.md`，并在 `index.html` 顶部的 `:root` 里落为 CSS 变量。改主题色只需改 `--primary` 一处（全站交互色单一，不引入第二强调色）。
