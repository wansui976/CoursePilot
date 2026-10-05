/** 课程库：课程、视频与回收站。 */
import { invoke } from "@tauri-apps/api/core";
import type { CropStatus } from "../blackBars";
import type { SkipRange } from "../silenceSkip";
import type {
  Course,
  RelinkResult,
  TrashedVideo,
  Video,
  VideoListItem,
} from "../types";
import type {
  FolderVideo,
} from "./types";

export const courses = {
  list: (): Promise<Course[]> => invoke("cmd_list_courses"),
  create: (name: string, rootPath: string): Promise<Course> =>
    invoke("cmd_create_course", { name, rootPath }),
  delete: (id: string): Promise<void> => invoke("cmd_delete_course", { id }),
  rename: (id: string, name: string): Promise<void> =>
    invoke("cmd_rename_course", { id, name }),
  relinkRoot: (courseId: string, newRoot: string): Promise<RelinkResult> =>
    invoke("cmd_relink_course_root", { courseId, newRoot }),
};

export const videos = {
  list: (courseId: string): Promise<VideoListItem[]> =>
    invoke("cmd_list_videos", { courseId }),
  addLocal: (
    courseId: string,
    filePath: string,
    durationMs?: number | null,
  ): Promise<Video> => invoke("cmd_add_local_video", { courseId, filePath, durationMs }),
  // 枚举目录顶层的视频文件（自然序）。
  scanFolder: (dir: string): Promise<FolderVideo[]> =>
    invoke("cmd_scan_folder", { dir }),
  // 批量导入本地视频（幂等：已导入的文件跳过）。返回新增/既有的视频。
  addLocalBatch: (courseId: string, paths: string[]): Promise<Video[]> =>
    invoke("cmd_add_local_batch", { courseId, paths }),
  ensurePlayable: (videoId: string): Promise<string> =>
    invoke("cmd_ensure_playable", { videoId }),
  // 查询黑边探测结果：已测过返回 insets；没测过后台起任务并返回 detecting=true（轮询等结果）。
  ensureCrop: (videoId: string): Promise<CropStatus> =>
    invoke("cmd_ensure_crop", { videoId }),
  // 离开视频时停掉它的黑边探测：探测要解码正片三处，切走了就没人要这个结果，
  // 留着只会和下一个视频的起播抢磁盘。
  cancelCropDetect: (videoId: string): Promise<void> =>
    invoke("cmd_cancel_crop_detect", { videoId }),
  mediaUrl: (videoId: string): Promise<string> =>
    invoke("cmd_media_url", { videoId }),
  // 原始二进制（后端 ipc::Response），不是 JSON 数字数组。
  cover: (videoId: string): Promise<ArrayBuffer> =>
    invoke("cmd_video_cover", { videoId }),
  updateTitle: (id: string, title: string): Promise<Video> =>
    invoke("cmd_update_video_title", { id, title }),
  delete: (id: string): Promise<void> => invoke("cmd_delete_video", { id }),
  restore: (id: string): Promise<void> => invoke("cmd_restore_video", { id }),
  purge: (id: string): Promise<void> => invoke("cmd_purge_video", { id }),
  // 手动排序：orderedIds 须为该课程当前全部视频 id 的新顺序。
  reorder: (courseId: string, orderedIds: string[]): Promise<void> =>
    invoke("cmd_reorder_videos", { courseId, orderedIds }),
  // 可跳过的停顿区间。首次调用会扫一遍音轨（只解码音频），之后直接读库。
  skips: (videoId: string): Promise<SkipRange[]> =>
    invoke("cmd_video_skips", { videoId }),
};

export const trash = {
  list: (): Promise<TrashedVideo[]> => invoke("cmd_list_trash"),
  // 清空回收站，返回清除数量。
  purgeAll: (): Promise<number> => invoke("cmd_purge_trash"),
};
