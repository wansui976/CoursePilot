import { invoke } from "@tauri-apps/api/core";
import type {
  Chapter,
  Course,
  Job,
  LlmProfile,
  Screenshot,
  Slide,
  TranscriptSegment,
  Video,
} from "./types";

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
  ai: {
    getProfiles: (): Promise<LlmProfile[]> => invoke("cmd_get_llm_profiles"),
    saveProfiles: (profilesJson: string, routingJson: string): Promise<void> =>
      invoke("cmd_save_llm_profiles", { profilesJson, routingJson }),
    setApiKey: (profileId: string, apiKey: string): Promise<void> =>
      invoke("cmd_set_api_key", { profileId, apiKey }),
    hasApiKey: (profileId: string): Promise<boolean> =>
      invoke("cmd_has_api_key", { profileId }),
    generate: (videoId: string, task: string): Promise<void> =>
      invoke("cmd_generate_ai", { videoId, task }),
    getChapters: (videoId: string): Promise<Chapter[]> =>
      invoke("cmd_get_chapters", { videoId }),
    getNotes: (videoId: string): Promise<string | null> =>
      invoke("cmd_get_notes", { videoId }),
    saveNotes: (videoId: string, contentJson: string): Promise<void> =>
      invoke("cmd_save_notes", { videoId, contentJson }),
    getQuiz: (videoId: string): Promise<string | null> =>
      invoke("cmd_get_quiz", { videoId }),
    getMindmap: (videoId: string): Promise<string | null> =>
      invoke("cmd_get_mindmap", { videoId }),
  },
  slides: {
    extract: (videoId: string, threshold?: number): Promise<number> =>
      invoke("cmd_extract_slides", { videoId, threshold }),
    list: (videoId: string): Promise<Slide[]> =>
      invoke("cmd_get_slides", { videoId }),
    capture: (videoId: string, atMs: number): Promise<Screenshot> =>
      invoke("cmd_capture_frame", { videoId, atMs }),
    screenshots: (videoId: string): Promise<Screenshot[]> =>
      invoke("cmd_get_screenshots", { videoId }),
  },
  export: {
    subtitles: (videoId: string, format: "srt" | "vtt"): Promise<string> =>
      invoke("cmd_export_subtitles", { videoId, format }),
    notes: (videoId: string): Promise<string> =>
      invoke("cmd_export_notes", { videoId }),
  },
};
