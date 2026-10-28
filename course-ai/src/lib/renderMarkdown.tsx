import { Fragment, type ReactNode } from "react";
import { CodeBlock } from "@/ui/CodeBlock";
import { MathText } from "@/ui/MathText";
import i18n from "@/i18n";
import { withClickableTimestamps } from "@/lib/clickableTimestamps";
import {
  splitTrailingTimestampSources,
  type TimestampSource,
} from "@/lib/markdownToTiptap";

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
          {/* 加粗里也认时间戳：「**出现在 [11:04]**」这种强调句恰恰最常带时间点。 */}
          {withClickableTimestamps(part.slice(2, -2), onSeek, `${key}-b${i}`)}
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

/**
 * 行内富文本：`行内代码` 最先切出来原样显示（代码里的 $、**、12:34 都不是公式、加粗或时间戳），
 * 其余片段 KaTeX 公式在最外层，非公式片段里再处理 **加粗** 与 [mm:ss]。
 */
function inlineRich(text: string, onSeek: Seek, key: string): ReactNode {
  if (!text.includes("`")) return mathAndRest(text, onSeek, key);
  return text.split(/(`[^`\n]+`)/g).map((part, i) =>
    part.length > 2 && part.startsWith("`") && part.endsWith("`") ? (
      <code
        key={`${key}-c-${i}`}
        className="rounded bg-[var(--surface-card-hover)] px-1 py-px font-[family-name:var(--mono)] text-[0.9em] text-[var(--text-strong)]"
      >
        {part.slice(1, -1)}
      </code>
    ) : part ? (
      <Fragment key={`${key}-m-${i}`}>{mathAndRest(part, onSeek, `${key}-${i}`)}</Fragment>
    ) : null,
  );
}

function mathAndRest(text: string, onSeek: Seek, key: string): ReactNode {
  return (
    <MathText
      text={text}
      renderText={(seg, k) => boldAndTimestamps(seg, onSeek, `${key}-${k}`)}
    />
  );
}


function timestampSources(sources: TimestampSource[], onSeek: Seek) {
  const label = i18n.t("markdown.sources");
  return (
    <span
      role="group"
      aria-label={label}
      className="ca-ts-source-row mt-1 flex flex-wrap items-center gap-1 ca-t-2xs text-[var(--text-faint)]"
    >
      <span className="mr-0.5">{label}</span>
      {sources.map((source, index) => (
        <button
          key={`${source.ms}-${index}`}
          type="button"
          aria-label={i18n.t("markdown.jumpTo", { time: source.label })}
          onClick={() => onSeek(source.ms)}
          className="ca-ts-chip rounded px-1.5 py-0.5 tabular-nums text-[var(--text-muted)] transition-colors hover:bg-[var(--surface-card-hover)] hover:text-[var(--text-strong)]"
        >
          {source.label}
        </button>
      ))}
    </span>
  );
}

function blockRich(
  text: string,
  onSeek: Seek,
  key: string,
  trailing?: ReactNode,
) {
  const { body, sources } = splitTrailingTimestampSources(text);
  if (sources.length === 0) {
    return (
      <>
        {inlineRich(text, onSeek, key)}
        {trailing}
      </>
    );
  }
  return (
    <>
      {body ? inlineRich(body, onSeek, key) : null}
      {timestampSources(sources, onSeek)}
      {trailing}
    </>
  );
}

type Block =
  | { kind: "p"; text: string }
  | { kind: "h"; level: 1 | 2 | 3 | 4 | 5 | 6; text: string }
  | { kind: "ul"; items: string[] }
  | { kind: "ol"; items: string[] }
  | { kind: "quote"; text: string }
  | { kind: "code"; lang: string; text: string };

type HeadingElement = "h1" | "h2" | "h3" | "h4" | "h5" | "h6";

function parseBlocks(md: string): Block[] {
  const blocks: Block[] = [];
  let para: string[] = [];
  const flushPara = () => {
    if (para.length) {
      blocks.push({ kind: "p", text: para.join("\n") });
      para = [];
    }
  };

  // 围栏代码块里的行原样收下，不认标题、列表、空行分段。流式输出时闭合的 ``` 还没到，
  // 就先把已到的部分当代码显示，等闭合了也不会跳变。
  let code: { lang: string; lines: string[] } | null = null;
  for (const raw of md.split("\n")) {
    const fence = raw.trim().match(/^```\s*([\w+#.-]*)\s*$/);
    if (code) {
      if (fence && !fence[1]) {
        blocks.push({ kind: "code", lang: code.lang, text: code.lines.join("\n") });
        code = null;
      } else {
        code.lines.push(raw);
      }
      continue;
    }
    if (fence) {
      flushPara();
      code = { lang: fence[1], lines: [] };
      continue;
    }
    const line = raw.replace(/\s+$/, "");
    const t = line.trim();
    if (t === "") {
      flushPara();
      continue;
    }
    const heading = t.match(/^(#{1,6})\s+(.*)$/);
    const quote = t.match(/^>\s?(.*)$/);
    const bullet = t.match(/^[-*]\s+(.*)$/);
    const ordered = t.match(/^\d+\.\s+(.*)$/);
    if (heading) {
      flushPara();
      blocks.push({
        kind: "h",
        level: heading[1].length as 1 | 2 | 3 | 4 | 5 | 6,
        text: heading[2],
      });
    } else if (quote) {
      // 连续的 `>` 行合成一个引用块（AI 摘要常用它写「直觉 / 提示」）。
      flushPara();
      const last = blocks[blocks.length - 1];
      if (last && last.kind === "quote") last.text += `\n${quote[1]}`;
      else blocks.push({ kind: "quote", text: quote[1] });
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
  if (code) blocks.push({ kind: "code", lang: code.lang, text: code.lines.join("\n") });
  return blocks;
}

/** 只渲染行内格式（加粗、KaTeX、时间戳），不切段落/列表：给居中的单段文字用，
 *  如复习卡的正反面。 */
export function renderInlineMarkdown(text: string, onSeek: Seek = () => {}): ReactNode {
  return inlineRich(text, onSeek, "inline");
}

/**
 * 极简 Markdown 渲染：`#` 标题、`-`/`*` 与 `1.` 列表、空行分段、`**加粗**`、
 * KaTeX 公式、`[mm:ss]` 跳转、``` 代码块与 `行内代码`。够问答/摘要用，避免再引 markdown 依赖。
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
      const HeadingTag = `h${block.level}` as HeadingElement;
      return (
        <HeadingTag
          key={key}
          className="mt-3 mb-1 text-[length:var(--md-size,0.875rem)] font-semibold text-[var(--text-strong)]"
        >
          {blockRich(block.text, onSeek, key, tail)}
        </HeadingTag>
      );
    }
    if (block.kind === "code") {
      return (
        <Fragment key={key}>
          <CodeBlock code={block.text} lang={block.lang} />
          {tail}
        </Fragment>
      );
    }
    if (block.kind === "quote") {
      return (
        <blockquote
          key={key}
          className="my-3 whitespace-pre-wrap border-l-2 border-[var(--border-strong)] py-0.5 pl-3 text-[length:var(--md-size,0.875rem)] leading-relaxed text-[var(--text-muted)]"
        >
          {blockRich(block.text, onSeek, key, tail)}
        </blockquote>
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
              className="text-[length:var(--md-size,0.875rem)] leading-relaxed text-[var(--text-normal)]"
            >
              {blockRich(
                it,
                onSeek,
                `${key}-${i}`,
                tail && i === lastItem ? tail : undefined,
              )}
            </li>
          ))}
        </ListTag>
      );
    }
    return (
      <p
        key={key}
        className="my-1.5 whitespace-pre-wrap text-[length:var(--md-size,0.875rem)] leading-relaxed text-[var(--text-normal)]"
      >
        {blockRich(block.text, onSeek, key, tail)}
      </p>
    );
  });
}
