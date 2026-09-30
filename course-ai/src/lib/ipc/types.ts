/** ipc 各领域共用的载荷与进度事件类型。 */

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

export interface CloudSyncProbeAccountChangeResult {
  changed: boolean;
  native: NativeCloudSyncStatus;
}

export interface CloudSyncStatus {
  deviceId: string;
  enabled: boolean;
  bootstrapComplete: boolean;
  pendingOutbox: number;
  incomingFiles: number;
  native: NativeCloudSyncStatus;
}

export interface CloudSyncProbeArmResult {
  sessionCode: string;
  sessionId: string;
  expiresAtMs: number;
  native: NativeCloudSyncStatus;
}

export interface CloudSyncProbeStatus {
  sessionId: string;
  requestId?: string | null;
  state:
    | "armed"
    | "expired"
    | "sending"
    | "waitingForReceipt"
    | "backgroundDeliveryNotObserved"
    | "waitingForReplay"
    | "waitingForReplayAck"
    | "waitingForReplayReceipt"
    | "duplicateApplicationDetected"
    | "complete";
  requestCloudAcked: boolean;
  receiptReceived: boolean;
  sameICloudAccount: boolean;
  firstDeliveryTrigger?: string | null;
  firstDeliveryAppState?: string | null;
  replayCount: number;
  replayBaselineDeliveries?: number | null;
  replayCloudAcked: boolean;
  observedDeliveries: number;
  appliedCount: number;
}

export interface CloudSyncProbeStopResult {
  status: CloudSyncProbeStatus;
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
  /**
   * 四个评分档按下去各自会推到多久之后（毫秒，下标 0..3 对应 重来/困难/良好/容易）。
   * 由后端用与真正落库排期同一个函数算出，不在前端重算——按钮上写的必须是会发生的事。
   */
  preview_ms: number[];
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

export type SlidesExtractEvent = { type: "progress" } & SlidesProgress;

/** 课件页 OCR 进度：已识别页数 / 待识别总数。 */
export interface SlidesOcrProgress {
  done: number;
  total: number;
}

export type SlidesOcrEvent = { type: "progress" } & SlidesOcrProgress;

/**
 * 一次批量识别的结果。
 *
 * 原来这里只有一个「认出几页」的数字，部分失败根本传不出来：只要有一页成功，
 * 界面就弹绿色的成功提示——哪怕后面几十页全因为额度耗尽失败了。
 */
export interface SlidesOcrOutcome {
  recognized: number;
  failed: number;
  total: number;
  attempted: number;
  stoppedEarly: boolean;
  canceled: boolean;
  error: string | null;
}

/** 分析命令通过 `concept-analyze:<requestId>` 事件推送的进度 / 完成 / 出错。 */
export type AnalyzeEvent =
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
