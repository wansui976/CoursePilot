/** 学习闭环：间隔复习、学习统计与课程知识点。 */
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type {
  AskEvent,
  ChatMessage,
} from "../types";
import type {
  DueCard,
  ConceptDue,
  WeakConcept,
  DayTotal,
  VideoProgress,
  CourseTotal,
  ContinueRow,
  CourseConcept,
  AnalyzeProgress,
  AnalyzeEvent,
  CourseKnowledge,
} from "./types";

export const srs = {
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
};

export const stats = {
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
};

export const concepts = {
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
};
