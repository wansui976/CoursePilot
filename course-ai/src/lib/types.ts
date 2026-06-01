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
