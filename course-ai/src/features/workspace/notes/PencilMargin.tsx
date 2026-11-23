import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import type { Editor } from "@tiptap/react";
import { Eraser } from "lucide-react";
import { ipc } from "@/lib/ipc";
import type { NoteAnnotation } from "@/lib/ipc/media";
import { qk } from "@/lib/queryKeys";
import { findQuoteRange, GAP, stackTops } from "@/lib/pencilLayout";

const HIGHLIGHT = "ca-pencil";
/** 没有批注时用同一个空数组：每次渲染新建一个会让测量的 effect 反复触发。 */
const NONE: NoteAnnotation[] = [];

type Placed = { annotation: NoteAnnotation; wanted: number; anchored: boolean };

/**
 * 页边的铅笔批注：AI 读完笔记后在页边写的几句话，锚在笔记里的一小段原文旁边，
 * 原文下面一道铅笔波浪线（CSS 自定义高亮，不改笔记内容）。每条都能擦掉。
 * 找不到原文（笔记改过了）的批注排在最后，颜色更淡。
 */
export function PencilMargin({
  videoId,
  editor,
  sheetRef,
}: {
  videoId: string;
  editor: Editor | null;
  sheetRef: RefObject<HTMLDivElement | null>;
}) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const { data: annotations = NONE } = useQuery({
    queryKey: qk.noteAnnotations(videoId),
    queryFn: () => ipc.ai.noteAnnotations(videoId),
  });
  const erase = useMutation({
    mutationFn: (id: string) => ipc.ai.eraseNoteAnnotation(videoId, id),
    onMutate: (id) =>
      qc.setQueryData<NoteAnnotation[]>(qk.noteAnnotations(videoId), (list = []) =>
        list.filter((item) => item.id !== id),
      ),
  });
  const [placed, setPlaced] = useState<Placed[]>([]);
  const [tops, setTops] = useState<number[]>([]);
  const noteRefs = useRef<(HTMLDivElement | null)[]>([]);

  const measure = useCallback(() => {
    const sheet = sheetRef.current;
    const root = editor && !editor.isDestroyed ? (editor.view.dom as HTMLElement) : null;
    if (!sheet || !root) return;
    const base = sheet.getBoundingClientRect().top;
    const ranges: Range[] = [];
    let lastBottom = 0;
    const next: Placed[] = annotations.map((annotation) => {
      const range = findQuoteRange(root, annotation.quote);
      if (!range) return { annotation, wanted: Number.POSITIVE_INFINITY, anchored: false };
      ranges.push(range);
      const rect = range.getBoundingClientRect();
      lastBottom = Math.max(lastBottom, rect.bottom - base);
      return { annotation, wanted: rect.top - base - 2, anchored: true };
    });
    for (const item of next) if (!item.anchored) item.wanted = lastBottom + GAP;
    setPlaced(next);
    const registry = (globalThis as { CSS?: { highlights?: Map<string, unknown> } }).CSS?.highlights;
    const HighlightCtor = (globalThis as { Highlight?: new (...ranges: Range[]) => unknown }).Highlight;
    if (registry && HighlightCtor) registry.set(HIGHLIGHT, new HighlightCtor(...ranges));
  }, [annotations, editor, sheetRef]);

  // 批注变了、笔记改了、版面变宽变窄：重新找位置。
  useEffect(() => {
    measure();
    if (!editor) return;
    let timer = 0;
    const onUpdate = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(measure, 150);
    };
    editor.on("update", onUpdate);
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(onUpdate);
    if (sheetRef.current) observer?.observe(sheetRef.current);
    return () => {
      window.clearTimeout(timer);
      editor.off("update", onUpdate);
      observer?.disconnect();
    };
  }, [editor, measure, sheetRef]);

  useEffect(
    () => () => {
      const registry = (globalThis as { CSS?: { highlights?: Map<string, unknown> } }).CSS?.highlights;
      registry?.delete(HIGHLIGHT);
    },
    [],
  );

  // 量过每条批注的高度后，把重叠的往下推。
  useLayoutEffect(() => {
    const heights = placed.map((_, i) => noteRefs.current[i]?.offsetHeight ?? 0);
    const next = stackTops(
      placed.map((item) => item.wanted),
      heights,
    );
    setTops((prev) => (prev.length === next.length && prev.every((v, i) => v === next[i]) ? prev : next));
  }, [placed]);

  if (annotations.length === 0) return null;
  return (
    <div className="ca-pencil-margin" aria-label={t("notes.pencil.margin")}>
      {placed.map(({ annotation, anchored }, i) => (
        <div
          key={annotation.id}
          ref={(node) => {
            noteRefs.current[i] = node;
          }}
          className="ca-pencil-note"
          data-loose={anchored ? undefined : ""}
          style={{ top: tops[i] ?? 0 }}
          title={anchored ? t("notes.pencil.about", { quote: annotation.quote }) : t("notes.pencil.lost")}
        >
          <span>{annotation.note}</span>
          <button
            type="button"
            className="ca-pencil-erase"
            aria-label={t("notes.pencil.erase")}
            title={t("notes.pencil.erase")}
            onClick={() => erase.mutate(annotation.id)}
          >
            <Eraser aria-hidden="true" />
          </button>
        </div>
      ))}
    </div>
  );
}
