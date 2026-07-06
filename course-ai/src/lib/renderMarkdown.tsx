import { Fragment, type ReactNode } from "react";
import { MathText } from "@/components/MathText";
import { withClickableTimestamps } from "@/lib/clickableTimestamps";

type Seek = (ms: number) => void;

/** 非公式片段里识别 **加粗** 与 [mm:ss] 时间戳。 */
function boldAndTimestamps(text: string, onSeek: Seek, key: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  // 只匹配成对且不跨行的 **..**；流式中未闭合的 ** 原样显示，闭合后再变粗。
  text.split(/(\*\*[^*\n]+\*\*)/g).forEach((part, i) => {
    if (!part) return;
    if (part.length > 4 && part.startsWith("**") && part.endsWith("**")) {
      nodes.push(
        <strong
          key={`${key}-b-${i}`}
          className="font-semibold text-[var(--text-strong)]"
        >
          {part.slice(2, -2)}
        </strong>,
      );
    } else {
      nodes.push(
        <Fragment key={`${key}-t-${i}`}>
          {withClickableTimestamps(part, onSeek, `${key}-${i}`)}
        </Fragment>,
      );
    }
  });
  return nodes;
}

/** 行内富文本：KaTeX 公式在最外层，非公式片段里再处理 **加粗** 与 [mm:ss]。 */
function inlineRich(text: string, onSeek: Seek, key: string): ReactNode {
  return (
    <MathText
      text={text}
      renderText={(seg, k) => boldAndTimestamps(seg, onSeek, `${key}-${k}`)}
    />
  );
}

type Block =
  | { kind: "p"; text: string }
  | { kind: "h"; text: string }
  | { kind: "ul"; items: string[] }
  | { kind: "ol"; items: string[] };

function parseBlocks(md: string): Block[] {
  const blocks: Block[] = [];
  let para: string[] = [];
  const flushPara = () => {
    if (para.length) {
      blocks.push({ kind: "p", text: para.join("\n") });
      para = [];
    }
  };

  for (const raw of md.split("\n")) {
    const line = raw.replace(/\s+$/, "");
    const t = line.trim();
    if (t === "") {
      flushPara();
      continue;
    }
    const heading = t.match(/^#{1,6}\s+(.*)$/);
    const bullet = t.match(/^[-*]\s+(.*)$/);
    const ordered = t.match(/^\d+\.\s+(.*)$/);
    if (heading) {
      flushPara();
      blocks.push({ kind: "h", text: heading[1] });
    } else if (bullet) {
      flushPara();
      const last = blocks[blocks.length - 1];
      if (last && last.kind === "ul") last.items.push(bullet[1]);
      else blocks.push({ kind: "ul", items: [bullet[1]] });
    } else if (ordered) {
      flushPara();
      const last = blocks[blocks.length - 1];
      if (last && last.kind === "ol") last.items.push(ordered[1]);
      else blocks.push({ kind: "ol", items: [ordered[1]] });
    } else {
      para.push(line);
    }
  }
  flushPara();
  return blocks;
}

/**
 * 极简 Markdown 渲染：`#` 标题、`-`/`*` 与 `1.` 列表、空行分段、`**加粗**`、
 * KaTeX 公式、`[mm:ss]` 跳转。够问答/摘要用，避免再引 markdown 依赖。
 * `trailing`：可选，追加到最后一个块的末尾（如流式生成光标）。
 */
export function renderMarkdown(
  md: string,
  onSeek: Seek,
  trailing?: ReactNode,
): ReactNode {
  const blocks = parseBlocks(md);
  const lastIdx = blocks.length - 1;

  return blocks.map((block, bi) => {
    const key = `b-${bi}`;
    const tail = trailing && bi === lastIdx ? trailing : null;
    if (block.kind === "h") {
      return (
        <p
          key={key}
          className="mt-3 mb-1 text-sm font-semibold text-[var(--text-strong)]"
        >
          {inlineRich(block.text, onSeek, key)}
          {tail}
        </p>
      );
    }
    if (block.kind === "ul" || block.kind === "ol") {
      const ListTag = block.kind === "ul" ? "ul" : "ol";
      const listClass =
        block.kind === "ul"
          ? "my-1.5 list-disc space-y-1 pl-5"
          : "my-1.5 list-decimal space-y-1 pl-5";
      const lastItem = block.items.length - 1;
      return (
        <ListTag key={key} className={listClass}>
          {block.items.map((it, i) => (
            <li
              key={i}
              className="text-sm leading-relaxed text-[var(--text-normal)]"
            >
              {inlineRich(it, onSeek, `${key}-${i}`)}
              {tail && i === lastItem ? tail : null}
            </li>
          ))}
        </ListTag>
      );
    }
    return (
      <p
        key={key}
        className="my-1.5 whitespace-pre-wrap text-sm leading-relaxed text-[var(--text-normal)]"
      >
        {inlineRich(block.text, onSeek, key)}
        {tail}
      </p>
    );
  });
}
