import { openUrl } from "@tauri-apps/plugin-opener";
import { Fragment, type ReactNode } from "react";

/**
 * 文案里的两种小标记：<code>…</code> 渲染成等宽小块，<link>…</link> 渲染成用系统浏览器
 * 打开 url 的链接。只认这两种，其余原样输出。
 */
export function richText(text: string, url?: string): ReactNode {
  const parts: ReactNode[] = [];
  const pattern = /<(code|link)>(.*?)<\/\1>/g;
  let last = 0;
  for (const match of text.matchAll(pattern)) {
    const index = match.index ?? 0;
    if (index > last) parts.push(text.slice(last, index));
    const [, tag, inner] = match;
    parts.push(
      tag === "code" ? (
        <code key={index}>{inner}</code>
      ) : url ? (
        <button key={index} type="button" className="ca-tour-link" onClick={() => void openUrl(url)}>
          {inner}
        </button>
      ) : (
        <Fragment key={index}>{inner}</Fragment>
      ),
    );
    last = index + match[0].length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts;
}
