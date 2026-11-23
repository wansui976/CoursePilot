import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
// 设计语言用到的三款字体随应用打包（本地优先，离线也要能用）。中文走系统字体。
import "@fontsource-variable/instrument-sans";
import "@fontsource-variable/newsreader/opsz.css";
import "@fontsource-variable/newsreader/opsz-italic.css";
import "@fontsource-variable/jetbrains-mono";
import "./globals.css";
import "./i18n";
import { startJobListener } from "@/stores/jobs";
import { startDownloadListener } from "@/stores/downloads";
import { startNativeInsets } from "@/lib/nativeInsets";
import { startPlaybackHydration } from "@/lib/playback";
import { flushDurableStore, loadDurableStore } from "@/lib/durableStore";
import { preloadKatex } from "@/ui/MathText";
import { isAndroid } from "@/lib/platform";

// 平台标记：只给少数平台专属的样式用（如 Android 的中文衬线回退）。
if (isAndroid()) document.documentElement.dataset.os = "android";

startJobListener();
startDownloadListener();
startNativeInsets();
// 播放进度以库为准：启动和回到前台时把库里的（含别的设备同步来的）回填进本地缓存。
startPlaybackHydration();

// 助手对话记录存在库里：先读进内存再渲染（助手面板挂载时同步读它）。
// 读不到或超过 3 秒就照旧用 localStorage，不会卡住启动。
void loadDurableStore().finally(() => {
  // 公式渲染库不在启动包里：首屏出来以后、空闲时再加载。
  preloadKatex();
  ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
});

// 离开页面前把还没落库的对话写进去（尽力而为：IPC 是异步的，关窗时未必等得到）。
window.addEventListener("pagehide", () => void flushDurableStore());
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") void flushDurableStore();
});
