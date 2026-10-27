/** 链接是否指向 B 站（含 b23.tv 短链）。只有 B 站下载需要导入 cookies.txt。 */
export function isBilibiliUrl(value: string) {
  try {
    const host = new URL(value.trim()).hostname.toLowerCase();
    return host === "b23.tv" || host === "bilibili.com" || host.endsWith(".bilibili.com");
  } catch {
    return false;
  }
}

/** 一看就是视频链接的域名（短链、移动版）：标题以它们开头，必是把链接当标题填了。 */
const VIDEO_LINK_HOSTS = ["b23.tv", "bilibili.com", "youtu.be", "youtube.com"];

function bareHost(host: string) {
  return host.trim().toLowerCase().replace(/^www\./, "");
}

function isVideoLinkHost(host: string) {
  return VIDEO_LINK_HOSTS.some((known) => host === known || host.endsWith(`.${known}`));
}

/**
 * 模型给的标题是不是把导入链接又写了一遍（这时卡片会把同一个链接显示两遍）。
 *
 * 不能只看「长得像链接」：`Node.js/React入门`、`Vue.js/TS实战` 也是「xx.yy/…」。
 * 真正要防的是重复，所以只认三种：带 scheme 的（`https://…`）；开头的域名就是这条
 * 链接的域名（`www.bilibili.com/video/…`、省略了 https://）；或者是 B 站 / YouTube
 * 的链接域名（`b23.tv/abc`、`youtu.be/x`）。
 *
 * Rust 端 pipeline/assistant.rs 的 title_repeats_url 与此一致，两边测试共用
 * titleRepeatsUrl.cases.json。
 */
export function titleRepeatsUrl(title: string, url: string) {
  const text = title.trim();
  if (!text || /\s/.test(text)) return false;
  if (/^[a-z][a-z\d+.-]*:\/\//i.test(text)) return true;
  const titleHost = bareHost(text.split("/")[0] ?? "");
  if (!titleHost.includes(".")) return false;
  let urlHost = "";
  try {
    urlHost = bareHost(new URL(url.trim()).hostname);
  } catch {
    // url 不合法就只按已知的视频域名判断
  }
  return titleHost === urlHost || isVideoLinkHost(titleHost);
}
