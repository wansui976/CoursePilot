import { useTranslation } from "react-i18next";
import { queries } from "@/lib/queries";
import { qk } from "@/lib/queryKeys";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { confirm as confirmDialog } from "@tauri-apps/plugin-dialog";
import { EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { Table } from "@tiptap/extension-table";
import { TableRow } from "@tiptap/extension-table-row";
import { TableHeader } from "@tiptap/extension-table-header";
import { TableCell } from "@tiptap/extension-table-cell";
import { type ExportItem } from "./ExportMenu";
import { Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { TextSkeleton } from "@/components/ui/skeleton";
import { ErrorNote } from "@/components/ui/ErrorNote";
import { PanelActions } from "./PanelActions";
import {
  invalidateStaleArtifacts,
  useStaleArtifacts,
} from "@/lib/useStaleArtifacts";
import { ipc } from "@/lib/ipc";
import { markdownToTiptap } from "@/lib/markdownToTiptap";
import { tiptapToMarkdown } from "@/lib/tiptapToMarkdown";
import { readVideoResumeState, writeVideoResumeState } from "@/lib/resumeState";
import { useEffect, useRef, useState } from "react";
import { TimestampNode, installTimestampClick } from "./notes/timestampNode";
import { MathNode } from "./notes/mathNode";
import { NotesToolbar } from "./notes/NotesToolbar";
import { TimestampToggle } from "./TimestampToggle";
import { useTimestampPrefs } from "@/stores/timestampPrefs";
import {
  notesCoordinator,
  type NotesSaveStatus,
} from "@/lib/notesCoordinator";

const SAVE_STATUS_I18N: Record<NotesSaveStatus, string> = {
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
  const [writeState, setWriteState] = useState(() =>
    notesCoordinator.getState(videoId),
  );
  const [hasLocalEdits, setHasLocalEdits] = useState(false);
  const activeVideoIdRef = useRef(videoId);
  activeVideoIdRef.current = videoId;

  useEffect(() => {
    setWriteState(notesCoordinator.getState(videoId));
    return notesCoordinator.subscribe(videoId, setWriteState);
  }, [videoId]);

  const notesQuery = useQuery(queries.notes(videoId));
  const notesContent = notesQuery.data;
  const localDraft = notesCoordinator.getDraft(videoId);

  function debounceSave(json: string) {
    const targetVideoId = activeVideoIdRef.current;
    notesCoordinator.scheduleSave(targetVideoId, json);
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
    onUpdate: ({ editor }) => {
      setHasLocalEdits(true);
      debounceSave(JSON.stringify(editor.getJSON()));
    },
  });

  useEffect(() => {
    if (!editor || editor.isDestroyed) return;
    return notesCoordinator.registerEditor(videoId, {
      getDocument: () => editor.getJSON(),
      replaceDocument: (document) => {
        editor.commands.setContent(document, { emitUpdate: false });
        setHasLocalEdits(true);
      },
    });
  }, [editor, videoId]);

  // 加载已有笔记：content_json（"{...}"）或 content_md（markdown）
  //
  // 三处 setContent 都必须显式 emitUpdate:false。**装载不是编辑**，而 tiptap 3 的
  // setContent 默认会发 update 事件（2.x 默认不发，升级时这个默认值反过来了）。
  // 不关掉的话，光是打开笔记标签就会走一遍去抖自动保存：把刚读出来的内容原样写回、
  // 盖上「用户编辑于此刻」的戳、再推一条云同步——内容一个字都没变。
  // 更糟的是下面那条清空分支：查询失败时 notesContent 是 undefined，编辑器被清空、
  // 顺手把一份空文档存回库里，用户的笔记就没了。
  useEffect(() => {
    if (!editor || editor.isDestroyed) return;
    // 卸载刷盘失败或助手追加失败时，协调器里的草稿比数据库查询更新，必须优先恢复。
    const recoverableDraft = notesCoordinator.getDraft(videoId);
    if (recoverableDraft) {
      try {
        const parsed = JSON.parse(recoverableDraft);
        if (parsed?.type === "doc") {
          editor.commands.setContent(parsed, { emitUpdate: false });
        }
      } catch {
        // 协调器只接收 Tiptap JSON；损坏草稿保留错误状态，不拿空文档覆盖它。
      }
      return;
    }
    // 还在查库时什么都不动，免得先闪一下空编辑器。
    if (notesQuery.isPending) return;
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
  }, [editor, videoId, notesContent, notesQuery.isError, notesQuery.isPending]);

  useEffect(() => {
    setHasLocalEdits(false);
  }, [videoId]);

  // 每次 onUpdate 都已经同步进入协调器草稿；切视频/卸载只需取消去抖并立刻刷盘。
  useEffect(() => {
    return () => {
      void notesCoordinator.flush(videoId).catch((error) => {
        console.error(`Failed to flush notes for video ${videoId}`, error);
      });
    };
  }, [videoId]);

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
      // 生成前先把协调器中的实时草稿刷盘；后端还会用内容快照 CAS 防止请求期间的新编辑。
      await notesCoordinator.flush(videoId);
      return ipc.ai.generate(videoId, "notes");
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qk.artifact("notes", videoId) });
      invalidateStaleArtifacts(qc, videoId);
    },
  });

  async function requestGenerate() {
    if (Boolean(notesContent?.trim()) || hasLocalEdits) {
      const confirmed = await confirmDialog(t("notes.regenerateConfirm"), {
        title: t("notes.regenerateConfirmTitle"),
        kind: "warning",
        okLabel: t("notes.regenerateConfirmAction"),
        cancelLabel: t("notes.cancel"),
      });
      if (!confirmed) return;
    }
    generate.mutate();
  }

  const stale = useStaleArtifacts(videoId);
  const exportItems: ExportItem[] = [
    {
      label: "Markdown",
      run: () => {
        if (!editor || editor.isDestroyed) {
          return Promise.reject(new Error(t("notes.editorUnavailable")));
        }
        return ipc.export.notes(videoId, tiptapToMarkdown(editor.getJSON()));
      },
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
      {/* 选中文字时的浮出格式条（tiptap BubbleMenu，不占布局空间）。 */}
      {editor && <NotesToolbar editor={editor} />}
      {(writeState.status === "error" ||
        (!notesQuery.isPending && !notesQuery.isError)) && (
        <div className="flex flex-none justify-end border-b border-[var(--border-subtle)] px-3 py-2">
          <span
            role="status"
            aria-live="polite"
            aria-atomic="true"
            className={`text-xs ${
              writeState.status === "error"
                ? "text-[var(--status-err)]"
                : "text-[var(--text-faint)]"
            }`}
          >
            {t(SAVE_STATUS_I18N[writeState.status])}
          </span>
        </div>
      )}
      {generate.isError && (
        <ErrorNote
          className="mx-3 mb-2"
          error={generate.error}
          // 冲突说明首次确认后又有了新编辑；重试必须重新走覆盖确认，
          // 不能从错误条直接开始另一次会清掉新内容的生成。
          onRetry={() => void requestGenerate()}
        />
      )}
      {writeState.error != null && (
        <ErrorNote
          className="mx-3 mb-2"
          error={writeState.error}
          onRetry={() => {
            void notesCoordinator.flush(videoId).catch(() => {});
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
        {notesQuery.isPending && !localDraft ? (
          <div className="p-4">
            <TextSkeleton lines={5} />
          </div>
        ) : notesQuery.isError && !localDraft ? null : (
          <>
            {/* 空态引导：没有已存笔记、也没开始写时，提示可让 AI 生成。开始打字即消失。 */}
            {!localDraft && !hasLocalEdits && !notesContent?.trim() && (
              <div className="mx-4 mt-4 flex items-start gap-3 rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-card)] p-4">
                <span className="grid h-9 w-9 flex-none place-items-center rounded-lg bg-[var(--accent-weak)] text-[var(--accent-text)]">
                  <Sparkles className="h-4 w-4" />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium text-[var(--text-strong)]">
                    {t("notes.emptyTitle")}
                  </p>
                  <p className="mt-1 text-xs leading-5 text-[var(--text-muted)]">
                    {t("notes.emptyDescription")}
                  </p>
                  <Button
                    type="button"
                    variant="primary"
                    size="sm"
                    onClick={() => void requestGenerate()}
                    disabled={generate.isPending}
                    className="ca-touch-44 mt-2 gap-1.5"
                  >
                    <Sparkles className={`h-3.5 w-3.5 ${generate.isPending ? "animate-pulse" : ""}`} />
                    {generate.isPending ? t("notes.generating") : t("notes.generateNotes")}
                  </Button>
                </div>
              </div>
            )}
            <EditorContent editor={editor} />
          </>
        )}
      </div>
      <PanelActions
        leading={<TimestampToggle />}
        onRegenerate={() => void requestGenerate()}
        regenerating={generate.isPending}
        hasContent={Boolean(localDraft ?? notesContent) || hasLocalEdits}
        stale={stale.has("notes")}
        exportItems={
          (notesQuery.isPending || notesQuery.isError) && !localDraft ? [] : exportItems
        }
      />
    </div>
  );
}
