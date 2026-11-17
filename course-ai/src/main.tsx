import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./globals.css";
import "./i18n";
import { startJobListener } from "@/stores/jobs";
import { startDownloadListener } from "@/stores/downloads";
import { startNativeInsets } from "@/lib/nativeInsets";
import { startPlaybackHydration } from "@/lib/playback";

startJobListener();
startDownloadListener();
startNativeInsets();
// 播放进度以库为准：启动和回到前台时把库里的（含别的设备同步来的）回填进本地缓存。
startPlaybackHydration();

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
