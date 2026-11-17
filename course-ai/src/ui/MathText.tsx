import { Fragment, useEffect, useState, type ReactNode } from "react";
import { MATH_RE } from "@/lib/markdownToTiptap";

type Katex = typeof import("katex").default;

// KaTeX（连同它的样式和字体）是启动包里最大的一块，而绝大多数文字里根本没有公式。
// 所以第一次真遇到公式时才加载；加载那一下（本地几十毫秒）先显示公式原文。
// 应用空闲时会预先加载一次（preloadKatex），实际使用中基本看不到这一下。
let katexLib: Katex | null = null;
let katexLoading: Promise<Katex> | null = null;

export function loadKatex(): Promise<Katex> {
  katexLoading ??= Promise.all([import("katex"), import("katex/dist/katex.min.css")]).then(
    ([module]) => (katexLib = module.default),
  );
  return katexLoading;
}

/** 空闲时预加载 KaTeX，不占启动的关键路径。 */
export function preloadKatex() {
  const start = () => void loadKatex().catch(() => {});
  if (typeof window !== "undefined" && "requestIdleCallback" in window) {
    window.requestIdleCallback(start, { timeout: 5000 });
  } else {
    setTimeout(start, 3000);
  }
}

function useKatex(needed: boolean): Katex | null {
  const [lib, setLib] = useState<Katex | null>(katexLib);
  useEffect(() => {
    if (!needed || lib) return;
    let alive = true;
    void loadKatex()
      .then((loaded) => {
        if (alive) setLib(loaded);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [needed, lib]);
  return lib ?? katexLib;
}

function renderMath(katex: Katex | null, latex: string, display: boolean): string {
  if (!katex) return "";
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
 *
 * `renderText` 可选，用于把非公式片段进一步加工（如问答回答里把 [mm:ss]
 * 渲染成可点击时间戳）；不传则按纯文本显示。
 */
export function MathText({
  text,
  renderText,
}: {
  text: string;
  renderText?: (segment: string, key: string) => ReactNode;
}) {
  const nodes: ReactNode[] = [];
  const re = new RegExp(MATH_RE.source, "g");
  const katex = useKatex(new RegExp(MATH_RE.source).test(text));
  let last = 0;
  let match: RegExpExecArray | null;
  let i = 0;
  const pushText = (segment: string, key: string) => {
    nodes.push(
      renderText ? (
        <Fragment key={key}>{renderText(segment, key)}</Fragment>
      ) : (
        <Fragment key={key}>{segment}</Fragment>
      ),
    );
  };
  while ((match = re.exec(text)) !== null) {
    if (match.index > last) {
      pushText(text.slice(last, match.index), `t-${i}`);
    }
    const display = match[1] !== undefined || match[3] !== undefined;
    const latex = (match[1] ?? match[2] ?? match[3] ?? match[4] ?? "").trim();
    const html = renderMath(katex, latex, display);
    if (html) {
      nodes.push(
        <span
          key={`m-${i}`}
          // KaTeX 输出的是受控的 HTML 片段。
          dangerouslySetInnerHTML={{ __html: html }}
        />,
      );
    } else {
      // 渲染失败（或 KaTeX 还在加载）时显示原始公式文本。
      nodes.push(<Fragment key={`m-${i}`}>{match[0]}</Fragment>);
    }
    last = match.index + match[0].length;
    i += 1;
  }
  if (last < text.length) {
    pushText(text.slice(last), `t-${i}`);
  }
  return <>{nodes}</>;
}
