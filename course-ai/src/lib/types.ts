export interface Course {
  id: string;
  name: string;
  root_path: string;
  cover_image: string | null;
  created_at: number;
  updated_at: number;
}

export interface Video {
  id: string;
  course_id: string;
  title: string;
  source_type: "local" | "url" | "bilibili";
  source_uri: string | null;
  file_path: string;
  duration_ms: number | null;
  width: number | null;
  height: number | null;
  order_index: number;
  data_dir: string;
  processed_status: "pending" | "processing" | "done" | "failed";
  created_at: number;
  subtitle_path?: string | null;
  subtitle_lang?: string | null;
}

export interface SubtitleTrack {
  lang: string;
  name: string;
  auto: boolean;
}

export interface ProbeResult {
  title: string;
  tracks: SubtitleTrack[];
  qualities: number[];
}

export interface TranscriptSegment {
  id: number;
  video_id: string;
  segment_idx: number;
  start_ms: number;
  end_ms: number;
  text: string;
}

export interface DevLogEntry {
  id: number;
  at_ms: number;
  kind: string;
  video_id: string;
  request: string;
  response: string;
  status: string;
}

export interface TrashedVideo {
  id: string;
  title: string;
  course_id: string;
  course_name: string;
  deleted_at: number;
  expires_at: number;
}

export interface Job {
  id: string;
  video_id: string;
  stage: string;
  status: "pending" | "running" | "done" | "failed" | "canceled";
  progress: number;
  message: string | null;
  started_at: number | null;
  finished_at: number | null;
}

export type ProviderKind = "openai" | "anthropic";

export interface LlmProfile {
  id: string;
  name: string;
  kind: ProviderKind;
  base_url: string;
  model: string;
}

export interface TaskRouting {
  notes: string | null;
  chapters: string | null;
  quiz: string | null;
  mindmap: string | null;
  rag: string | null;
  vision_ocr: string | null;
}

export interface Chapter {
  id: number;
  video_id: string;
  title: string;
  summary: string | null;
  start_ms: number;
  end_ms: number;
  order_index: number;
}

export type AiTask = "chapters" | "notes" | "quiz" | "mindmap";

export interface QuizQuestion {
  type: "single" | "multi" | "judge";
  stem: string;
  options?: string[];
  answer: string | string[] | boolean;
  explanation?: string;
  ref_ms?: number;
}

export interface Slide {
  id: number;
  video_id: string;
  image_path: string;
  composed_path: string | null;
  start_ms: number;
  end_ms: number | null;
  page_no: number;
  ocr_text: string | null;
}

export interface Screenshot {
  id: number;
  video_id: string;
  image_path: string;
  at_ms: number;
  created_at: number;
}

export interface Citation {
  index: number;
  text: string;
  start_ms: number;
  end_ms: number;
}

export interface RagAnswer {
  answer: string;
  citations: Citation[];
}
