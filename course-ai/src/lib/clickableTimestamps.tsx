import { Fragment, type ReactNode } from "react";
import { parseTimestamp, TIMESTAMP_RE } from "@/lib/markdownToTiptap";

/**
 * 把一段纯文本里的 [mm:ss] / [hh:mm:ss] 时间戳渲染成可点击跳转的标记，
 * 其余部分原样保留。供问答回答、摘要等「LLM 文本带时间戳」的地方复用。
 */
export function withClickableTimestamps(
  text: string,
  onSeek: (ms: number) => void,
  keyPrefix = "ts",
): ReactNode[] {
  const nodes: ReactNode[] = [];
  const re = new RegExp(TIMESTAMP_RE.source, "g");
  let last = 0;
  let match: RegExpExecArray | null;
  let i = 0;
  while ((match = re.exec(text)) !== null) {
    if (match.index > last) {
      nodes.push(
        <Fragment key={`${keyPrefix}-t-${i}`}>
          {text.slice(last, match.index)}
        </Fragment>,
      );
    }
    const ms = parseTimestamp(match[1]);
    nodes.push(
      <button
        key={`${keyPrefix}-b-${i}`}
        type="button"
        onClick={() => onSeek(ms)}
        className="mx-0.5 inline-flex items-center rounded bg-primary/15 px-1 align-baseline text-xs font-medium text-primary hover:bg-primary/25"
      >
        ▶ {match[1]}
      </button>,
    );
    last = match.index + match[0].length;
    i += 1;
  }
  if (last < text.length) {
    nodes.push(
      <Fragment key={`${keyPrefix}-t-${i}`}>{text.slice(last)}</Fragment>,
    );
  }
  return nodes;
}
