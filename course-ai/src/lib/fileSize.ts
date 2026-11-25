const MB = 1024 * 1024;

/**
 * 视频这类大文件的大小：不到 1 GB 写整数 MB（至少 1 MB），以上写一位小数的 GB。
 * 导入对话框、网盘下载、远端视频这几处同一个视频要写成一样的数。
 */
export function formatFileSize(bytes: number): string {
  return bytes >= 1024 * MB ? `${(bytes / 1024 / MB).toFixed(1)} GB` : `${Math.max(1, Math.round(bytes / MB))} MB`;
}
