/** 链接是否指向 B 站（含 b23.tv 短链）。只有 B 站下载需要导入 cookies.txt。 */
export function isBilibiliUrl(value: string) {
  try {
    const host = new URL(value.trim()).hostname.toLowerCase();
    return host === "b23.tv" || host === "bilibili.com" || host.endsWith(".bilibili.com");
  } catch {
    return false;
  }
}
