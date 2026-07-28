import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { Table } from "@tiptap/extension-table";
import { TableRow } from "@tiptap/extension-table-row";
import { TableHeader } from "@tiptap/extension-table-header";
import { TableCell } from "@tiptap/extension-table-cell";
import { type ExportItem } from "./ExportMenu";
import { TextSkeleton } from "@/components/ui/skeleton";
import { ErrorNote } from "@/components/ui/ErrorNote";
import { PanelActions } from "./PanelActions";
import {
  invalidateStaleArtifacts,
  useStaleArtifacts,
} from "@/lib/useStaleArtifacts";
import { ipc } from "@/lib/ipc";
import { markdownToTiptap } from "@/lib/markdownToTiptap";
import { readVideoResumeState, writeVideoResumeState } from "@/lib/resumeState";
import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { TimestampNode, installTimestampClick } from "./notes/timestampNode";
import { MathNode } from "./notes/mathNode";
import { RagSearchPanel } from "./RagSearchPanel";
import { TimestampToggle } from "./TimestampToggle";
import { useTimestampPrefs } from "@/stores/timestampPrefs";
import { useInlineAsk } from "@/stores/inlineAsk";
import { NotesWriteQueue } from "@/lib/notesWriteQueue";

// markmap 较重，仅在切到「脑图」时才加载。
const QuizPanel = lazy(() =>
  import("./QuizPanel").then((m) => ({ default: m.QuizPanel })),
);
const MindmapPanel = lazy(() =>
  import("./MindmapPanel").then((m) => ({ default: m.MindmapPanel })),
);

const notesWriter = new NotesWriteQueue((videoId, contentJson) =>
  ipc.ai.saveNotes(videoId, contentJson),
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
  // 就地追问：待处理上下文出现时自动切到「提问」视图（外层标签由 TabsPanel 切换）。
  const pendingAsk = useInlineAsk((s) => s.pending);
  useEffect(() => {
    if (pendingAsk) setView("ask");
  }, [pendingAsk]);
  const showTimestamps = useTimestampPrefs((s) => s.showTimestamps);
  const qc = useQueryClient();
  const rootRef = useRef<HTMLDivElement>(null);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [saveError, setSaveError] = useState<unknown>(null);

  const notesQuery = useQuery({
    queryKey: ["notes", videoId],
    queryFn: () => ipc.ai.getNotes(videoId),
  });
  const notesContent = notesQuery.data;

  function debounceSave(json: string) {
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      saveTimer.current = undefined;
      void notesWriter.enqueue(videoId, json).then(
        () => setSaveError(null),
        (error) => setSaveError(error),
      );
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
    // 还在查库时什么都不动，免得先闪一下空编辑器。
    if (!editor || notesQuery.isPending) return;
    if (notesContent == null || notesContent.trim() === "") {
      // 这个视频还没有笔记 —— 必须把编辑器清空。面板在标签之间是保活的（不重建），
      // 早退就会继续显示上一个视频的笔记；用户一旦在上面接着打字，那份内容会被
      // 存到**新视频**名下，等于把别人的笔记搬了家。
      editor.commands.setContent({ type: "doc", content: [{ type: "paragraph" }] });
      return;
    }
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
  }, [editor, notesContent, notesQuery.isPending]);

  // 切走视频 / 卸载前：若去抖窗口内还有未落库的编辑，立刻刷盘，避免丢失。
  // cleanup 在 videoId 变化时以「旧 videoId + 旧内容」运行，正好把上一条编辑存回原视频。
  useEffect(() => {
    return () => {
      if (saveTimer.current !== undefined) {
        clearTimeout(saveTimer.current);
        saveTimer.current = undefined;
        if (editor) {
          void notesWriter
            .enqueue(videoId, JSON.stringify(editor.getJSON()))
            .catch(() => undefined);
        }
      }
    };
  }, [videoId, editor]);

  useEffect(() => {
    if (rootRef.current) return installTimestampClick(rootRef.current);
  }, []);

  useEffect(() => {
    // 把 ref 快照进闭包：cleanup 运行时 scrollerRef.current 可能已被 React 置空。
    const scroller = scrollerRef.current;
    return () => {
      if (view === "notes" && scroller) {
        writeVideoResumeState(videoId, {
          notesScrollTop: scroller.scrollTop,
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
    mutationFn: async (task: "notes" | "quiz" | "mindmap") => {
      // An already-started autosave must finish before generation clears content_json.
      await notesWriter.flush(videoId);
      return ipc.ai.generate(videoId, task);
    },
    // 取消可能挂起的自动保存，避免「删空笔记后生成」时旧的空内容把新笔记盖回去。
    onMutate: () => clearTimeout(saveTimer.current),
    onSuccess: (_d, task) => {
      qc.invalidateQueries({ queryKey: [task, videoId] });
      invalidateStaleArtifacts(qc, videoId);
    },
  });

  const current = VIEWS.find((v) => v.key === view)!;
  const currentTask = current.task;
  const stale = useStaleArtifacts(videoId);

  const exportItems: ExportItem[] =
    view === "notes"
      ? [{ label: "Markdown", run: () => ipc.export.notes(videoId), mime: "text/markdown", saveAs: "notes.md" }]
      : view === "quiz"
        ? [{ label: "Anki", run: () => ipc.export.quiz(videoId), mime: "text/plain", saveAs: "quiz-anki.txt" }]
        : view === "mindmap"
          ? [{ label: "Markdown", run: () => ipc.export.mindmap(videoId), mime: "text/markdown", saveAs: "mindmap.md" }]
          : [];

  return (
    <div
      ref={rootRef}
      data-notes-root=""
      {...(showTimestamps ? {} : { "data-hide-timestamps": "" })}
      className="relative flex h-full flex-col"
    >
      {/* 互斥视图切换：做成 segmented control（凹槽轨道 + 凸起选中段），读作一个
          整体控件，与外层下划线大字标签形成清晰的层级区分，而非两套割裂的标签样式。
          用 aria-pressed 传达选中态；不用 role="tab"——外层已有同名「笔记」tab，
          再嵌一层 tablist 会造成无障碍名重复。 */}
      <div className="border-b border-[var(--border-subtle)] px-3 py-2">
        <div
          role="group"
          aria-label="学习工具"
          className="inline-flex items-center gap-0.5 rounded-lg bg-[var(--surface-card)] p-0.5"
        >
          {VIEWS.map((v) => (
            <button
              key={v.key}
              aria-pressed={view === v.key}
              onClick={() => setView(v.key)}
              className={`ca-touch-44 rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${
                view === v.key
                  ? "bg-[var(--surface-panel)] text-[var(--text-strong)] shadow-sm"
                  : "text-[var(--text-muted)] hover:text-[var(--text-normal)]"
              }`}
            >
              {v.label}
            </button>
          ))}
        </div>
      </div>
      {generate.isError && (
        <ErrorNote
          className="mx-3 mb-2"
          error={generate.error}
          onRetry={currentTask ? () => generate.mutate(currentTask) : undefined}
        />
      )}
      {saveError != null && (
        <ErrorNote
          className="mx-3 mb-2"
          error={saveError}
          onRetry={() => {
            void notesWriter.flush(videoId).then(
              () => setSaveError(null),
              (error) => setSaveError(error),
            );
          }}
        />
      )}
      {view === "notes" && notesQuery.isError && (
        <ErrorNote
          className="mx-3 mb-2"
          error={notesQuery.error}
          onRetry={() => void notesQuery.refetch()}
        />
      )}
      {view === "ask" || view === "search" ? (
        // 问答/搜索自带满高布局 + 底部输入栏，不套外层滚动容器（否则底部输入栏会被 pb 挤上去）。
        <div className="min-h-0 flex-1">
          <RagSearchPanel videoId={videoId} mode={view} />
          {view === "ask" && (
            <div className="pointer-events-none absolute bottom-[68px] right-3 z-10">
              <div className="pointer-events-auto">
                <TimestampToggle />
              </div>
            </div>
          )}
        </div>
      ) : (
        <div
          ref={scrollerRef}
          aria-label="笔记内容滚动区"
          className="min-h-0 flex-1 overflow-y-auto pb-12"
          onScroll={rememberNotesScroll}
        >
          {view === "notes" &&
            (notesQuery.isPending ? (
              <div className="p-4">
                <TextSkeleton lines={5} />
              </div>
            ) : notesQuery.isError ? null : (
              <EditorContent editor={editor} />
            ))}
          {(view === "quiz" || view === "mindmap") && (
            <Suspense fallback={<TextSkeleton lines={5} />}>
              {view === "quiz" && <QuizPanel videoId={videoId} />}
              {view === "mindmap" && <MindmapPanel videoId={videoId} />}
            </Suspense>
          )}
        </div>
      )}
      {currentTask && (
        <PanelActions
          leading={view === "notes" ? <TimestampToggle /> : undefined}
          onRegenerate={() => generate.mutate(currentTask)}
          regenerating={generate.isPending}
          hasContent={view === "notes" ? !!notesContent : undefined}
          stale={stale.has(currentTask)}
          exportItems={exportItems}
        />
      )}
    </div>
  );
}
