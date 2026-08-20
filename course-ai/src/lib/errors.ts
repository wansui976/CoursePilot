import i18n from "@/i18n";

/**
 * 把后端/工具链抛出的原始报错（Rust AppError 文案、yt-dlp/ffmpeg 输出、HTTP 状态等）
 * 映射成当前语言可读、带下一步建议的提示。识别不了的原文原样返回，避免吞掉有用信息。
 *
 * 仅用于「展示」；需要按错误类型分支处理的逻辑（如 B站 412 引导重导 cookie）请
 * 直接匹配原始报错，不要依赖这里的输出文案。
 */
/**
 * 报错文本里有没有出现某个 HTTP 状态码。
 *
 * 必须按整词匹配，不能用 includes。报错里常带着 id——`not found: video a4028f3c-…`
 * 这样的 uuid 是十六进制，含着 402 / 401 / 412 的概率各在千分之七上下，
 * 一旦撞上，「找不到视频」就会被翻译成「账户余额不足」，比不翻译糟得多。
 */
function hasStatus(text: string, code: number): boolean {
  return new RegExp(`(?<![0-9a-z])${code}(?![0-9a-z])`).test(text);
}

function languageOf(language?: string) {
  const candidate = language ?? i18n.language;
  return candidate?.toLowerCase().startsWith("en") ? "en" : "zh-CN";
}

function translated(key: string, language: string): string {
  return i18n.t(`errors.${key}`, { lng: language });
}

export function humanizeError(error: unknown, language?: string): string {
  const locale = languageOf(language);
  const raw =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : error == null
          ? ""
          : String(error);
  if (!raw.trim()) return translated("unknown", locale);
  const s = raw.toLowerCase();

  // B站登录态失效 / 触发风控（HTTP 412）——放在通用 403/forbidden 之前判断。
  if (
    (s.includes("bilibili") || s.includes("b站") || s.includes("cookie")) &&
    (hasStatus(s, 412) ||
      s.includes("precondition") ||
      s.includes("login") ||
      s.includes("需要登录") ||
      s.includes("风控"))
  ) {
    return translated("bilibiliLogin", locale);
  }
  if (hasStatus(s, 412) || s.includes("precondition")) {
    return translated("precondition", locale);
  }

  // 余额耗尽（402）和「密钥无效」是两回事：密钥是对的，就是没钱了，让人去检查
  // 设置只会白跑一趟。必须排在下面那条之前——后端给的提示里就带着「API Key」四个字。
  if (
    hasStatus(s, 402) ||
    s.includes("payment required") ||
    s.includes("insufficient balance") ||
    s.includes("insufficient_quota") ||
    s.includes("exceeded your current quota") ||
    s.includes("余额")
  ) {
    return translated("quota", locale);
  }
  if (
    s.includes("api key") ||
    s.includes("apikey") ||
    s.includes("unauthorized") ||
    hasStatus(s, 401) ||
    s.includes("no profile") ||
    s.includes("未配置")
  ) {
    return translated("apiKey", locale);
  }
  if (s.includes("大模型请求超时")) {
    return translated("longTimeout", locale);
  }
  if (s.includes("timeout") || s.includes("timed out") || s.includes("超时")) {
    return translated("timeout", locale);
  }
  if (
    s.includes("network") ||
    s.includes("connect") ||
    s.includes("fetch") ||
    s.includes("dns")
  ) {
    return translated("network", locale);
  }
  if (s.includes("rate") && s.includes("limit")) {
    return translated("rateLimit", locale);
  }
  if (s.includes("no space") || s.includes("磁盘") || s.includes("disk full")) {
    return translated("disk", locale);
  }
  if (s.includes("permission denied") || s.includes("权限") || s.includes("eacces")) {
    return translated("permission", locale);
  }
  if (s.includes("ffmpeg")) {
    return translated("ffmpeg", locale);
  }
  // yt-dlp / 下载类失败（放在具体分支之后兜底）。
  if (s.includes("yt-dlp") || s.includes("download") || s.includes("下载")) {
    return translated("download", locale);
  }
  return raw;
}
