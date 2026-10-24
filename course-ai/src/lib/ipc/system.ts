/** 应用级能力：窗口/退出、云同步、密钥、开发日志、系统通知、设置、语音模型、备份与外部工具。 */
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type {
  DevLogEntry,
  LlmUsageTotals,
  PlaylistInfo,
  ProbeResult,
  Video,
} from "../types";
import type {
  UpdateCheck,
  WhisperModel,
  CloudSyncProbeAccountChangeResult,
  CloudSyncStatus,
  CloudSyncProbeArmResult,
  CloudSyncProbeStatus,
  CloudSyncProbeStopResult,
  UrlImportEvent,
} from "./types";

export const app = {
  exit: (): Promise<void> => invoke("cmd_exit_app"),
  // Android 的 AppPlugin 接管了系统返回键；根页面没有可退层级时退到后台（不结束进程）。
  moveToBackground: (): Promise<void> => invoke("plugin:mobile-files|move_task_to_back"),
  // 问一次 GitHub 上的最新版本（只取版本号和发布页地址）。
  checkUpdate: (): Promise<UpdateCheck> => invoke("cmd_check_update"),
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
  // 扁平枚举播放列表/合集（不下载正片），得到各集清单。
  probePlaylist: (url: string): Promise<PlaylistInfo> =>
    invoke("cmd_probe_playlist", { url }),
  setBilibiliCookies: (filePath: string): Promise<void> =>
    invoke("cmd_set_bilibili_cookies", { filePath }),
  hasBilibiliCookies: (): Promise<boolean> =>
    invoke("cmd_has_bilibili_cookies"),
};
