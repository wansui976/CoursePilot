import { invoke } from "@tauri-apps/api/core";
import type {
  ChatMessage,
  Chapter,
  Citation,
  Course,
  DevLogEntry,
  Job,
  LlmProfile,
  RagAnswer,
  Screenshot,
  Slide,
  TranscriptSegment,
  TrashedVideo,
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
    rename: (id: string, name: string): Promise<void> =>
      invoke("cmd_rename_course", { id, name }),
  },
  videos: {
    list: (courseId: string): Promise<Video[]> =>
      invoke("cmd_list_videos", { courseId }),
    addLocal: (courseId: string, filePath: string): Promise<Video> =>
      invoke("cmd_add_local_video", { courseId, filePath }),
    ensurePlayable: (videoId: string): Promise<string> =>
      invoke("cmd_ensure_playable", { videoId }),
    mediaUrl: (videoId: string): Promise<string> =>
      invoke("cmd_media_url", { videoId }),
    cover: (videoId: string): Promise<number[]> =>
      invoke("cmd_video_cover", { videoId }),
    updateTitle: (id: string, title: string): Promise<Video> =>
      invoke("cmd_update_video_title", { id, title }),
    delete: (id: string): Promise<void> => invoke("cmd_delete_video", { id }),
    restore: (id: string): Promise<void> => invoke("cmd_restore_video", { id }),
    purge: (id: string): Promise<void> => invoke("cmd_purge_video", { id }),
  },
  trash: {
    list: (): Promise<TrashedVideo[]> => invoke("cmd_list_trash"),
  },
  secrets: {
    // 保存敏感凭证（ASR/OCR 密钥）到密钥存储。
    set: (name: string, value: string): Promise<void> =>
      invoke("cmd_set_secret", { name, value }),
  },
  dev: {
    logs: (): Promise<DevLogEntry[]> => invoke("cmd_get_dev_logs"),
    clearLogs: (): Promise<void> => invoke("cmd_clear_dev_logs"),
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
    cancel: (videoId: string): Promise<void> =>
      invoke("cmd_cancel_processing", { videoId }),
    // 已有字幕时「仅重新纠错」：回到原始稿 + 重跑 AI 纠错，不重新识别。
    recorrect: (videoId: string): Promise<void> =>
      invoke("cmd_recorrect_transcript", { videoId }),
    jobs: (videoId: string): Promise<Job[]> =>
      invoke("cmd_list_jobs", { videoId }),
  },
  transcripts: {
    list: (videoId: string): Promise<TranscriptSegment[]> =>
      invoke("cmd_list_transcripts", { videoId }),
    update: (segmentId: number, text: string): Promise<void> =>
      invoke("cmd_update_transcript", { segmentId, text }),
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
    getSummary: (videoId: string): Promise<string | null> =>
      invoke("cmd_get_summary", { videoId }),
    saveNotes: (videoId: string, contentJson: string): Promise<void> =>
      invoke("cmd_save_notes", { videoId, contentJson }),
    getQuiz: (videoId: string): Promise<string | null> =>
      invoke("cmd_get_quiz", { videoId }),
    getMindmap: (videoId: string): Promise<string | null> =>
      invoke("cmd_get_mindmap", { videoId }),
    ragQuery: (
      videoId: string,
      query: string,
      history: ChatMessage[] = [],
    ): Promise<RagAnswer> => invoke("cmd_rag_query", { videoId, query, history }),
    searchTranscript: (videoId: string, query: string): Promise<Citation[]> =>
      invoke("cmd_search_transcript", { videoId, query }),
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
    image: (videoId: string, imagePath: string): Promise<number[]> =>
      invoke("cmd_read_slide_image", { videoId, imagePath }),
  },
  export: {
    subtitles: (videoId: string, format: "srt" | "vtt"): Promise<string> =>
      invoke("cmd_export_subtitles", { videoId, format }),
    notes: (videoId: string): Promise<string> =>
      invoke("cmd_export_notes", { videoId }),
    quiz: (videoId: string): Promise<string> =>
      invoke("cmd_export_quiz", { videoId }),
    mindmap: (videoId: string): Promise<string> =>
      invoke("cmd_export_mindmap", { videoId }),
  },
  tools: {
    ocr: (
      videoId: string,
      atMs: number,
      x = 0,
      y = 0,
      w = 0,
      h = 0,
    ): Promise<string> =>
      invoke("cmd_ocr_region", { videoId, atMs, x, y, w, h }),
    importBilibili: (courseId: string, url: string): Promise<Video> =>
      invoke("cmd_import_bilibili", { courseId, url }),
  },
};
