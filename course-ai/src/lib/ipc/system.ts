/** 应用级能力：窗口/退出、云同步、密钥、开发日志、系统通知、设置、语音模型、备份与外部工具。 */
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type {
  CleanupResult,
  DevLogEntry,
  ExplanationResult,
  LlmUsageTotals,
  PlaylistInfo,
  ProbeResult,
  StorageUsage,
  Video,
} from "../types";
import type {
  UpdateCheck,
  WhisperModel,
  ModelsDir,
  PaddleOcrStatus,
  AiUsageRow,
  AiUsageSummary,
  DeepSeekBalance,
  CloudSyncProbeAccountChangeResult,
  CloudSyncStatus,
  CloudSyncProbeArmResult,
  CloudSyncProbeStatus,
  CloudSyncProbeStopResult,
  UrlImportEvent,
  SemanticBackend,
  SemanticStatus,
  SemanticTest,
  RemoteSyncReport,
  RemoteSyncStatus,
} from "./types";

export const app = {
  exit: (): Promise<void> => invoke("cmd_exit_app"),
  // Android 的 AppPlugin 接管了系统返回键；根页面没有可退层级时退到后台（不结束进程）。
  moveToBackground: (): Promise<void> => invoke("plugin:mobile-files|move_task_to_back"),
  // 手机上现在连的是不是按流量计费的网络（手机数据、热点、低数据模式）。只在手机上调。
  networkInfo: (): Promise<{ metered: boolean }> => invoke("plugin:mobile-files|network_info"),
  // 问一次 GitHub 上的最新版本（只取版本号和发布页地址）。
  checkUpdate: (): Promise<UpdateCheck> => invoke("cmd_check_update"),
  /** 应用内自动更新：有签过名、能直接装的新版本时返回它（只有桌面；手机恒为 null）。 */
  updaterCheck: (): Promise<{ version: string; current: string } | null> => invoke("cmd_updater_check"),
  /** 下载、校验、安装并重启。进度见 `updater:progress` 事件。 */
  updaterInstall: (): Promise<void> => invoke("cmd_updater_install"),
  // 应用私有目录的占用明细（设置 → 存储）。手机上用来解释空间去哪了。
  storageUsage: (): Promise<StorageUsage> => invoke("cmd_storage_usage"),
  // 清掉升级前删除视频留下的、已经没有数据库行引用的媒体副本。
  cleanupOrphanMedia: (): Promise<CleanupResult> =>
    invoke("cmd_cleanup_orphan_media"),
};

export const sync = {
  status: (): Promise<CloudSyncStatus> => invoke("cmd_sync_status"),
  start: (): Promise<CloudSyncStatus> => invoke("cmd_sync_start"),
  setEnabled: (enabled: boolean): Promise<CloudSyncStatus> =>
    invoke("cmd_sync_set_enabled", { enabled }),
  syncNow: (): Promise<CloudSyncStatus> => invoke("cmd_sync_now"),
  probe: (sessionCode?: string): Promise<CloudSyncProbeArmResult> =>
    invoke("cmd_sync_probe", { sessionCode }),
  confirmProbeAccountChange: (): Promise<CloudSyncProbeAccountChangeResult> =>
    invoke("cmd_sync_probe_confirm_account_change"),
  probeSend: (replay = false): Promise<CloudSyncProbeStatus> =>
    invoke("cmd_sync_probe_send", { replay }),
  probeStatus: (): Promise<CloudSyncProbeStatus> =>
    invoke("cmd_sync_probe_status"),
  probeStop: (): Promise<CloudSyncProbeStopResult> =>
    invoke("cmd_sync_probe_stop"),
};

export const secrets = {
  // 保存敏感凭证（ASR/OCR 密钥）到密钥存储。
  set: (name: string, value: string): Promise<void> =>
    invoke("cmd_set_secret", { name, value }),
  // 是否已配置某项凭证（只回布尔、不回读明文），供设置页显示「已配置」。
  has: (name: string): Promise<boolean> => invoke("cmd_has_secret", { name }),
};

export const dev = {
  logs: (): Promise<DevLogEntry[]> => invoke("cmd_get_dev_logs"),
  clearLogs: (): Promise<void> => invoke("cmd_clear_dev_logs"),
  // 各档 LLM 调用的累计 token 用量（进程内统计，重启即清空）。
  llmUsage: (): Promise<LlmUsageTotals[]> => invoke("cmd_llm_usage"),
  clearLlmUsage: (): Promise<void> => invoke("cmd_clear_llm_usage"),
};

/** 落库的大模型用量与估算花费（设置 → 大模型 → 用量与花费；视频概览底下那一行）。 */
export const aiUsage = {
  summary: (days = 30): Promise<AiUsageSummary> => invoke("cmd_ai_usage_summary", { days }),
  video: (videoId: string): Promise<AiUsageRow> => invoke("cmd_video_ai_usage", { videoId }),
  /** 没配 DeepSeek 官方的模型时是 null。 */
  deepseekBalance: (): Promise<DeepSeekBalance | null> => invoke("cmd_deepseek_balance"),
};

// 发一条系统桌面通知（学习提醒）。触发时机与去重由前端决定。
export const notify = (title: string, body: string): Promise<void> =>
  invoke("cmd_notify", { title, body });

export const settings = {
  get: (key: string): Promise<string | null> =>
    invoke("cmd_get_setting", { key }),
  set: (key: string, value: string): Promise<void> =>
    invoke("cmd_set_setting", { key, value }),
};

export const whisper = {
  list: (): Promise<[WhisperModel, boolean][]> =>
    invoke("cmd_list_whisper_models"),
  download: (id: string): Promise<void> =>
    invoke("cmd_download_whisper_model", { id }),
  /** 识别模型存放在哪（可以换到别的盘，Windows 上默认在 C 盘）。 */
  modelsDir: (): Promise<ModelsDir> => invoke("cmd_get_models_dir"),
  /** 换存放目录，已下载的模型跟着搬过去（进度见 `models:move` 事件）；null = 恢复默认。 */
  setModelsDir: (path: string | null): Promise<ModelsDir> =>
    invoke("cmd_set_models_dir", { path }),
  /** 删掉一个已下载的识别模型（以后要用得重新下载）。 */
  deleteModel: (id: string): Promise<void> => invoke("cmd_delete_asr_model", { id }),
  /** 删掉不再使用的旧模型文件。 */
  deleteLegacyModels: (): Promise<ModelsDir> => invoke("cmd_delete_legacy_models"),
};

export const ocrModel = {
  status: (): Promise<PaddleOcrStatus> => invoke("cmd_paddle_ocr_status"),
  /** 下载（进度见 `ocr-model:download` 事件，字段同语音识别模型的下载事件）。 */
  download: (): Promise<void> => invoke("cmd_download_paddle_ocr"),
  /** 删掉模型；设置里正选着 PaddleOCR 时后端会改回本地 OCR。 */
  remove: (): Promise<void> => invoke("cmd_delete_paddle_ocr"),
};

export const backup = {
  create: (destinationPath: string | null): Promise<string> =>
    invoke("cmd_backup_database", { destinationPath }),
  restore: (sourcePath: string): Promise<{
    snapshotPath: string;
    requiresRestart: boolean;
    restartRequested: boolean;
  }> => invoke("cmd_restore_database", { sourcePath }),
};

export const tools = {
  ocr: (
    videoId: string,
    atMs: number,
    x = 0,
    y = 0,
    w = 0,
    h = 0,
  ): Promise<string> =>
    invoke("cmd_ocr_region", { videoId, atMs, x, y, w, h }),
  /** 对一张图（data URL）跑当前设置的 OCR 引擎：拍题找讲解先认出题目文字。 */
  ocrImage: (image: string): Promise<string> => invoke("cmd_ocr_image", { image }),
  /** 拍题找讲解：题目文字（可选附原图）在整门课里讲在哪。 */
  findExplanations: (
    courseId: string,
    text: string,
    image?: string | null,
  ): Promise<ExplanationResult> =>
    invoke("cmd_find_explanations", { courseId, text, ...(image ? { image } : {}) }),
  importBilibili: async (
    courseId: string,
    url: string,
    maxHeight?: number,
    subLang?: string,
    // 本次导入的字幕 AI 纠错偏好；undefined = 跟随全局设置。
    subtitleAutocorrect?: boolean,
    // 下载进度回调（百分比、速度、合并、断流降档重试）。
    onEvent?: (event: UrlImportEvent) => void,
  ): Promise<Video> => {
    const args = { courseId, url, maxHeight, subLang, subtitleAutocorrect };
    if (!onEvent) return invoke("cmd_import_bilibili", args);
    const requestId = crypto.randomUUID();
    // 先注册监听再 invoke，避免漏掉早到的事件。
    const unlisten = await listen<UrlImportEvent>(`url-import:${requestId}`, (evt) =>
      onEvent(evt.payload),
    );
    try {
      return await invoke<Video>("cmd_import_bilibili", { ...args, requestId });
    } finally {
      unlisten();
    }
  },
  probeBilibili: (url: string): Promise<ProbeResult> =>
    invoke("cmd_probe_bilibili", { url }),
  /** 当前 cookies 是否仍是 B站登录态；null = 查询失败/没配 cookies，不能据此下结论。 */
  bilibiliLoginState: (): Promise<boolean | null> =>
    invoke("cmd_bilibili_login_state"),
  // 扁平枚举播放列表/合集（不下载正片），得到各集清单。
  probePlaylist: (url: string): Promise<PlaylistInfo> =>
    invoke("cmd_probe_playlist", { url }),
  setBilibiliCookies: (filePath: string): Promise<void> =>
    invoke("cmd_set_bilibili_cookies", { filePath }),
  hasBilibiliCookies: (): Promise<boolean> =>
    invoke("cmd_has_bilibili_cookies"),
};

/** 界面层长期数据（库里的 client_store 表）：按键存前端序列化好的文本。 */
export const clientStore = {
  load: (prefixes: string[]): Promise<[string, string][]> =>
    invoke("cmd_client_store_load", { prefixes }),
  /** 值为 null 表示删除该键；整批一个事务。 */
  put: (entries: [string, string | null][]): Promise<void> =>
    invoke("cmd_client_store_put", { entries }),
};

/** 设置 → 语义检索（按意思找）。 */
export const semantic = {
  status: (): Promise<SemanticStatus> => invoke("cmd_semantic_status"),
  save: (config: {
    backend: SemanticBackend;
    localModel: string | null;
    cloudProfile: string | null;
    cloudModel: string | null;
  }): Promise<void> => invoke("cmd_semantic_save", config),
  /** 下载本地嵌入模型（进度见 `semantic-model:download` 事件）。 */
  downloadModel: (id: string): Promise<void> => invoke("cmd_semantic_download_model", { id }),
  deleteModel: (id: string): Promise<void> => invoke("cmd_semantic_delete_model", { id }),
  /** 用当前设置算一句话，确认接口通、模型名对。 */
  test: (): Promise<SemanticTest> => invoke("cmd_semantic_test"),
  rebuild: (): Promise<void> => invoke("cmd_semantic_rebuild"),
  /** 上一轮出错停下后，接着把没建的建完。 */
  resume: (): Promise<void> => invoke("cmd_semantic_resume"),
};

/** 设置 → 多设备同步（网盘 / WebDAV）。密码传 null 表示沿用已保存的。 */
type RemoteSyncDraft = { url: string; folder: string; user: string; password: string | null };
export const remoteSync = {
  status: (): Promise<RemoteSyncStatus> => invoke("cmd_remote_sync_status"),
  /** 返回网盘上已有几台设备。 */
  test: (draft: RemoteSyncDraft): Promise<number> => invoke("cmd_remote_sync_test", draft),
  save: (draft: RemoteSyncDraft): Promise<void> => invoke("cmd_remote_sync_save", draft),
  setEnabled: (enabled: boolean): Promise<void> => invoke("cmd_remote_sync_set_enabled", { enabled }),
  now: (): Promise<RemoteSyncReport> => invoke("cmd_remote_sync_now"),
  nudge: (): Promise<void> => invoke("cmd_remote_sync_nudge"),
  setUploadMedia: (enabled: boolean): Promise<void> => invoke("cmd_remote_sync_set_upload_media", { enabled }),
  /** 网盘上这个视频的文件大小；还没传上去返回 null。 */
  mediaSize: (videoId: string): Promise<number | null> => invoke("cmd_remote_sync_media_size", { videoId }),
  /** 下载到本机，返回文件路径（进度见 `remote-sync:download` 事件）。 */
  downloadVideo: (videoId: string): Promise<string> => invoke("cmd_remote_sync_download_video", { videoId }),
};
