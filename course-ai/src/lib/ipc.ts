import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { Insets } from "./blackBars";
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

/** 学习统计：按本地日聚合的观看毫秒。 */
export interface DayTotal {
  day: string;
  watched_ms: number;
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
}

/** 课程里的一个概念及其出现位置。 */
export interface CourseConcept {
  id: string;
  name: string;
  occurrences: ConceptOccurrence[];
}

export const ipc = {
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
    // 打开视频时兜底补测黑边（旧视频无 crop 记录时），返回四边占比（无黑边为 0）。
    ensureCrop: (videoId: string): Promise<Insets> =>
      invoke("cmd_ensure_crop", { videoId }),
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
    // 所有未删除视频的 [course_id, video_id]（供课程完成度：已看数由本地进度判定）。
    courseVideoIds: (): Promise<[string, string][]> => invoke("cmd_course_video_ids"),
  },
  concepts: {
    // 分析本课程概念（会调多次 LLM，耗时），返回入库概念数。
    analyze: (courseId: string): Promise<number> =>
      invoke("cmd_analyze_course_concepts", { courseId }),
    // 列出本课程已抽取的概念（未分析则空表）。
    list: (courseId: string): Promise<CourseConcept[]> =>
      invoke("cmd_list_course_concepts", { courseId }),
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
    extract: (videoId: string, threshold?: number): Promise<number> =>
      invoke("cmd_extract_slides", { videoId, threshold }),
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
    setBilibiliCookies: (filePath: string): Promise<void> =>
      invoke("cmd_set_bilibili_cookies", { filePath }),
    hasBilibiliCookies: (): Promise<boolean> =>
      invoke("cmd_has_bilibili_cookies"),
  },
};
