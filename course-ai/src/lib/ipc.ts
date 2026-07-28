import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { SkipRange } from "./silenceSkip";
import type {
  AskEvent,
  ChatMessage,
  Chapter,
  Citation,
  Clip,
  Course,
  DevLogEntry,
  Job,
  LlmProfile,
  PlaylistInfo,
  ProbeResult,
  RagAnswer,
  RelinkResult,
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

export interface NativeCloudSyncStatus {
  accountStatus: string;
  started: boolean;
  pendingChanges: number;
  lastError?: string | null;
  nativeBridgeAvailable: boolean;
}

export interface CloudSyncStatus {
  deviceId: string;
  enabled: boolean;
  bootstrapComplete: boolean;
  pendingOutbox: number;
  incomingFiles: number;
  native: NativeCloudSyncStatus;
}

export interface CloudSyncProbeResult {
  probeId: string;
  native: NativeCloudSyncStatus;
}

/** 目录扫描出的可导入视频（批量导入用）。 */
export interface FolderVideo {
  path: string;
  name: string;
}

/** 间隔重复：到期待复习卡片。 */
export interface DueCard {
  id: string;
  video_id: string | null;
  course_id: string | null;
  front: string;
  back: string;
  source_ms: number | null;
  question_type?: "single" | "multi" | "judge" | null;
  options?: string[] | null;
  correct_options?: string[] | null;
}

/** 某概念的待复习卡片数（概念面板「复习 N」）。 */
export interface ConceptDue {
  concept_id: string;
  due: number;
}

/** 薄弱主题：某概念的复习表现（差评率越高越薄弱）。 */
export interface WeakConcept {
  concept_id: string;
  name: string;
  course_id: string;
  course_name: string;
  reviews: number;
  fails: number;
  again_rate: number;
}

/** 学习统计：按本地日聚合的观看毫秒与复习张数。 */
export interface DayTotal {
  day: string;
  watched_ms: number;
  /** 当天复习的卡片张数（只复习没看视频的一天也算学习了）。 */
  reviews: number;
  /** 其中评分「良好/容易」的张数。 */
  good_reviews: number;
}

/** 某视频的播放进度（毫秒）。完成度按 position/duration 判定。 */
export interface VideoProgress {
  video_id: string;
  position_ms: number;
  duration_ms: number | null;
}

/** 学习统计：每门课累计观看毫秒与最近学习时刻。 */
export interface CourseTotal {
  course_id: string;
  watched_ms: number;
  last_ts: number;
}

/** 「继续学习」条目：每门课上次看到的视频（供一键续播）。 */
export interface ContinueRow {
  course_id: string;
  course_name: string;
  video_id: string;
  video_title: string;
  last_ts: number;
}

/** 概念的一处出现（带视频标题，供点击跳转）。 */
export interface ConceptOccurrence {
  video_id: string;
  video_title: string;
  start_ms: number;
  end_ms?: number | null;
  excerpt?: string | null;
}

/** 课程里的一个概念及其出现位置。 */
export interface CourseConcept {
  id: string;
  name: string;
  summary?: string | null;
  /** 展开知识点时展示的一段 AI 解释（分析时依据字幕片段预生成）。 */
  explanation?: string | null;
  occurrences: ConceptOccurrence[];
}

export interface CourseKnowledgeGroup {
  title: string;
  summary: string | null;
  concepts: CourseConcept[];
}

/** 课程知识分析进度：已处理视频数 / 总数 / 当前视频标题。 */
export interface AnalyzeProgress {
  done: number;
  total: number;
  title: string;
}

/**
 * 课件提取进度。`sample` 是降采样通读整段视频（耗时大头，total 为估算的采样帧数，
 * 拿不到时长时为 0），`capture` 是逐页截全分辨率图（total 为页数）。
 */
export interface SlidesProgress {
  phase: "sample" | "capture";
  done: number;
  total: number;
}

type SlidesExtractEvent = { type: "progress" } & SlidesProgress;

/** 课件页 OCR 进度：已识别页数 / 待识别总数。 */
export interface SlidesOcrProgress {
  done: number;
  total: number;
}

type SlidesOcrEvent = { type: "progress" } & SlidesOcrProgress;

/** 分析命令通过 `concept-analyze:<requestId>` 事件推送的进度 / 完成 / 出错。 */
type AnalyzeEvent =
  | ({ type: "progress" } & AnalyzeProgress)
  | { type: "done"; count: number }
  | { type: "error"; message: string };

/** 首页课程知识页：总览、主题分组及可回看的真实字幕来源。 */
export interface CourseKnowledge {
  overview: string | null;
  groups: CourseKnowledgeGroup[];
  generated_at: number | null;
  covered_videos: number;
  total_videos: number;
  stale: boolean;
}

export const ipc = {
  sync: {
    status: (): Promise<CloudSyncStatus> => invoke("cmd_sync_status"),
    start: (): Promise<CloudSyncStatus> => invoke("cmd_sync_start"),
    setEnabled: (enabled: boolean): Promise<CloudSyncStatus> =>
      invoke("cmd_sync_set_enabled", { enabled }),
    syncNow: (): Promise<CloudSyncStatus> => invoke("cmd_sync_now"),
    probe: (): Promise<CloudSyncProbeResult> => invoke("cmd_sync_probe"),
  },
  courses: {
    list: (): Promise<Course[]> => invoke("cmd_list_courses"),
    create: (name: string, rootPath: string): Promise<Course> =>
      invoke("cmd_create_course", { name, rootPath }),
    delete: (id: string): Promise<void> => invoke("cmd_delete_course", { id }),
    rename: (id: string, name: string): Promise<void> =>
      invoke("cmd_rename_course", { id, name }),
    relinkRoot: (courseId: string, newRoot: string): Promise<RelinkResult> =>
      invoke("cmd_relink_course_root", { courseId, newRoot }),
  },
  videos: {
    list: (courseId: string): Promise<Video[]> =>
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
  },
  trash: {
    list: (): Promise<TrashedVideo[]> => invoke("cmd_list_trash"),
    // 清空回收站，返回清除数量。
    purgeAll: (): Promise<number> => invoke("cmd_purge_trash"),
  },
  srs: {
    // 从出题结果生成/更新复习卡，返回卡片数。
    generate: (videoId: string): Promise<number> =>
      invoke("cmd_generate_cards", { videoId }),
    // 只整理实际归属于该知识点的测验卡；同视频的其他题不会被生成或更新。
    generateForConcept: (courseId: string, conceptId: string): Promise<number> =>
      invoke("cmd_generate_cards_for_concept", { courseId, conceptId }),
    // 手动新建一张卡（如文稿挖空 cloze），立即到期。返回卡 id。
    addCard: (
      videoId: string,
      kind: string,
      front: string,
      back: string,
      sourceMs: number | null,
    ): Promise<string> =>
      invoke("cmd_add_card", { videoId, kind, front, back, sourceMs }),
    // 到期待复习卡（跨课程）。
    due: (limit: number): Promise<DueCard[]> => invoke("cmd_due_cards", { limit }),
    // 今日待复习张数。
    countDue: (): Promise<number> => invoke("cmd_count_due"),
    // 复习评分：1=重来 2=困难 3=良好 4=容易。
    review: (cardId: string, rating: number): Promise<void> =>
      invoke("cmd_review_card", { cardId, rating }),
    // 某课程每个概念的待复习卡数（现算，供概念面板显示「复习 N」）。
    conceptDueCounts: (courseId: string): Promise<ConceptDue[]> =>
      invoke("cmd_concept_due_counts", { courseId }),
    // 某课程某概念下的到期卡（供按概念复习）。
    dueByConcept: (courseId: string, conceptId: string): Promise<DueCard[]> =>
      invoke("cmd_due_cards_by_concept", { courseId, conceptId }),
    // 全局薄弱主题（差评率高的概念在前），供仪表盘推送。
    weakConcepts: (): Promise<WeakConcept[]> => invoke("cmd_weak_concepts"),
    // 每门课的到期待复习卡数 [course_id, due]（供课程卡「待复习」徽章）。
    dueByCourse: (): Promise<[string, number][]> => invoke("cmd_due_by_course"),
  },
  stats: {
    // 记一段实际观看毫秒（<=0 后端忽略）。
    logWatch: (videoId: string, watchedMs: number): Promise<void> =>
      invoke("cmd_log_watch", { videoId, watchedMs }),
    // [fromTs,toTs] 内按本地日聚合的观看毫秒（升序）。
    dailyTotals: (fromTs: number, toTs: number): Promise<DayTotal[]> =>
      invoke("cmd_daily_totals", { fromTs, toTs }),
    // 每门课累计观看时长与最近学习时刻。
    courseTotals: (): Promise<CourseTotal[]> => invoke("cmd_course_totals"),
    // 每门课上次看到的视频（按最近学习倒序），供仪表盘一键续播。
    continueLearning: (): Promise<ContinueRow[]> => invoke("cmd_continue_learning"),
    // 所有未删除视频的 [course_id, video_id]（课程完成度的分母）。
    courseVideoIds: (): Promise<[string, string][]> => invoke("cmd_course_video_ids"),
    // 下一批复习到期的时刻（毫秒），没有排期中的卡则为 null。
    nextDueAt: (): Promise<number | null> => invoke("cmd_next_due_at"),
    // 落库一个视频的播放进度（完成度以库里这份为准，本地记录只是热路径缓存）。
    saveVideoProgress: (
      videoId: string,
      positionMs: number,
      durationMs: number | null,
    ): Promise<void> => invoke("cmd_save_video_progress", { videoId, positionMs, durationMs }),
    // 所有未删除视频的播放进度。
    videoProgress: (): Promise<VideoProgress[]> => invoke("cmd_video_progress"),
  },
  concepts: {
    // 分析本课程概念（会调多次 LLM，耗时）。命令立即返回、活儿丢后台跑，逐视频进度经
    // `concept-analyze:<requestId>` 事件实时到达；最终入库概念数从 done 事件取回。
    analyze: async (
      courseId: string,
      requestId: string,
      onProgress: (progress: AnalyzeProgress) => void,
    ): Promise<number> => {
      let resolveCount!: (count: number) => void;
      let rejectCount!: (error: unknown) => void;
      const count = new Promise<number>((res, rej) => {
        resolveCount = res;
        rejectCount = rej;
      });
      // 先注册监听再 invoke，避免漏掉早到的事件。
      const unlisten = await listen<AnalyzeEvent>(`concept-analyze:${requestId}`, (evt) => {
        const e = evt.payload;
        if (e.type === "progress") onProgress(e);
        else if (e.type === "done") resolveCount(e.count);
        else if (e.type === "error") rejectCount(new Error(e.message));
      });
      try {
        // 命令本身只在「配置错误（未配 Profile 等）」时才 reject。
        await invoke("cmd_analyze_course_concepts", { courseId, requestId });
        return await count;
      } catch (err) {
        rejectCount(err);
        throw err;
      } finally {
        unlisten();
      }
    },
    // 取消进行中的分析：分析循环会在下个视频/片段前停下且不写库。
    cancelAnalyze: (requestId: string): Promise<void> =>
      invoke("cmd_cancel_course_analysis", { requestId }),
    // 列出本课程已抽取的概念（未分析则空表）。
    list: (courseId: string): Promise<CourseConcept[]> =>
      invoke("cmd_list_course_concepts", { courseId }),
    // 课程知识页完整载荷；旧概念数据会由后端兼容为单一分组。
    get: (courseId: string): Promise<CourseKnowledge> =>
      invoke("cmd_get_course_knowledge", { courseId }),
    // 仅基于已有概念生成课程总览与主题，不重新扫描全课字幕。
    summarize: (courseId: string): Promise<void> =>
      invoke("cmd_generate_course_knowledge", { courseId }),
    // 以整门课程的总览+知识点为背景的流式问答。命令立即返回、活儿丢后台跑，token 与最终
    // 结果都走 `course-chat:<requestId>` 事件到达；先注册监听再 invoke，避免漏早到的事件。
    chat: async (
      courseId: string,
      query: string,
      history: ChatMessage[],
      requestId: string,
      onEvent: (e: AskEvent) => void,
    ): Promise<string> => {
      let resolveAnswer!: (a: string) => void;
      let rejectAnswer!: (e: unknown) => void;
      const answer = new Promise<string>((res, rej) => {
        resolveAnswer = res;
        rejectAnswer = rej;
      });
      const unlisten = await listen<AskEvent>(`course-chat:${requestId}`, (evt) => {
        const e = evt.payload;
        if (e.type === "done") resolveAnswer(e.answer);
        else if (e.type === "error") rejectAnswer(new Error(e.message));
        else onEvent(e);
      });
      try {
        // 命令本身只在「配置错误（未配 Profile 等）」时才 reject。
        await invoke("cmd_course_knowledge_chat_stream", { courseId, query, history, requestId });
        return await answer;
      } catch (err) {
        rejectAnswer(err);
        throw err;
      } finally {
        unlisten();
      }
    },
    // 停止进行中的课程问答：登记表全局按 requestId 共用，复用 rag 的取消命令即可。
    cancelChat: (requestId: string): Promise<void> =>
      invoke("cmd_cancel_rag_query", { requestId }),
  },
  secrets: {
    // 保存敏感凭证（ASR/OCR 密钥）到密钥存储。
    set: (name: string, value: string): Promise<void> =>
      invoke("cmd_set_secret", { name, value }),
    // 是否已配置某项凭证（只回布尔、不回读明文），供设置页显示「已配置」。
    has: (name: string): Promise<boolean> => invoke("cmd_has_secret", { name }),
  },
  dev: {
    logs: (): Promise<DevLogEntry[]> => invoke("cmd_get_dev_logs"),
    clearLogs: (): Promise<void> => invoke("cmd_clear_dev_logs"),
  },
  // 发一条系统桌面通知（学习提醒）。触发时机与去重由前端决定。
  notify: (title: string, body: string): Promise<void> =>
    invoke("cmd_notify", { title, body }),
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
    active: (): Promise<Video[]> => invoke("cmd_list_processing_videos"),
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
  },
  slides: {
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
    // 识别课件页上的文字。已认过的页跳过（force 为真时全部重认），返回本次认出的页数。
    ocr: async (
      videoId: string,
      requestId?: string,
      force?: boolean,
      onProgress?: (progress: SlidesOcrProgress) => void,
    ): Promise<number> => {
      if (!requestId) return invoke("cmd_ocr_slides", { videoId, force });
      // 先注册监听再 invoke，避免漏掉早到的事件。
      const unlisten = await listen<SlidesOcrEvent>(`slides-ocr:${requestId}`, (evt) => {
        if (evt.payload.type === "progress") onProgress?.(evt.payload);
      });
      try {
        return await invoke<number>("cmd_ocr_slides", { videoId, requestId, force });
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
  },
  clips: {
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
    importBilibili: (
      courseId: string,
      url: string,
      maxHeight?: number,
      subLang?: string,
      // 本次导入的字幕 AI 纠错偏好；undefined = 跟随全局设置。
      subtitleAutocorrect?: boolean,
    ): Promise<Video> =>
      invoke("cmd_import_bilibili", {
        courseId,
        url,
        maxHeight,
        subLang,
        subtitleAutocorrect,
      }),
    probeBilibili: (url: string): Promise<ProbeResult> =>
      invoke("cmd_probe_bilibili", { url }),
    // 扁平枚举播放列表/合集（不下载正片），得到各集清单。
    probePlaylist: (url: string): Promise<PlaylistInfo> =>
      invoke("cmd_probe_playlist", { url }),
    setBilibiliCookies: (filePath: string): Promise<void> =>
      invoke("cmd_set_bilibili_cookies", { filePath }),
    hasBilibiliCookies: (): Promise<boolean> =>
      invoke("cmd_has_bilibili_cookies"),
  },
};
