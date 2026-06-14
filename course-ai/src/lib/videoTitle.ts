// 展示用标题：默认去掉常见视频扩展名（.mp4 等）。库里仍保存原始标题，仅显示层处理。
const VIDEO_EXT_RE = /\.(mp4|m4v|mkv|mov|webm|avi|flv|wmv|ts|mpg|mpeg|3gp|ogv)$/i;

function decodeTitle(title: string) {
  if (!title.includes("%")) return title;
  try {
    return decodeURIComponent(title);
  } catch {
    return title;
  }
}

function stripFileProviderSuffix(title: string) {
  const dot = title.lastIndexOf(".");
  if (dot < 0) return title;
  const stem = title.slice(0, dot);
  const extension = title.slice(dot);
  const suffixDot = stem.lastIndexOf(".");
  if (suffixDot < 0) return title;
  const suffix = stem.slice(suffixDot + 1);
  const dash = suffix.indexOf("-");
  if (dash <= 0) return title;
  const prefix = suffix.slice(0, dash);
  const uuid = suffix.slice(dash + 1);
  if (!uuid || uuid.length !== 36) return title;
  if (!/^[0-9a-f]+$/i.test(prefix)) return title;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(uuid)) {
    return title;
  }
  return `${stem.slice(0, suffixDot)}${extension}`;
}

export function displayTitle(title: string): string {
  return stripFileProviderSuffix(decodeTitle(title)).replace(VIDEO_EXT_RE, "");
}
