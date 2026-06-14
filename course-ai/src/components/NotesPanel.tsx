import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { Table } from "@tiptap/extension-table";
import { TableRow } from "@tiptap/extension-table-row";
import { TableHeader } from "@tiptap/extension-table-header";
import { TableCell } from "@tiptap/extension-table-cell";
import { type ExportItem } from "./ExportMenu";
import { TextSkeleton } from "@/components/ui/skeleton";
import { PanelActions } from "./PanelActions";
import { ipc } from "@/lib/ipc";
import { markdownToTiptap } from "@/lib/markdownToTiptap";
import { readVideoResumeState, writeVideoResumeState } from "@/lib/resumeState";
import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { TimestampNode, installTimestampClick } from "./notes/timestampNode";
import { MathNode } from "./notes/mathNode";
import { RagSearchPanel } from "./RagSearchPanel";

// markmap 较重，仅在切到「脑图」时才加载。
const QuizPanel = lazy(() =>
  import("./QuizPanel").then((m) => ({ default: m.QuizPanel })),
);
const MindmapPanel = lazy(() =>
  import("./MindmapPanel").then((m) => ({ default: m.MindmapPanel })),
);

type View = "notes" | "quiz" | "mindmap" | "ask" | "search";
const VIEWS: { key: View; label: string; task?: "notes" | "quiz" | "mindmap" }[] =
  [
    { key: "notes", label: "笔记", task: "notes" },
    { key: "quiz", label: "出题", task: "quiz" },
    { key: "mindmap", label: "脑图", task: "mindmap" },
    { key: "ask", label: "提问" },
    { key: "search", label: "搜索" },
  ];

export function NotesPanel({ videoId }: { videoId: string }) {
  const [view, setView] = useState<View>("notes");
  const qc = useQueryClient();
  const rootRef = useRef<HTMLDivElement>(null);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const { data: notesContent } = useQuery({
    queryKey: ["notes", videoId],
    queryFn: () => ipc.ai.getNotes(videoId),
  });

  function debounceSave(json: string) {
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      void ipc.ai.saveNotes(videoId, json);
    }, 800);
  }

  const editor = useEditor({
    extensions: [
      StarterKit,
      TimestampNode,
      MathNode,
      Table.configure({ resizable: false }),
      TableRow,
      TableHeader,
      TableCell,
    ],
    content: { type: "doc", content: [{ type: "paragraph" }] },
    editorProps: {
      attributes: {
        class: "tiptap-notes max-w-none p-4 focus:outline-none",
      },
    },
    onUpdate: ({ editor }) => debounceSave(JSON.stringify(editor.getJSON())),
  });

  // 加载已有笔记：content_json（"{...}"）或 content_md（markdown）
  useEffect(() => {
    if (!editor || notesContent == null) return;
    try {
      const parsed = JSON.parse(notesContent);
      if (parsed && parsed.type === "doc") {
        editor.commands.setContent(parsed);
        return;
      }
    } catch {
      // 非 JSON → 当作 markdown
    }
    editor.commands.setContent(markdownToTiptap(notesContent));
  }, [editor, notesContent]);

  useEffect(() => {
    if (rootRef.current) return installTimestampClick(rootRef.current);
  }, []);

  useEffect(() => {
    return () => {
      if (view === "notes" && scrollerRef.current) {
        writeVideoResumeState(videoId, {
          notesScrollTop: scrollerRef.current.scrollTop,
        });
      }
    };
  }, [videoId, view]);

  useEffect(() => {
    if (view !== "notes" || !scrollerRef.current) return;
    const savedScrollTop = readVideoResumeState(videoId).notesScrollTop;
    scrollerRef.current.scrollTop = savedScrollTop;
  }, [notesContent, videoId, view]);

  function rememberNotesScroll() {
    if (view !== "notes" || !scrollerRef.current) return;
    writeVideoResumeState(videoId, {
      notesScrollTop: scrollerRef.current.scrollTop,
    });
  }

  const generate = useMutation({
    mutationFn: (task: "notes" | "quiz" | "mindmap") =>
      ipc.ai.generate(videoId, task),
    // 取消可能挂起的自动保存，避免「删空笔记后生成」时旧的空内容把新笔记盖回去。
    onMutate: () => clearTimeout(saveTimer.current),
    onSuccess: (_d, task) => {
      qc.invalidateQueries({ queryKey: [task, videoId] });
    },
  });

  const current = VIEWS.find((v) => v.key === view)!;
  const currentTask = current.task;

  const exportItems: ExportItem[] =
    view === "notes"
      ? [{ label: "Markdown", run: () => ipc.export.notes(videoId) }]
      : view === "quiz"
        ? [{ label: "Anki", run: () => ipc.export.quiz(videoId) }]
        : view === "mindmap"
          ? [{ label: "Markdown", run: () => ipc.export.mindmap(videoId) }]
          : [];

  return (
    <div ref={rootRef} className="relative flex h-full flex-col">
      <div className="flex items-center gap-2 border-b border-[var(--border-subtle)] px-3 py-2">
        {VIEWS.map((v) => (
          <button
            key={v.key}
            onClick={() => setView(v.key)}
            className={`rounded px-2 py-1 text-xs ${
              view === v.key
                ? "bg-primary/20 text-primary"
                : "text-[var(--text-muted)] hover:bg-[var(--surface-card)]"
            }`}
          >
            {v.label}
          </button>
        ))}
      </div>
      {generate.isError && (
        <p className="px-3 py-2 text-xs text-[var(--status-err)]">
          {String(generate.error)}
        </p>
      )}
      <div
        ref={scrollerRef}
        aria-label="笔记内容滚动区"
        className="min-h-0 flex-1 overflow-y-auto pb-12"
        onScroll={rememberNotesScroll}
      >
        {view === "notes" && <EditorContent editor={editor} />}
        {(view === "quiz" || view === "mindmap") && (
          <Suspense fallback={<TextSkeleton lines={5} />}>
            {view === "quiz" && <QuizPanel videoId={videoId} />}
            {view === "mindmap" && <MindmapPanel videoId={videoId} />}
          </Suspense>
        )}
        {view === "ask" && <RagSearchPanel videoId={videoId} mode="ask" />}
        {view === "search" && <RagSearchPanel videoId={videoId} mode="search" />}
      </div>
      {currentTask && (
        <PanelActions
          onRegenerate={() => generate.mutate(currentTask)}
          regenerating={generate.isPending}
          hasContent={view === "notes" ? !!notesContent : undefined}
          exportItems={exportItems}
        />
      )}
    </div>
  );
}
