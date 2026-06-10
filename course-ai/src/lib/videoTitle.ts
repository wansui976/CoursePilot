// 展示用标题：默认去掉常见视频扩展名（.mp4 等）。库里仍保存原始标题，仅显示层处理。
const VIDEO_EXT_RE = /\.(mp4|m4v|mkv|mov|webm|avi|flv|wmv|ts|mpg|mpeg|3gp|ogv)$/i;

export function displayTitle(title: string): string {
  return title.replace(VIDEO_EXT_RE, "");
}
