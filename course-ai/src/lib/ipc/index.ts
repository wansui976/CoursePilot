/**
 * 前端到 Tauri 后端的唯一通道。按领域拆在同目录各文件里，这里汇总成一个 `ipc` 对象：
 * 调用方和测试（`vi.mock("@/lib/ipc")`）都只认这个入口。
 */
import {
  app,
  sync,
  secrets,
  notify,
  settings,
  whisper,
  ocrModel,
  aiUsage,
  backup,
  tools,
  clientStore,
  semantic,
  remoteSync,
  lanShare,
  webdavImport,
  weather,
} from "./system";
import { downloads } from "./downloads";
import { chaoxing } from "./chaoxing";
import { courses, folders, videos, trash, subscriptions } from "./library";
import { srs, stats, concepts, feynman, reviewBook } from "./study";
export { feynmanTopicKey } from "./study";
import { assistant } from "./assistant";
import { pipeline, transcripts, ai, slides, clips, exporting, danmaku, translation } from "./media";

export * from "./types";

export const ipc = {
  app,
  weather,
  sync,
  clientStore,
  semantic,
  remoteSync,
  lanShare,
  webdavImport,
  courses,
  folders,
  videos,
  trash,
  subscriptions,
  srs,
  feynman,
  stats,
  concepts,
  reviewBook,
  secrets,
  notify,
  assistant,
  settings,
  whisper,
  ocrModel,
  aiUsage,
  pipeline,
  transcripts,
  ai,
  slides,
  clips,
  export: exporting,
  translation,
  backup,
  tools,
  danmaku,
  downloads,
  chaoxing,
};
