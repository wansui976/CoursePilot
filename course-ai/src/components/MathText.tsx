import { Fragment, type ReactNode } from "react";
import katex from "katex";
import "katex/dist/katex.min.css";
import { MATH_RE } from "@/lib/markdownToTiptap";

function renderMath(latex: string, display: boolean): string {
  try {
    return katex.renderToString(latex, {
      displayMode: display,
      throwOnError: false,
      output: "html",
    });
  } catch {
    return "";
  }
}

/**
 * 把一段纯文本里的 LaTeX 公式（\(..\)、\[..\]、$$..$$、$..$）用 KaTeX 渲染，
 * 其余按普通文本显示。供文稿面板等纯文本场景复用。
 */
export function MathText({ text }: { text: string }) {
  const nodes: ReactNode[] = [];
  const re = new RegExp(MATH_RE.source, "g");
  let last = 0;
  let match: RegExpExecArray | null;
  let i = 0;
  while ((match = re.exec(text)) !== null) {
    if (match.index > last) {
      nodes.push(<Fragment key={`t-${i}`}>{text.slice(last, match.index)}</Fragment>);
    }
    const display = match[1] !== undefined || match[3] !== undefined;
    const latex = (match[1] ?? match[2] ?? match[3] ?? match[4] ?? "").trim();
    const html = renderMath(latex, display);
    if (html) {
      nodes.push(
        <span
          key={`m-${i}`}
          // KaTeX 输出的是受控的 HTML 片段。
          dangerouslySetInnerHTML={{ __html: html }}
        />,
      );
    } else {
      // 渲染失败时退回显示原始公式文本。
      nodes.push(<Fragment key={`m-${i}`}>{match[0]}</Fragment>);
    }
    last = match.index + match[0].length;
    i += 1;
  }
  if (last < text.length) {
    nodes.push(<Fragment key={`t-${i}`}>{text.slice(last)}</Fragment>);
  }
  return <>{nodes}</>;
}
