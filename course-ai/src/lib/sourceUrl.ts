/** 链接是否指向 B 站（含 b23.tv 短链）。只有 B 站下载需要导入 cookies.txt。 */
export function isBilibiliUrl(value: string) {
  try {
    const host = new URL(value.trim()).hostname.toLowerCase();
    return host === "b23.tv" || host === "bilibili.com" || host.endsWith(".bilibili.com");
  } catch {
    return false;
  }
}

/**
 * 一段文字看起来是不是链接（用于判断模型是不是把 URL 当标题填进来）。
 *
 * 除了带 scheme 的，也要认 b23.tv/abc、www.bilibili.com/video/BV... 这种省略
 * https:// 的写法；否则标题位和链接位还是会显示两遍。
 * 反过来不能把「第1/2讲」「3.5/5星」这类正常标题误判成链接：域名末段必须是
 * 至少两个 ASCII 字母。
 */
export function looksLikeLink(value: string) {
  const text = value.trim();
  if (!text || /\s/.test(text)) return false;
  if (/^[a-z][a-z\d+.-]*:\/\//i.test(text)) return true;
  const slash = text.indexOf("/");
  if (slash <= 0) return false;
  const host = text.slice(0, slash);
  if (!host.includes(".")) return false;
  const tld = host.split(".").pop() ?? "";
  return /^[a-z]{2,}$/i.test(tld);
}
