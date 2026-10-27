export interface Course {
  id: string;
  name: string;
  root_path: string;
  cover_image: string | null;
  created_at: number;
  updated_at: number;
  /** 课程下的视频数（未删除）。后端列表接口聚合返回。 */
  video_count: number;
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
  // B 站分 P 的 cid：弹幕接口按它寻址；导入时反查到会落回库里。
  bilibili_cid?: string | null;
}

/** 一条弹幕。按 start_ms 排期，mode 决定滚动/顶部/底部。 */
export interface DanmakuEntry {
  mode: "scroll" | "top" | "bottom";
  start_ms: number;
  text: string;
  /** 弹幕颜色（#RRGGBB）；null = B 站默认白。 */
  color: string | null;
  font_size: number | null;
}

/** 一条评论：根评论（parent_rpid 为 null）或楼中楼回复。只作静态展示。 */
export interface CommentEntry {
  /** B 站评论 id（超出 JS 安全整数，后端转成字符串）。 */
  rpid: string | null;
  author: string;
  text: string;
  like_count: number;
  /** 评论时间（Unix 秒）。 */
  ctime: number;
  /** 所属根评论的 rpid；null = 根评论本身。 */
  parent_rpid: string | null;
  /** 根评论的回复总数（回复恒为 0）。 */
  reply_count: number;
  /** 「回复另一条回复」时的直接父回复 rpid；直接回复根评论时 = parent_rpid。 */
  direct_parent_rpid: string | null;
  /** B 站头像图 URL；可能为空。 */
  avatar: string | null;
}

/** 一个 B 站表情：文本标记（如 `[doge]`）→ 图片 URL。size 1 小表情 / 2 大表情。 */
export interface CommentEmote {
  text: string;
  url: string;
  size: number;
}

/** 评论区整体：评论平铺列表 + 表情映射（渲染时把标记替换成图片）。 */
export interface CommentSection {
  comments: CommentEntry[];
  emotes: CommentEmote[];
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
  | {
      kind: "open_video";
      course_id?: string | null;
      video_id: string;
      title: string;
      at_ms?: number | null;
    }
  | { kind: "seek_to"; at_ms: number }
  | {
      kind: "propose_rename";
      video_id: string;
      course_id?: string;
      course_name?: string | null;
      current_title: string;
      new_title: string;
    }
  | {
      kind: "propose_delete";
      video_id: string;
      course_id?: string;
      course_name?: string | null;
      title: string;
    }
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
      course_name?: string | null;
    }
  | { kind: "propose_create_course"; name: string; root_path: string }
  | {
      kind: "propose_rename_course";
      course_id: string;
      current_name: string;
      new_name: string;
    }
  /** 主题不走确认卡：无破坏性、一眼可见、再说一句就能改回来。 */
  | { kind: "set_theme"; pref: "dark" | "light" | "auto" }
  /** 提案：把生成好的 Markdown 追加进某视频的笔记。用户确认才写入，预览内容已包含在内。 */
  | {
      kind: "propose_create_note";
      video_id: string;
      video_title: string;
      topic: string;
      markdown: string;
    };

export type AgentStopReason =
  | "completed"
  | "summarized_after_limit"
  | "canceled"
  | "limit_reached";

export type ToolExecutionStatus = "completed" | "failed" | "canceled";

/** 一次模型请求的 token 用量（与后端 llm::Usage 对应）。 */
export interface AssistantUsage {
  prompt_tokens: number;
  cached_tokens: number;
  completion_tokens: number;
  reasoning_tokens: number;
}

export interface AssistantReply {
  answer: string;
  /** Agent 的唯一终态。可选是为了兼容尚未返回该字段的旧后端。 */
  stop_reason?: AgentStopReason;
  canceled: boolean;
  /**
   * 工具轮次或上下文预算封顶后，额外的无工具总结仍没有给出可用答复。此时 answer 多半只是某一轮的
   * 过场话（「我先查一下课程列表」），甚至是空串；总结成功时该字段为 false。
   */
  hit_turn_limit: boolean;
  actions: AssistantAction[];
  turns: number;
  tools_used: string[];
  /** 整轮全部模型请求的 token 用量合计。端点不报则为 null，界面不应显示成零消耗。 */
  usage: AssistantUsage | null;
  history: AssistantMessage[];
}

/**
 * 助手流式事件：与后端 commands::assistant::AssistantEvent 对应（tag = "type"）。
 *
 * `turn` 是必须处理的一条：助手是个多轮循环，答案**逐轮替换**而不是追加，
 * 收到新的一轮就要把已显示的正文清空，否则会拼出一段谁也没说过的话。
 */
export type AssistantEvent =
  | { type: "started" }
  | { type: "turn"; turn: number }
  | { type: "reasoning"; delta: string }
  | { type: "token"; delta: string }
  | { type: "tool"; call_id: string; name: string }
  | {
      type: "tool_finished";
      call_id: string;
      name: string;
      /** 可选是为了兼容尚未返回类型化状态的旧后端。 */
      status?: ToolExecutionStatus;
      canceled: boolean;
    }
  /** 工具链撞到轮次/预算上限，转入强制总结；到 done 为止界面应显示进行中状态。 */
  | { type: "turn_limit" }
  | { type: "done"; reply: AssistantReply }
  | { type: "error"; message: string };

/** 助手当前看到的界面状态，让「这个视频」这类说法能落到具体对象上。 */
export interface AssistantContext {
  course_id?: string | null;
  video_id?: string | null;
  position_ms?: number | null;
}
