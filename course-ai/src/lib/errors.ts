/**
 * 把后端/工具链抛出的原始报错（Rust AppError 文案、yt-dlp/ffmpeg 输出、HTTP 状态等）
 * 映射成中文可读、带下一步建议的提示。识别不了的原文原样返回，避免吞掉有用信息。
 *
 * 仅用于「展示」；需要按错误类型分支处理的逻辑（如 B站 412 引导重导 cookie）请
 * 直接匹配原始报错，不要依赖这里的输出文案。
 */
export function humanizeError(error: unknown): string {
  const raw =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : error == null
          ? ""
          : String(error);
  if (!raw.trim()) return "发生未知错误。";
  const s = raw.toLowerCase();

  // B站登录态失效 / 触发风控（HTTP 412）——放在通用 403/forbidden 之前判断。
  if (
    (s.includes("bilibili") || s.includes("b站") || s.includes("cookie")) &&
    (s.includes("412") ||
      s.includes("precondition") ||
      s.includes("login") ||
      s.includes("需要登录") ||
      s.includes("风控"))
  ) {
    return "B站登录态已失效或触发风控（HTTP 412）：请用 Get cookies.txt LOCALLY 扩展重新导出并导入 cookies.txt。";
  }
  if (s.includes("412") || s.includes("precondition")) {
    return "服务器拒绝了请求（HTTP 412）：登录态可能已失效，请重新导入 cookies.txt 后重试。";
  }

  if (
    s.includes("api key") ||
    s.includes("apikey") ||
    s.includes("unauthorized") ||
    s.includes("401") ||
    s.includes("no profile") ||
    s.includes("未配置")
  ) {
    return "未配置或密钥无效：请到「设置」检查大模型 / 语音的 API Key。";
  }
  if (s.includes("timeout") || s.includes("timed out") || s.includes("超时")) {
    return "请求超时，请检查网络后重试。";
  }
  if (
    s.includes("network") ||
    s.includes("connect") ||
    s.includes("fetch") ||
    s.includes("dns")
  ) {
    return "网络连接失败，请检查网络后重试。";
  }
  if (s.includes("rate") && s.includes("limit")) {
    return "请求过于频繁（限流），请稍后重试。";
  }
  if (s.includes("no space") || s.includes("磁盘") || s.includes("disk full")) {
    return "磁盘空间不足，请清理后重试。";
  }
  if (s.includes("permission denied") || s.includes("权限") || s.includes("eacces")) {
    return "没有文件访问权限，请检查目录权限后重试。";
  }
  if (s.includes("ffmpeg")) {
    return "缺少 ffmpeg 或音频处理失败。";
  }
  // yt-dlp / 下载类失败（放在具体分支之后兜底）。
  if (s.includes("yt-dlp") || s.includes("download") || s.includes("下载")) {
    return "视频下载失败：请检查链接是否有效，或稍后重试。";
  }
  return raw;
}
