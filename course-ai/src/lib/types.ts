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
  // 视频级字幕 AI 纠错偏好（B站导入时勾选）；缺省/NULL = 跟随全局设置。
  subtitle_autocorrect?: boolean | null;
  // 自带黑边四边裁剪占比（0~1），导入时 cropdetect 探测；缺省/NULL=无黑边。
  crop_top?: number | null;
  crop_right?: number | null;
  crop_bottom?: number | null;
  crop_left?: number | null;
}

/**
 * 视频列表里的一条，比 Video 多一件事：库里到底有没有文稿。
 *
 * 菜单要靠它决定给「重新纠错」还是「开始处理」。自带字幕的视频在下载完当场就打上了
 * 字幕标记，那时流水线还没跑、一个字都没有——只看标记的话，菜单会对着一份不存在的
 * 文稿提议纠错，而那恰恰是唯一需要「开始处理」的情形。只有列表接口返回它。
 */
export interface VideoListItem extends Video {
  has_transcript: boolean;
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

/** 播放列表/合集里的一集。 */
export interface PlaylistEpisode {
  url: string;
  title: string;
  duration_ms: number | null;
}

/** 播放列表/合集探测结果。 */
export interface PlaylistInfo {
  title: string;
  episodes: PlaylistEpisode[];
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

/**
 * 一档 LLM 调用的累计用量。
 *
 * cached_tokens / prompt_tokens 就是这一档的缓存命中率；reasoning_tokens 是计费在
 * 输出里、但只读正式回答、并不使用的思考 token——那部分钱花得有没有道理，
 * 得先看得见才谈得上。
 */
export interface LlmUsageTotals {
  label: string;
  model: string;
  calls: number;
  prompt_tokens: number;
  cached_tokens: number;
  completion_tokens: number;
  reasoning_tokens: number;
}

export interface TrashedVideo {
  id: string;
  title: string;
  course_id: string;
  course_name: string;
  duration_ms: number | null;
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

/** 只剩 OpenAI 兼容一种通道。Claude 走 Anthropic 的兼容层地址，同样是这个类型。 */
export type ProviderKind = "openai";

export interface LlmProfile {
  id: string;
  name: string;
  kind: ProviderKind;
  base_url: string;
  model: string;
}

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
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

export interface Clip {
  id: number;
  video_id: string;
  start_ms: number;
  end_ms: number;
  note: string;
  created_at: number;
}

export interface Citation {
  index: number;
  text: string;
  start_ms: number;
  end_ms: number;
  /** 跨视频（课程级/全部）搜索时带来源；单视频搜索为 undefined。 */
  video_id?: string;
  video_title?: string;
  /** 命中来自课件页时带页图路径与页号；字幕命中为 undefined。 */
  slide_image?: string;
  slide_page?: number;
}

export interface RagAnswer {
  answer: string;
  citations: Citation[];
}

export interface RelinkResult {
  total: number;
  relinked: number;
  ambiguous: string[];
  missing: string[];
}

/** 问答流式事件：与后端 rag::AskEvent 对应（tag = "type"）。 */
export type AskEvent =
  | { type: "status"; text: string }
  | { type: "reasoning"; delta: string }
  | { type: "token"; delta: string }
  | { type: "citations"; citations: Citation[] }
  | { type: "done"; answer: string }
  | { type: "error"; message: string };

// ---------- 全局助手 ----------

/** 助手对话里的一轮。工具往返也在里面，原样传回后端即可继续追问。 */
export interface AssistantMessage {
  role: string;
  content: string;
  tool_calls?: { id: string; name: string; arguments: string }[];
  tool_call_id?: string;
}

/**
 * 助手想让界面做的事。
 *
 * 分两类，界面必须区别对待：`open_video` / `seek_to` 是待点击导航动作，工具调用本身不会直接执行；
 * 其余 `propose_*` 是**提案**——后端一个字节都没改，必须渲染成确认卡，用户点了才落地。
 */
export type AssistantAction =
  | { kind: "open_video"; video_id: string; title: string; at_ms?: number | null }
  | { kind: "seek_to"; at_ms: number }
  | {
      kind: "propose_rename";
      video_id: string;
      current_title: string;
      new_title: string;
    }
  | { kind: "propose_delete"; video_id: string; title: string }
  | {
      kind: "propose_setting";
      key: string;
      label: string;
      current?: string | null;
      value: string;
    }
  | {
      kind: "propose_import";
      url: string;
      title: string;
      course_id?: string | null;
    }
  | { kind: "propose_create_course"; name: string; root_path: string }
  | {
      kind: "propose_rename_course";
      course_id: string;
      current_name: string;
      new_name: string;
    }
  /** 主题不走确认卡：无破坏性、一眼可见、再说一句就能改回来。 */
  | { kind: "set_theme"; pref: "dark" | "light" | "auto" };

export interface AssistantReply {
  answer: string;
  canceled: boolean;
  actions: AssistantAction[];
  turns: number;
  tools_used: string[];
  history: AssistantMessage[];
}

/** 助手当前看到的界面状态，让「这个视频」这类说法能落到具体对象上。 */
export interface AssistantContext {
  course_id?: string | null;
  video_id?: string | null;
  position_ms?: number | null;
}
