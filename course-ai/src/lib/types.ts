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
}

export interface TranscriptSegment {
  id: number;
  video_id: string;
  segment_idx: number;
  start_ms: number;
  end_ms: number;
  text: string;
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
