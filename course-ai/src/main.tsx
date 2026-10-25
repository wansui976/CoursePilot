import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./globals.css";
import "./i18n";
import { startJobListener } from "@/stores/jobs";
import { startDownloadListener } from "@/stores/downloads";
import { startNativeInsets } from "@/lib/nativeInsets";

startJobListener();
startDownloadListener();
startNativeInsets();

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
