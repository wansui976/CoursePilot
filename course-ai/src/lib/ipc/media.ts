/** 单个视频的处理流水线与产物：任务、讲稿、AI 产物、课件、片段、导出、弹幕评论。 */
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type {
  AskEvent,
  Chapter,
  ChatMessage,
  Citation,
  Clip,
  CommentSection,
  DanmakuEntry,
  Job,
  LlmProfile,
  RagAnswer,
  Screenshot,
  Slide,
  TranscriptSegment,
  Video,
} from "../types";
import type {
  SlidesProgress,
  SlidesExtractEvent,
  SlidesOcrProgress,
  SlidesOcrEvent,
  SlidesOcrOutcome,
} from "./types";

export const pipeline = {
  process: (videoId: string): Promise<void> =>
    invoke("cmd_process_video", { videoId }),
  cancel: (videoId: string): Promise<void> =>
    invoke("cmd_cancel_processing", { videoId }),
  dismiss: (videoId: string): Promise<void> =>
    invoke("cmd_dismiss_processing_video", { videoId }),
  // 已有字幕时「仅重新纠错」：回到原始稿 + 重跑 AI 纠错，不重新识别。
  recorrect: (videoId: string): Promise<void> =>
    invoke("cmd_recorrect_transcript", { videoId }),
  jobs: (videoId: string): Promise<Job[]> =>
    invoke("cmd_list_jobs", { videoId }),
  active: (): Promise<Video[]> => invoke("cmd_list_processing_videos"),
};

export const transcripts = {
  list: (videoId: string): Promise<TranscriptSegment[]> =>
    invoke("cmd_list_transcripts", { videoId }),
  update: (segmentId: number, text: string): Promise<void> =>
    invoke("cmd_update_transcript", { segmentId, text }),
};

export const ai = {
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
  // 哪些 AI 产物是基于旧讲稿生成的（改过字幕、重跑过纠错、补认了课件文字之后）。
  // 只用于标「已过期」，重不重跑由用户决定。
  staleArtifacts: (videoId: string): Promise<string[]> =>
    invoke("cmd_stale_ai_artifacts", { videoId }),
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
  // scope ∈ {video, course, all}：course/all 跨视频检索问答，答案带来源引用（citations 事件）。
  ragQueryStream: async (
    videoId: string,
    scope: "video" | "course" | "all",
    query: string,
    history: ChatMessage[],
    requestId: string,
    onEvent: (e: AskEvent) => void,
  ): Promise<RagAnswer> => {
    // 命令会立刻返回、把流式活儿丢后台跑，事件（含最终 done / error）走全局事件实时到达。
    // 先注册监听再 invoke（避免漏掉早到的事件）；答案从 done 事件拿，不再靠命令返回值。
    let resolveAnswer!: (a: RagAnswer) => void;
    let rejectAnswer!: (e: unknown) => void;
    // 课程级问答的来源引用先于 done 事件到达，暂存后随最终答案一起交回。
    let citations: Citation[] = [];
    const answer = new Promise<RagAnswer>((res, rej) => {
      resolveAnswer = res;
      rejectAnswer = rej;
    });
    const unlisten = await listen<AskEvent>(`ask-stream:${requestId}`, (evt) => {
      const e = evt.payload;
      if (e.type === "citations") {
        citations = e.citations;
        onEvent(e); // 同时转发给调用方，可在流式期间就展示出处
      } else if (e.type === "done") resolveAnswer({ answer: e.answer, citations });
      else if (e.type === "error") rejectAnswer(new Error(e.message));
      else onEvent(e);
    });
    try {
      // 命令本身只在「配置错误（未配 Profile 等）」时才 reject。
      await invoke("cmd_rag_query_stream", { videoId, scope, query, history, requestId });
      return await answer;
    } catch (err) {
      rejectAnswer(err);
      throw err;
    } finally {
      unlisten();
    }
  },
  cancelRagQuery: (requestId: string): Promise<void> =>
    invoke("cmd_cancel_rag_query", { requestId }),
  // scope ∈ {video, course, all}：course/all 跨视频，引用带来源视频。
  searchTranscript: (
    videoId: string,
    scope: "video" | "course" | "all",
    query: string,
  ): Promise<Citation[]> =>
    invoke("cmd_search_transcript", { videoId, scope, query }),
};

export const slides = {
  // threshold 为单块亮度差门槛；null/省略表示让后端按画面噪声自估。
  // 给了 requestId 才有进度事件与可取消；不给就是一发到底（老行为）。
  extract: async (
    videoId: string,
    threshold?: number | null,
    requestId?: string,
    onProgress?: (progress: SlidesProgress) => void,
  ): Promise<number> => {
    if (!requestId) return invoke("cmd_extract_slides", { videoId, threshold });
    // 先注册监听再 invoke，避免漏掉早到的事件。
    const unlisten = await listen<SlidesExtractEvent>(
      `slides-extract:${requestId}`,
      (evt) => {
        if (evt.payload.type === "progress") onProgress?.(evt.payload);
      },
    );
    try {
      return await invoke<number>("cmd_extract_slides", { videoId, threshold, requestId });
    } finally {
      unlisten();
    }
  },
  // 取消进行中的提取：采样会杀掉 ffmpeg、截图会在下一页前停下，库里的旧课件页不动。
  cancelExtract: (requestId: string): Promise<void> =>
    invoke("cmd_cancel_slides_extract", { requestId }),
  // 识别课件页上的文字。已认过的页跳过（force 为真时全部重认）。
  ocr: async (
    videoId: string,
    requestId?: string,
    force?: boolean,
    onProgress?: (progress: SlidesOcrProgress) => void,
  ): Promise<SlidesOcrOutcome> => {
    if (!requestId) return invoke("cmd_ocr_slides", { videoId, force });
    // 先注册监听再 invoke，避免漏掉早到的事件。
    const unlisten = await listen<SlidesOcrEvent>(`slides-ocr:${requestId}`, (evt) => {
      if (evt.payload.type === "progress") onProgress?.(evt.payload);
    });
    try {
      return await invoke<SlidesOcrOutcome>("cmd_ocr_slides", { videoId, requestId, force });
    } finally {
      unlisten();
    }
  },
  // 取消进行中的识别：已认出文字的页留在库里，下次接着认。
  cancelOcr: (requestId: string): Promise<void> =>
    invoke("cmd_cancel_slides_ocr", { requestId }),
  list: (videoId: string): Promise<Slide[]> =>
    invoke("cmd_get_slides", { videoId }),
  capture: (videoId: string, atMs: number): Promise<Screenshot> =>
    invoke("cmd_capture_frame", { videoId, atMs }),
  screenshots: (videoId: string): Promise<Screenshot[]> =>
    invoke("cmd_get_screenshots", { videoId }),
  // 原始二进制（后端 ipc::Response），不是 JSON 数字数组。
  image: (videoId: string, imagePath: string): Promise<ArrayBuffer> =>
    invoke("cmd_read_slide_image", { videoId, imagePath }),
};

export const clips = {
  list: (videoId: string): Promise<Clip[]> =>
    invoke("cmd_list_clips", { videoId }),
  add: (
    videoId: string,
    startMs: number,
    endMs: number,
    note: string,
  ): Promise<Clip> =>
    invoke("cmd_add_clip", { videoId, startMs, endMs, note }),
  update: (
    id: number,
    startMs: number,
    endMs: number,
    note: string,
  ): Promise<void> =>
    invoke("cmd_update_clip", { id, startMs, endMs, note }),
  delete: (id: number): Promise<void> => invoke("cmd_delete_clip", { id }),
};

export const exporting = {
  subtitles: (videoId: string, format: "srt" | "vtt"): Promise<string> =>
    invoke("cmd_export_subtitles", { videoId, format }),
  notes: (videoId: string, contentMarkdown?: string): Promise<string> =>
    invoke("cmd_export_notes", { videoId, contentMarkdown }),
  quiz: (videoId: string): Promise<string> =>
    invoke("cmd_export_quiz", { videoId }),
  mindmap: (videoId: string): Promise<string> =>
    invoke("cmd_export_mindmap", { videoId }),
  /** 讲义 HTML：每页课件配讲解要点。`open` 时桌面端导出后直接用浏览器打开（自动弹打印框）。 */
  handout: (
    videoId: string,
    options: { useAi: boolean; english: boolean; open: boolean },
  ): Promise<string> => invoke("cmd_export_handout", { videoId, ...options }),
};

export const danmaku = {
  // 库里没有且是在线 B 站视频时，后端会先在线抓一次并缓存（尽力而为）。
  list: (videoId: string): Promise<DanmakuEntry[]> =>
    invoke("cmd_get_danmaku", { videoId }),
  comments: (videoId: string): Promise<CommentSection> =>
    invoke("cmd_get_comments", { videoId }),
};
