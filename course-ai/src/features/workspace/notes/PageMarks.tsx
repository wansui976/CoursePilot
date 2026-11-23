import { useCallback, useEffect, useState, type RefObject } from "react";
import { useTranslation } from "react-i18next";
import type { Editor } from "@tiptap/react";
import { estimatePrintPages } from "@/lib/printPages";

/**
 * 笔记页上的分页记号：按导出讲义（A4）的排版估一下，第 2、3…页会从哪儿开始，
 * 在那里画一道很淡的虚线、右边标页码；页底写共几页。只是估计，导出前心里有数。
 */
export function PageMarks({ editor, sheetRef }: { editor: Editor | null; sheetRef: RefObject<HTMLDivElement | null> }) {
  const { t } = useTranslation();
  const [marks, setMarks] = useState<{ pages: number; tops: number[] }>({ pages: 0, tops: [] });

  const measure = useCallback(() => {
    const sheet = sheetRef.current;
    const root = editor && !editor.isDestroyed ? (editor.view.dom as HTMLElement) : null;
    if (!sheet || !root || editor?.isEmpty) {
      setMarks((prev) => (prev.pages === 0 ? prev : { pages: 0, tops: [] }));
      return;
    }
    const style = getComputedStyle(root);
    const padTop = parseFloat(style.paddingTop) || 0;
    const padBottom = parseFloat(style.paddingBottom) || 0;
    const estimate = estimatePrintPages({
      contentHeight: root.scrollHeight - padTop - padBottom,
      textWidth: root.clientWidth - (parseFloat(style.paddingLeft) || 0) - (parseFloat(style.paddingRight) || 0),
      fontPx: parseFloat(style.fontSize) || 14,
    });
    const offset = root.getBoundingClientRect().top - sheet.getBoundingClientRect().top + padTop;
    const tops = estimate.breaks.map((y) => Math.round(offset + y));
    setMarks((prev) =>
      prev.pages === estimate.pages && prev.tops.length === tops.length && prev.tops.every((v, i) => v === tops[i])
        ? prev
        : { pages: estimate.pages, tops },
    );
  }, [editor, sheetRef]);

  useEffect(() => {
    measure();
    if (!editor) return;
    let timer = 0;
    const later = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(measure, 200);
    };
    editor.on("update", later);
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(later);
    if (sheetRef.current) observer?.observe(sheetRef.current);
    return () => {
      window.clearTimeout(timer);
      editor.off("update", later);
      observer?.disconnect();
    };
  }, [editor, measure, sheetRef]);

  if (marks.pages === 0) return null;
  return (
    <>
      {marks.tops.map((top, i) => (
        <div key={i} className="ca-page-break" style={{ top }} aria-hidden="true">
          <span>{t("notes.pageMark", { page: i + 2 })}</span>
        </div>
      ))}
      <p className="ca-page-count">{t("notes.pageCount", { count: marks.pages })}</p>
    </>
  );
}
