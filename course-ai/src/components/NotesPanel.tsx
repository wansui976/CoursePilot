import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { Button } from "@/components/ui/button";
import { ipc } from "@/lib/ipc";
import { markdownToTiptap } from "@/lib/markdownToTiptap";
import { TimestampNode, installTimestampClick } from "./notes/timestampNode";
import { QuizPanel } from "./QuizPanel";
import { MindmapPanel } from "./MindmapPanel";

type View = "notes" | "quiz" | "mindmap";
const VIEWS: { key: View; label: string; task: "notes" | "quiz" | "mindmap" }[] =
  [
    { key: "notes", label: "AI笔记", task: "notes" },
    { key: "quiz", label: "AI出题", task: "quiz" },
    { key: "mindmap", label: "AI脑图", task: "mindmap" },
  ];

export function NotesPanel({ videoId }: { videoId: string }) {
  const [view, setView] = useState<View>("notes");
  const qc = useQueryClient();
  const rootRef = useRef<HTMLDivElement>(null);
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const { data: notesContent } = useQuery({
    queryKey: ["notes", videoId],
    queryFn: () => ipc.ai.getNotes(videoId),
  });

  function debounceSave(json: string) {
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(async () => {
      await ipc.ai.saveNotes(videoId, json);
      setSavedAt(new Date().toLocaleTimeString());
    }, 800);
  }

  const editor = useEditor({
    extensions: [StarterKit, TimestampNode],
    content: { type: "doc", content: [{ type: "paragraph" }] },
    editorProps: {
      attributes: {
        class: "prose prose-invert max-w-none p-4 focus:outline-none",
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

  const generate = useMutation({
    mutationFn: (task: "notes" | "quiz" | "mindmap") =>
      ipc.ai.generate(videoId, task),
    onSuccess: (_d, task) => {
      qc.invalidateQueries({ queryKey: [task, videoId] });
    },
  });

  const current = VIEWS.find((v) => v.key === view)!;

  return (
    <div ref={rootRef} className="flex h-full flex-col">
      <div className="flex items-center gap-2 border-b border-white/10 px-3 py-2">
        {VIEWS.map((v) => (
          <button
            key={v.key}
            onClick={() => setView(v.key)}
            className={`rounded px-2 py-1 text-xs ${
              view === v.key
                ? "bg-primary/20 text-primary"
                : "text-white/50 hover:bg-white/5"
            }`}
          >
            {v.label}
          </button>
        ))}
        <div className="ml-auto flex items-center gap-2">
          {view === "notes" && savedAt && (
            <span className="text-xs text-white/30">已保存 {savedAt}</span>
          )}
          <Button
            size="sm"
            variant="outline"
            disabled={generate.isPending}
            onClick={() => generate.mutate(current.task)}
          >
            {generate.isPending ? "生成中…" : `生成${current.label}`}
          </Button>
        </div>
      </div>
      {generate.isError && (
        <p className="px-3 py-2 text-xs text-red-400">
          {String(generate.error)}
        </p>
      )}
      <div className="flex-1 overflow-y-auto">
        {view === "notes" && <EditorContent editor={editor} />}
        {view === "quiz" && <QuizPanel videoId={videoId} />}
        {view === "mindmap" && <MindmapPanel videoId={videoId} />}
      </div>
    </div>
  );
}
