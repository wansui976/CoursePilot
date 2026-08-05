import { useTranslation } from "react-i18next";
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
import { useEffect, useRef, useState } from "react";
import { TimestampNode, installTimestampClick } from "./notes/timestampNode";
import { MathNode } from "./notes/mathNode";
import { TimestampToggle } from "./TimestampToggle";
import { useTimestampPrefs } from "@/stores/timestampPrefs";
import { NotesWriteQueue } from "@/lib/notesWriteQueue";

const notesWriter = new NotesWriteQueue((videoId, contentJson) =>
  ipc.ai.saveNotes(videoId, contentJson),
);
const backgroundSaveErrors = new Map<string, unknown>();

type SaveStatus = "unsaved" | "saving" | "saved" | "error";

const SAVE_STATUS_I18N: Record<SaveStatus, string> = {
  unsaved: "notes.unsaved",
  saving: "notes.saving",
  saved: "notes.saved",
  error: "notes.error",
};
export function NotesPanel({ videoId }: { videoId: string }) {
  const { t } = useTranslation();
  const showTimestamps = useTimestampPrefs((s) => s.showTimestamps);
  const qc = useQueryClient();
  const rootRef = useRef<HTMLDivElement>(null);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [saveError, setSaveError] = useState<unknown>(null);
  const [saveStatus, setSaveStatus] = useState<SaveStatus>("saved");
  const activeVideoIdRef = useRef(videoId);
  const mountedRef = useRef(true);
  activeVideoIdRef.current = videoId;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    const error = backgroundSaveErrors.get(videoId);
    setSaveError(error ?? null);
    setSaveStatus(
      error ? "error" : notesWriter.hasPending(videoId) ? "unsaved" : "saved",
    );
  }, [videoId]);

  const notesQuery = useQuery({
    queryKey: ["notes", videoId],
    queryFn: () => ipc.ai.getNotes(videoId),
  });
  const notesContent = notesQuery.data;

  function debounceSave(json: string) {
    const targetVideoId = activeVideoIdRef.current;
    clearTimeout(saveTimer.current);
    backgroundSaveErrors.delete(targetVideoId);
    setSaveError(null);
    setSaveStatus("unsaved");
    saveTimer.current = setTimeout(() => {
      saveTimer.current = undefined;
      if (activeVideoIdRef.current === targetVideoId) setSaveStatus("saving");
      void notesWriter.enqueue(targetVideoId, json).then(
        () => {
          backgroundSaveErrors.delete(targetVideoId);
          if (mountedRef.current && activeVideoIdRef.current === targetVideoId) {
            setSaveError(null);
            setSaveStatus("saved");
          }
        },
        (error) => {
          backgroundSaveErrors.set(targetVideoId, error);
          if (mountedRef.current && activeVideoIdRef.current === targetVideoId) {
            setSaveError(error);
            setSaveStatus("error");
          }
        },
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
  //
  // 三处 setContent 都必须显式 emitUpdate:false。**装载不是编辑**，而 tiptap 3 的
  // setContent 默认会发 update 事件（2.x 默认不发，升级时这个默认值反过来了）。
  // 不关掉的话，光是打开笔记标签就会走一遍去抖自动保存：把刚读出来的内容原样写回、
  // 盖上「用户编辑于此刻」的戳、再推一条云同步——内容一个字都没变。
  // 更糟的是下面那条清空分支：查询失败时 notesContent 是 undefined，编辑器被清空、
  // 顺手把一份空文档存回库里，用户的笔记就没了。
  useEffect(() => {
    // 还在查库时什么都不动，免得先闪一下空编辑器。
    if (!editor || notesQuery.isPending) return;
    // 查询失败时 data 是 undefined，和「这个视频没有笔记」长得一模一样。此时绝不能
    // 按空笔记处理：编辑器一清空就会被当成用户把笔记删了。
    if (notesQuery.isError) return;
    if (notesContent == null || notesContent.trim() === "") {
      // 这个视频还没有笔记 —— 必须把编辑器清空。面板在标签之间是保活的（不重建），
      // 早退就会继续显示上一个视频的笔记；用户一旦在上面接着打字，那份内容会被
      // 存到**新视频**名下，等于把别人的笔记搬了家。
      editor.commands.setContent(
        { type: "doc", content: [{ type: "paragraph" }] },
        { emitUpdate: false },
      );
      return;
    }
    try {
      const parsed = JSON.parse(notesContent);
      if (parsed && parsed.type === "doc") {
        editor.commands.setContent(parsed, { emitUpdate: false });
        return;
      }
    } catch {
      // 非 JSON → 当作 markdown
    }
    editor.commands.setContent(markdownToTiptap(notesContent), { emitUpdate: false });
  }, [editor, notesContent, notesQuery.isError, notesQuery.isPending]);

  // 切走视频 / 卸载前：若去抖窗口内还有未落库的编辑，立刻刷盘，避免丢失。
  // cleanup 在 videoId 变化时以「旧 videoId + 旧内容」运行，正好把上一条编辑存回原视频。
  useEffect(() => {
    return () => {
      if (saveTimer.current !== undefined) {
        clearTimeout(saveTimer.current);
        saveTimer.current = undefined;
        if (editor) {
          void notesWriter.enqueue(videoId, JSON.stringify(editor.getJSON())).then(
            () => {
              backgroundSaveErrors.delete(videoId);
              if (mountedRef.current && activeVideoIdRef.current === videoId) {
                setSaveError(null);
                setSaveStatus("saved");
              }
            },
            (error) => {
              backgroundSaveErrors.set(videoId, error);
              // 组件可能已经卸载，无法再显示就地反馈；记录错误并在该视频下次
              // 打开时恢复“保存失败”，确保卸载刷盘失败不会被静默吞掉。
              console.error(`Failed to flush notes for video ${videoId}`, error);
              if (mountedRef.current && activeVideoIdRef.current === videoId) {
                setSaveError(error);
                setSaveStatus("error");
              }
            },
          );
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
      if (scroller) {
        writeVideoResumeState(videoId, {
          notesScrollTop: scroller.scrollTop,
        });
      }
    };
  }, [videoId]);

  useEffect(() => {
    if (!scrollerRef.current) return;
    const savedScrollTop = readVideoResumeState(videoId).notesScrollTop;
    scrollerRef.current.scrollTop = savedScrollTop;
  }, [notesContent, videoId]);

  function rememberNotesScroll() {
    if (!scrollerRef.current) return;
    writeVideoResumeState(videoId, {
      notesScrollTop: scrollerRef.current.scrollTop,
    });
  }

  const generate = useMutation({
    mutationFn: async () => {
      // An already-started autosave must finish before generation clears content_json.
      await notesWriter.flush(videoId);
      return ipc.ai.generate(videoId, "notes");
    },
    // 取消可能挂起的自动保存，避免「删空笔记后生成」时旧的空内容把新笔记盖回去。
    onMutate: () => clearTimeout(saveTimer.current),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["notes", videoId] });
      invalidateStaleArtifacts(qc, videoId);
    },
  });

  const stale = useStaleArtifacts(videoId);
  const exportItems: ExportItem[] = [
    {
      label: "Markdown",
      run: () => ipc.export.notes(videoId),
      mime: "text/markdown",
      saveAs: "notes.md",
    },
  ];

  return (
    <div
      ref={rootRef}
      data-notes-root=""
      {...(showTimestamps ? {} : { "data-hide-timestamps": "" })}
      className="relative flex h-full flex-col"
    >
      {(saveStatus === "error" ||
        (!notesQuery.isPending && !notesQuery.isError)) && (
        <div className="flex flex-none justify-end border-b border-[var(--border-subtle)] px-3 py-2">
          <span
            role="status"
            aria-live="polite"
            aria-atomic="true"
            className={`text-xs ${
              saveStatus === "error"
                ? "text-[var(--status-err)]"
                : "text-[var(--text-faint)]"
            }`}
          >
            {t(SAVE_STATUS_I18N[saveStatus])}
          </span>
        </div>
      )}
      {generate.isError && (
        <ErrorNote
          className="mx-3 mb-2"
          error={generate.error}
          onRetry={() => generate.mutate()}
        />
      )}
      {saveError != null && (
        <ErrorNote
          className="mx-3 mb-2"
          error={saveError}
          onRetry={() => {
            setSaveStatus("saving");
            void notesWriter.flush(videoId).then(
              () => {
                backgroundSaveErrors.delete(videoId);
                if (activeVideoIdRef.current === videoId) {
                  setSaveError(null);
                  setSaveStatus("saved");
                }
              },
              (error) => {
                backgroundSaveErrors.set(videoId, error);
                if (activeVideoIdRef.current === videoId) {
                  setSaveError(error);
                  setSaveStatus("error");
                }
              },
            );
          }}
        />
      )}
      {notesQuery.isError && (
        <ErrorNote
          className="mx-3 mb-2"
          error={notesQuery.error}
          onRetry={() => void notesQuery.refetch()}
        />
      )}
      <div
        ref={scrollerRef}
        aria-label={t("notes.scrollArea")}
        className="min-h-0 flex-1 overflow-y-auto pb-12"
        onScroll={rememberNotesScroll}
      >
        {notesQuery.isPending ? (
          <div className="p-4">
            <TextSkeleton lines={5} />
          </div>
        ) : notesQuery.isError ? null : (
          <EditorContent editor={editor} />
        )}
      </div>
      <PanelActions
        leading={<TimestampToggle />}
        onRegenerate={() => generate.mutate()}
        regenerating={generate.isPending}
        hasContent={!!notesContent}
        stale={stale.has("notes")}
        exportItems={exportItems}
      />
    </div>
  );
}
