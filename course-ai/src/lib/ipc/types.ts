/** ipc 各领域共用的载荷与进度事件类型。 */
import type { Video } from "../types";

export interface WhisperModel {
  id: string;
  display_name: string;
  size_bytes: number;
  url: string;
  /** 这台设备放得下（手机上按可用内存判断）。旧后端没有这个字段，当作放得下。 */
  fits_memory?: boolean;
}

export interface ModelsDir {
  path: string;
  is_default: boolean;
  default_path: string;
  /** 这个目录里已下载的模型一共多大。 */
  size_bytes: number;
  /** 其中已经不再使用的旧模型（Whisper、桌面上的旧版 Qwen3-ASR）占多少。 */
  legacy_bytes: number;
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
  /** B 站客户端的缓存目录：导入时先把音视频合成成一个 mp4。 */
  bilibili_cache?: boolean;
}

/** 批量导入的结果：导进来的视频，加上没导进来的文件和原因。 */
export interface BatchImport {
  videos: Video[];
  failed: ImportFailure[];
}

export interface ImportFailure {
  path: string;
  error: string;
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
  /** 所属课程。 */
  course_id: string;
  /** 最后写入时刻（毫秒；同步来的保留对端时刻）。 */
  updated_at: number;
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
 * 网络视频下载过程中的事件（`url-import:<requestId>`）。
 * B 站的视频流、音频流分开下，progress 每一路各走一遍 0→100%。
 */
export type UrlImportEvent =
  | {
      type: "progress";
      downloaded: number;
      total: number | null;
      /** 字节/秒 */
      speed: number | null;
      /** 剩余秒数 */
      eta: number | null;
    }
  | { type: "merging" }
  /** 视频流中途断开，正在降到这一档清晰度重下。 */
  | { type: "retrying"; maxHeight: number }
  /** 视频下完了，正在单独下字幕。 */
  | { type: "subtitles" }
  /** 字幕被限流（HTTP 429），等这么多秒再试。 */
  | { type: "subtitlesWaiting"; seconds: number }
  /** 没拿到字幕（没有这一语言的轨、一直被限流或别的原因没下成）：导入后改用语音识别。 */
  | { type: "subtitlesSkipped"; rateLimited: boolean; failed: boolean };

/** 下载任务里字幕那一步的状态（视频下完后单独下，拿不到不算失败）。 */
export type DownloadSubtitleState = "fetching" | "waiting" | "skipped" | "rateLimited" | "failed";

/** 后台下载队列里的一个任务（`download:update` 事件与 `cmd_list_downloads` 共用）。 */
export type DownloadStatus =
  | "queued"
  | "downloading"
  | "merging"
  /** 已下完，正在挪进课程目录、写库；这一段不能取消。 */
  | "importing"
  | "done"
  | "failed"
  | "canceled";

export interface DownloadJob {
  id: string;
  batchId: string;
  courseId: string;
  url: string;
  title: string;
  status: DownloadStatus;
  downloaded: number;
  total: number | null;
  /** 字节/秒 */
  speed: number | null;
  /** 剩余秒数 */
  eta: number | null;
  /** 视频流中途断开、正在降到这一档清晰度重下；正常进度时为 null。 */
  retryHeight: number | null;
  /** 字幕这一步；没请求字幕或还没到这一步时为 null。 */
  subtitle: DownloadSubtitleState | null;
  /** subtitle 为 waiting 时还要等几秒。 */
  subtitleWait: number | null;
  error: string | null;
  videoId: string | null;
  /** 第几次尝试；断流降档重下时 +1，进度条据此归零重来。 */
  attempt: number;
}

/** 入队一个下载。 */
export interface DownloadRequest {
  url: string;
  title?: string;
  maxHeight?: number;
  subLang?: string;
  /** 字幕 AI 纠错偏好；undefined = 跟随全局设置 */
  subtitleAutocorrect?: boolean;
  /** 这一集下完后自动跑流水线（批量导入为 true） */
  autoProcess?: boolean;
}

/** 一批下载全部结束（`download:batch-done`）。 */
export type DownloadBatchDoneEvent = { courseId: string };

/** 网络视频下载过程中的事件（`download:update`）。 */
export type DownloadJobEvent = DownloadJob;

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

/** 复习资料正文里一条出处编号指向的视频与时间。 */
export interface ReviewSource {
  video_id: string;
  video_title: string;
  start_ms: number | null;
}

/** 复习资料的一章。content_md 为 null：还没写成（看 error）。 */
export interface ReviewChapter {
  idx: number;
  title: string;
  intro: string;
  content_md: string | null;
  sources: Record<string, ReviewSource>;
  error: string | null;
  /** 写这版正文之后，这章用到的笔记有了变化。 */
  stale: boolean;
  generated_at: number | null;
}

/** 课程复习资料。还没生成过时 chapters 为空。 */
export interface ReviewBook {
  title: string | null;
  generated_at: number | null;
  chapters: ReviewChapter[];
  /** 笔记小节有增减（加了视频等）：要重排目录才能把新内容放进来。 */
  outline_stale: boolean;
  videos_with_notes: number;
  videos_without_notes: string[];
}

export type ReviewProgress = { stage: "outline" } | { stage: "chapters"; done: number; total: number };

export interface ReviewOutcome {
  written: number;
  failed: number;
  canceled: boolean;
}

export type ReviewEvent =
  | { type: "progress"; progress: ReviewProgress }
  | { type: "done"; outcome: ReviewOutcome }
  | { type: "error"; message: string };

/** 一句字幕的译文（按分句序号对齐讲稿）。 */
export interface TranslationRow {
  segment_idx: number;
  text: string;
}

/** 字幕翻译进度：已翻 / 待翻句数。 */
export interface TranslateProgress {
  done: number;
  total: number;
}

/** 订阅：跟踪一个合集 / 播放列表 / UP 主投稿页，有新视频时自动导入到课程。 */
export interface Subscription {
  id: string;
  course_id: string;
  url: string;
  title: string;
  auto_process: boolean;
  last_checked_at: number | null;
  last_error: string | null;
  created_at: number;
}

/** 笔记的一个历史版本（cmd_list_note_versions）。 */
export interface SavedNoteImage {
  id: string;
  /** 笔记里引用这张图用的 src（`note-image:<id>`）。 */
  src: string;
}

export interface NoteVersion {
  /** `h:<id>` 本机留底；`b:<文件名>` 每日启动快照。 */
  id: string;
  source: "history" | "backup";
  /** 这份内容最后被写入的时间（毫秒）。 */
  edited_at: number | null;
  /** 留底 / 快照的时间（毫秒）。 */
  captured_at: number;
  /** 与 getNotes 同形：Tiptap JSON 字符串或 markdown。 */
  content: string;
}

/** 一次版本检查的结果（GitHub 上最新的正式版）。 */
export interface UpdateCheck {
  /** 正在运行的版本。 */
  current: string;
  /** 最新的正式版，不带开头的 v。 */
  latest: string;
  /** 最新版比正在运行的新。 */
  newer: boolean;
  /** 发布页地址：更新说明和各平台的安装包。 */
  url: string;
}

/** 课件 OCR 的 PaddleOCR 模型（只在桌面上有）。 */
export type PaddleOcrStatus = {
  available: boolean;
  installed: boolean;
  downloadSize: number;
  sizeOnDisk: number;
};

/** 一组大模型用量（按用途 / 模型 / 课程分组，或某个视频的合计）。花费是按参考价估算的 USD。 */
export type AiUsageRow = {
  key: string;
  name: string | null;
  calls: number;
  promptTokens: number;
  cachedTokens: number;
  completionTokens: number;
  costUsd: number;
  /** 查不到价格、没算进花费的调用次数。 */
  unpricedCalls: number;
};

export type AiUsageSummary = {
  sinceMs: number;
  total: AiUsageRow;
  byLabel: AiUsageRow[];
  byModel: AiUsageRow[];
  byCourse: AiUsageRow[];
  monthCostUsd: number;
  budgetUsd: number | null;
};

/** DeepSeek 账户余额（`GET /user/balance`）。金额是官方给的字符串，如 "110.00"。 */
export type DeepSeekBalance = {
  /** 查的是哪个模型配置的 Key。 */
  profileName: string;
  /** 余额够不够继续调用。 */
  isAvailable: boolean;
  balances: { currency: string; total: string; granted: string; toppedUp: string }[];
};

/** 设置 → 语义检索：一个本地嵌入模型。 */
export type SemanticLocalModel = {
  id: string;
  name: string;
  description: string;
  size: number;
  installed: boolean;
  sizeOnDisk: number;
};

/** 后台建语义索引的进度（`semantic-index:progress` 事件也是这个形状）。 */
export type SemanticIndexProgress = {
  running: boolean;
  pending: number;
  done: number;
  currentTitle: string | null;
  lastError: string | null;
};

export type SemanticBackend = "off" | "local" | "cloud";

export type SemanticStatus = {
  backend: SemanticBackend;
  localSupported: boolean;
  localModel: string | null;
  cloudProfile: string | null;
  cloudModel: string | null;
  models: SemanticLocalModel[];
  /** 设置齐全、真能算向量。 */
  active: boolean;
  indexed: number;
  total: number;
  progress: SemanticIndexProgress;
};

export type SemanticTest = { dimensions: number; millis: number };

/** 设置 → 多设备同步：网盘上看到的另一台设备。 */
export type RemoteSyncDevice = {
  deviceId: string;
  name: string | null;
  platform: string | null;
  seenAt: number;
};

export type RemoteSyncReport = {
  pushed: number;
  pulled: number;
  applied: number;
  parked: number;
  pending: number;
};

export type RemoteSyncRunState = {
  running: boolean;
  lastSuccessAt: number | null;
  lastError: string | null;
  lastReport: RemoteSyncReport | null;
};

export type RemoteSyncStatus = {
  enabled: boolean;
  url: string;
  folder: string;
  user: string;
  hasPassword: boolean;
  deviceId: string;
  deviceName: string;
  pending: number;
  devices: RemoteSyncDevice[];
  state: RemoteSyncRunState;
  uploadMedia: boolean;
  media: RemoteSyncMediaState;
};

/** 视频上传进度（`remote-sync:media` 事件也是这个形状）。 */
export type RemoteSyncMediaState = {
  uploading: { videoId: string; title: string; sent: number; total: number } | null;
  lastError: string | null;
};

/** 从网盘（WebDAV）导入：一个网盘来源。 */
export type WebDavSource = {
  id: string;
  /** `webdav`，或 `quark`（夸克网盘，用网页版 Cookie）。 */
  kind: "webdav" | "quark";
  name: string;
  url: string;
  user: string;
  hasPassword: boolean;
  /** 同步用的网盘账号（在「多设备同步」里改，这里不能改、删）。 */
  isSync: boolean;
};

/** 网盘里的一项。 */
export type WebDavEntry = {
  name: string;
  /** 相对来源根目录的路径（文件夹以 / 结尾）。 */
  path: string;
  isDir: boolean;
  size: number | null;
  isVideo: boolean;
  /** 文件的完整地址（文件夹为空）。 */
  url: string;
};

/** 在线看的视频「下载到本机」的进度（`webdav-import:download` 事件）。 */
export type WebDavDownloadEvent = {
  videoId: string;
  downloaded: number;
  total: number | null;
  done: boolean;
};

/** 局域网直连播放（只有电脑上能开）。 */
export type LanShareStatus = {
  supported: boolean;
  enabled: boolean;
  running: boolean;
  port: number | null;
  /** 这台电脑在局域网里的地址（开着时才有）。 */
  addresses: string[];
  error: string | null;
};

/** 从网盘下载视频的进度（`remote-sync:download` 事件）。 */
export type RemoteSyncDownloadEvent = {
  videoId: string;
  received: number;
  total: number;
  done: boolean;
  error: string | null;
};

/** 局域网整段下载的进度（`lan-share:download` 事件）。 */
export type LanDownloadEvent = {
  videoId: string;
  downloaded: number;
  total: number;
  done: boolean;
  error: string | null;
};

/** 进度条上的一个标记：这一讲里做成复习卡的时刻；lapses>0 表示答错过。 */
export interface CardMark {
  card_id: string;
  source_ms: number;
  lapses: number;
}

/** 一次复习：时间、评分（1..4）与复习后的稳定度（天）。 */
export interface ReviewPoint {
  ts: number;
  rating: number;
  stability: number;
}

/** 记忆曲线：R(t) = (1 + factor·t/S)^decay，t、S 以天计。 */
export interface CardHistory {
  card_id: string;
  front: string;
  created_at: number;
  reviews: ReviewPoint[];
  due_at: number | null;
  factor: number;
  decay: number;
}

/** 错题本里的一张卡：答错过、还没连对三次。 */
export interface MistakeCard {
  card_id: string;
  video_id: string | null;
  course_id: string | null;
  front: string;
  back: string;
  source_ms: number | null;
  lapses: number;
  streak: number;
}

/** 一个知识点的掌握情况（收集册）：卡数、复习过的卡数、复习过的卡现在平均还记得多少（0..1）。 */
export interface ConceptMastery {
  concept_id: string;
  cards: number;
  reviewed: number;
  retention: number | null;
}

/** 首次使用向导的花费估算：一小时课的 token 与每个候选模型的花费。 */
export interface LectureEstimate {
  tokens: {
    promptTokens: number;
    cachedTokens: number;
    completionTokens: number;
    /** true：按自己最近处理过的课算；false：粗估。 */
    fromHistory: boolean;
    videos: number;
  };
  /** 与请求的模型一一对应；查不到价格为 null。 */
  costPerHourUsd: (number | null)[];
}
