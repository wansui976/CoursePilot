# 应用图标

「板书与荧光笔」：黑板（`--board`）上粉笔画的播放键，下面一道荧光笔（`--marker-strong`），黑板下沿是木槽（`--wood*`）和一截粉笔。

三份源图，改图时三份一起改（形状都在同一段里，只是摆法不同）：

- `icon-master.svg`：桌面（macOS / Windows / Linux），留边的圆角方块。
- `icon-master-fullbleed.svg`：iOS 和 Android 旧式图标，铺满方块，系统自己裁圆角。
- `icon-master-android-foreground.svg`：Android 自适应图标前景，画面缩在安全区内，木槽延伸到底边；背景色 `#17211c`。

重新生成（在 `course-ai/` 下，`render-icon.mjs` 用 Playwright 的 Chromium 把 SVG 渲成 1024px PNG，粉笔颗粒是 SVG 滤镜）：

```bash
node src-tauri/icons/render-icon.mjs src-tauri/icons/icon-master-fullbleed.svg /tmp/full.png
node src-tauri/icons/render-icon.mjs src-tauri/icons/icon-master.svg /tmp/padded.png
pnpm tauri icon /tmp/full.png --ios-color '#17211c'
pnpm tauri icon /tmp/padded.png -o /tmp/desktop-icons
```

然后把 `/tmp/desktop-icons` 里的桌面图标（`*.png`、`icon.icns`、`icon.ico`）拷回本目录，再把 `icon-master-android-foreground.svg` 渲出来缩成各密度的 `ic_launcher_foreground.png`（108 / 162 / 216 / 324 / 432）。
