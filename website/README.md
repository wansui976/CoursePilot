# CoursePilot 官网主页

一个自包含的静态营销主页（`index.html`），按 `DESIGN-apple.md`（Apple 风格设计系统）生成：单一 Action Blue 强调色、明暗整幅 tile 交替、SF Pro / Inter 字体、pill 形 CTA、唯一产品投影、负字距、17px 正文。无构建步骤、无外部依赖（仅从 Google Fonts 引 Inter 作为 SF Pro 的替身）。

## 本地预览

```bash
cd website
python3 -m http.server 8000   # 然后打开 http://localhost:8000
```

## 部署

直接把 `website/` 整个目录托管即可（纯静态）：

- **GitHub Pages**：把目录设为 Pages 源，或推到 `gh-pages`。
- **Vercel / Netlify / Cloudflare Pages**：根目录指向 `website/`，无构建命令。

## 上架（App Store / Google Play）前需补齐

这页是营销主页，距离正式上架还差几块**必备资产**，下面是清单：

1. **真实下载链接**：`#download` 区里两个 `store-badge` 的 `href="#"` 是占位，拿到 App Store / Google Play 链接后替换。建议同时换成两家的**官方徽章图**（当前用的是简化版图标，仅作排版占位）。
2. **隐私政策 / 使用条款页**：两家商店审核都**强制要求隐私政策 URL**。footer 与导航里的「隐私政策 / 使用条款」目前指向锚点，需替换为真实页面（可在 `website/` 下新增 `privacy.html`、`terms.html`）。
3. **产品截图**：Hero 里的界面是 CSS 样机（占位）。上架素材与主页都建议换成**真实应用截图**（按设计系统：产品图“立”在表面上、套唯一产品投影 `rgba(0,0,0,.22) 3px 5px 30px`）。
4. **OG 分享图**：`<meta property="og:image">` 指向 `./og-image.png`，需补一张 1200×630 的分享图。
5. **GitHub / 联系方式**：footer 的开源与联系链接待填真实地址。
6. **域名与 theme-color**：按品牌确认。

## 设计令牌来源

所有颜色 / 字号 / 圆角 / 间距 / 组件都取自仓库根的 `DESIGN-apple.md`，并在 `index.html` 顶部的 `:root` 里落为 CSS 变量。改主题色只需改 `--primary` 一处（全站交互色单一，不引入第二强调色）。
