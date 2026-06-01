import { invoke } from "@tauri-apps/api/core";
import type { Course, Job, TranscriptSegment, Video } from "./types";

export interface WhisperModel {
  id: string;
  display_name: string;
  size_bytes: number;
  url: string;
}

export const ipc = {
  courses: {
    list: (): Promise<Course[]> => invoke("cmd_list_courses"),
    create: (name: string, rootPath: string): Promise<Course> =>
      invoke("cmd_create_course", { name, rootPath }),
    delete: (id: string): Promise<void> => invoke("cmd_delete_course", { id }),
  },
  videos: {
    list: (courseId: string): Promise<Video[]> =>
      invoke("cmd_list_videos", { courseId }),
    addLocal: (courseId: string, filePath: string): Promise<Video> =>
      invoke("cmd_add_local_video", { courseId, filePath }),
  },
  settings: {
    get: (key: string): Promise<string | null> =>
      invoke("cmd_get_setting", { key }),
    set: (key: string, value: string): Promise<void> =>
      invoke("cmd_set_setting", { key, value }),
  },
  whisper: {
    list: (): Promise<[WhisperModel, boolean][]> =>
      invoke("cmd_list_whisper_models"),
    download: (id: string): Promise<void> =>
      invoke("cmd_download_whisper_model", { id }),
  },
  pipeline: {
    process: (videoId: string): Promise<void> =>
      invoke("cmd_process_video", { videoId }),
    jobs: (videoId: string): Promise<Job[]> =>
      invoke("cmd_list_jobs", { videoId }),
  },
  transcripts: {
    list: (videoId: string): Promise<TranscriptSegment[]> =>
      invoke("cmd_list_transcripts", { videoId }),
  },
};
