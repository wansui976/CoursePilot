import { useCallback, useEffect, useState, type RefObject } from "react";
import { useTranslation } from "react-i18next";
import type { Editor } from "@tiptap/react";
import { COURSE_COLORS } from "@/lib/types";

/** 至少这么多个二级标题、而且笔记比一屏长出一半，才贴标签。 */
const MIN_SECTIONS = 3;

type Section = { text: string; el: HTMLElement };

/**
 * 长笔记的侧边索引标签：每个二级标题一张彩色小纸签，竖着贴在页面右边缘，
 * 当前读到的那一节的标签多探出来一点；点一下跳到那一节。
 */
export function NoteTabs({
  editor,
  scrollRef,
}: {
  editor: Editor | null;
  scrollRef: RefObject<HTMLDivElement | null>;
}) {
  const { t } = useTranslation();
  const [sections, setSections] = useState<Section[]>([]);
  const [active, setActive] = useState(0);

  const collect = useCallback(() => {
    const root = editor && !editor.isDestroyed ? (editor.view.dom as HTMLElement) : null;
    const scroller = scrollRef.current;
    if (!root || !scroller) return;
    const headings = Array.from(root.querySelectorAll<HTMLElement>("h2"))
      .map((el) => ({ text: (el.textContent ?? "").trim(), el }))
      .filter((section) => section.text);
    const long = scroller.scrollHeight > scroller.clientHeight * 1.5;
    const next = headings.length >= MIN_SECTIONS && long ? headings : [];
    setSections((prev) =>
      prev.length === next.length && prev.every((section, i) => section.el === next[i].el && section.text === next[i].text)
        ? prev
        : next,
    );
  }, [editor, scrollRef]);

  const track = useCallback(() => {
    const scroller = scrollRef.current;
    if (!scroller || sections.length === 0) return;
    const top = scroller.getBoundingClientRect().top + 48;
    let current = 0;
    sections.forEach((section, i) => {
      if (section.el.getBoundingClientRect().top <= top) current = i;
    });
    setActive(current);
  }, [scrollRef, sections]);

  useEffect(() => {
    collect();
    if (!editor) return;
    let timer = 0;
    const later = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(collect, 250);
    };
    editor.on("update", later);
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(later);
    if (scrollRef.current) observer?.observe(scrollRef.current);
    return () => {
      window.clearTimeout(timer);
      editor.off("update", later);
      observer?.disconnect();
    };
  }, [collect, editor, scrollRef]);

  useEffect(() => {
    const scroller = scrollRef.current;
    if (!scroller) return;
    track();
    scroller.addEventListener("scroll", track, { passive: true });
    return () => scroller.removeEventListener("scroll", track);
  }, [scrollRef, track]);

  if (sections.length === 0) return null;
  // 标签多时变矮，一排总能放进可视区；每张能写几个字跟着高度走。
  const available = (scrollRef.current?.clientHeight ?? 600) - 40;
  const tabHeight = Math.max(18, Math.min(64, Math.floor(available / sections.length) - 3));
  const chars = Math.max(1, Math.min(4, Math.floor((tabHeight - 10) / 11.5)));
  return (
    <nav className="ca-note-tabs" aria-label={t("notes.tabs")}>
      <div className="ca-note-tabs-rail" style={{ "--tab-h": `${tabHeight}px` } as React.CSSProperties}>
        {sections.map((section, i) => {
          const color = COURSE_COLORS[i % COURSE_COLORS.length];
          return (
            <button
              key={`${i}-${section.text}`}
              type="button"
              className="ca-note-tab"
              aria-current={i === active ? "location" : undefined}
              title={section.text}
              style={
                {
                  "--tab-bg": `var(--tag-${color}-bg)`,
                  "--tab-ink": `var(--tag-${color}-text)`,
                } as React.CSSProperties
              }
              onClick={() => section.el.scrollIntoView({ behavior: "smooth", block: "start" })}
            >
              {/[\u3400-\u9fff]/.test(section.text) ? (
                // 中文：一个字一行直立排，不靠竖排排版（各平台的竖排字体度量不一致，会叠字）。
                <span className="stack">
                  {Array.from(section.text)
                    .filter((char) => char.trim())
                    .slice(0, chars)
                    .map((char, k) => (
                      <i key={k}>{char}</i>
                    ))}
                </span>
              ) : (
                <span className="turn">{section.text.slice(0, chars * 2)}</span>
              )}
            </button>
          );
        })}
      </div>
    </nav>
  );
}
