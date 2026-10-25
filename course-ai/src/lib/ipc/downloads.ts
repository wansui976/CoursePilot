import { invoke } from "@tauri-apps/api/core";
import type { DownloadJob, DownloadRequest } from "./types";

/**
 * 后台下载队列。入队立刻返回快照，真正的下载在 Rust 后台跑；进度走
 * `download:update` 全局事件（见 stores/downloads）。
 */
export const downloads = {
  enqueue: (courseId: string, items: DownloadRequest[]): Promise<DownloadJob[]> =>
    invoke("cmd_enqueue_downloads", { courseId, items }),
  list: (): Promise<DownloadJob[]> => invoke("cmd_list_downloads"),
  cancel: (id: string): Promise<void> => invoke("cmd_cancel_download", { id }),
  /** 全部取消：连同已下完、正排着等处理的视频也不再处理。 */
  cancelAll: (): Promise<void> => invoke("cmd_cancel_all_downloads"),
  remove: (id: string): Promise<void> => invoke("cmd_remove_download", { id }),
};
