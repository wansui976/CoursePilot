import { useTranslation } from "react-i18next";
import { queries } from "@/lib/queries";
import { qk } from "@/lib/queryKeys";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { confirm as confirmDialog } from "@tauri-apps/plugin-dialog";
import { type Editor, EditorContent, useEditor } from "@tiptap/react";
import { type ExportItem } from "./ExportMenu";
import { ArchiveRestore, NotebookPen, X } from "lucide-react";
import { Button } from "@/ui/button";
import { TextSkeleton } from "@/ui/skeleton";
import { ErrorNote } from "@/ui/ErrorNote";
import { useNoteCapture } from "@/stores/noteCapture";
import { keyLabel, useShortcuts } from "@/stores/shortcuts";
import { usePlayer } from "@/stores/player";
import { PanelActions, panelActionButtonClass } from "./PanelActions";
import { NoteHistoryDialog } from "./notes/NoteHistoryDialog";
import { noteContentToDoc } from "./notes/noteVersionContent";
import { saveShareCard, shareCardHeader, useShareCardLabels } from "./useShareCard";
import { renderNotesCard } from "@/lib/shareCard/render";
import {
  invalidateStaleArtifacts,
  useStaleArtifacts,
} from "@/lib/useStaleArtifacts";
import { ipc } from "@/lib/ipc";
import { markdownToTiptap } from "@/lib/markdownToTiptap";
import { tiptapToMarkdown } from "@/lib/tiptapToMarkdown";
import { readVideoResumeState, writeVideoResumeState } from "@/lib/resumeState";
import { useEffect, useRef, useState } from "react";
import { installTimestampClick } from "./notes/timestampNode";
import { notesExtensions } from "./notes/extensions";
import {
  captureFrameBlocks,
  imageBlocks,
  imageFiles,
  insertBlocks,
  storeNoteImage,
  type StoredImage,
} from "./notes/insertImages";
import { ImageTooLargeError } from "./notes/prepareImage";
import { looksLikeMarkdown, markdownPasteContent } from "./notes/pasteMarkdown";
import { loadDocument } from "./notes/loadDocument";
import { insertNoteStamp } from "./notes/insertNoteStamp";
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
/** 一次改动后正文只剩不到这个比例、且原先至少这么长，就提示「笔记一下子少了一大半」。 */
const DROP_RATIO = 0.2;
const DROP_MIN_LENGTH = 200;

function docTextLength(editor: { state?: { doc: { textContent: string } } }): number {
  return editor.state?.doc.textContent.length ?? 0;
}

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

  const [historyOpen, setHistoryOpen] = useState(false);
  const takeNoteKey = useShortcuts((s) => s.bindings.takeNote);
  const [dropAlert, setDropAlert] = useState(false);
  // 上一次的正文长度：装载时重置，每次编辑后更新，用来发现「一下子少了一大半」。
  const lastTextLengthRef = useRef(0);

  // 图片：压缩、存库是异步的，期间按钮置灰；失败提示几秒后自己消失。
  const [imageBusy, setImageBusy] = useState(false);
  const [imageError, setImageError] = useState<unknown>(null);
  const editorRef = useRef<Editor | null>(null);
  const insertImagesRef = useRef<(files: File[], at?: number) => void>(() => {});

  useEffect(() => {
    if (imageError == null) return;
    const timer = window.setTimeout(() => setImageError(null), 8000);
    return () => window.clearTimeout(timer);
  }, [imageError]);

  async function withImageWork(work: (target: string) => Promise<void>) {
    const target = videoId;
    setImageBusy(true);
    setImageError(null);
    try {
      await work(target);
    } catch (error) {
      setImageError(error instanceof ImageTooLargeError ? new Error(t("notes.imageTooLarge")) : error);
    } finally {
      setImageBusy(false);
    }
  }

  /** 存好之后再插：面板在视频之间保活，存图期间切了视频就不插，免得进了别的视频的笔记。 */
  function insertWhenStillHere(target: string, run: (editor: Editor) => void) {
    const current = editorRef.current;
    if (!current || current.isDestroyed || activeVideoIdRef.current !== target) return;
    run(current);
  }

  function insertImages(files: File[], at?: number) {
    void withImageWork(async (target) => {
      const stored: StoredImage[] = [];
      for (const file of files) stored.push(await storeNoteImage(target, file));
      insertWhenStillHere(target, (editor) => insertBlocks(editor, imageBlocks(stored), at));
    });
  }
  insertImagesRef.current = insertImages;

  function captureFrame() {
    void withImageWork(async (target) => {
      const blocks = await captureFrameBlocks(target, usePlayer.getState().currentMs);
      insertWhenStillHere(target, (editor) => insertBlocks(editor, blocks));
    });
  }

  function debounceSave(json: string) {
    const targetVideoId = activeVideoIdRef.current;
    notesCoordinator.scheduleSave(targetVideoId, json);
  }

  const editor = useEditor({
    extensions: notesExtensions(),
    content: { type: "doc", content: [{ type: "paragraph" }] },
    editorProps: {
      attributes: {
        class: "tiptap-notes ca-reading ca-reading-measure p-4 focus:outline-none",
      },
      handlePaste: (_view, event) => {
        const data = event.clipboardData;
        if (!data) return false;
        const text = data.getData("text/plain");
        // 截图、从网页「拷贝图像」：剪贴板里只有图片，没有文字。
        const files = imageFiles(data.files);
        if (files.length && !text.trim()) {
          insertImagesRef.current(files);
          return true;
        }
        // 纯文本的 Markdown（.md 文件、代码编辑器、AI 对话里复制来的）转成格式；
        // 带 HTML 的（网页、文档）交给编辑器默认处理。
        if (!data.getData("text/html") && looksLikeMarkdown(text)) {
          editorRef.current?.chain().focus().insertContent(markdownPasteContent(text)).run();
          return true;
        }
        return false;
      },
      handleDrop: (view, event, _slice, moved) => {
        if (moved) return false;
        const files = imageFiles(event.dataTransfer?.files);
        if (!files.length) return false;
        event.preventDefault();
        const at = view.posAtCoords({ left: event.clientX, top: event.clientY })?.pos;
        insertImagesRef.current(files, at);
        return true;
      },
    },
    onUpdate: ({ editor }) => {
      setHasLocalEdits(true);
      const length = docTextLength(editor);
      const previous = lastTextLengthRef.current;
      if (previous >= DROP_MIN_LENGTH && length < previous * DROP_RATIO) setDropAlert(true);
      else if (length >= previous * DROP_RATIO) setDropAlert(false);
      lastTextLengthRef.current = length;
      debounceSave(JSON.stringify(editor.getJSON()));
    },
  });

  editorRef.current = editor;

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
  // 装载（loadDocument）里的 setContent 必须显式 emitUpdate:false。**装载不是编辑**，而 tiptap 3 的
  // setContent 默认会发 update 事件（2.x 默认不发，升级时这个默认值反过来了）。
  // 不关掉的话，光是打开笔记标签就会走一遍去抖自动保存：把刚读出来的内容原样写回、
  // 盖上「用户编辑于此刻」的戳、再推一条云同步——内容一个字都没变。
  // 更糟的是下面那条清空分支：查询失败时 notesContent 是 undefined，编辑器被清空、
  // 顺手把一份空文档存回库里，用户的笔记就没了。
  useEffect(() => {
    if (!editor || editor.isDestroyed) return;
    const loadInto = (content: Parameters<typeof loadDocument>[1]) => {
      loadDocument(editor, content);
      lastTextLengthRef.current = docTextLength(editor);
      setDropAlert(false);
    };
    // 卸载刷盘失败或助手追加失败时，协调器里的草稿比数据库查询更新，必须优先恢复。
    const recoverableDraft = notesCoordinator.getDraft(videoId);
    if (recoverableDraft) {
      try {
        const parsed = JSON.parse(recoverableDraft);
        if (parsed?.type === "doc") {
          loadInto(parsed);
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
      loadInto({ type: "doc", content: [{ type: "paragraph" }] });
      return;
    }
    try {
      const parsed = JSON.parse(notesContent);
      if (parsed && parsed.type === "doc") {
        loadInto(parsed);
        return;
      }
    } catch {
      // 非 JSON → 当作 markdown
    }
    loadInto(markdownToTiptap(notesContent));
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

  // 「记一笔」：笔记装载完成后，在末尾插入当前时间戳并把光标停在后面接着写。
  const captureRequest = useNoteCapture((s) => s.request);
  useEffect(() => {
    if (!captureRequest || captureRequest.videoId !== videoId) return;
    if (!editor || editor.isDestroyed || notesQuery.isPending) return;
    insertNoteStamp(editor, captureRequest.ms);
    scrollerRef.current?.scrollTo({ top: scrollerRef.current.scrollHeight });
    useNoteCapture.getState().done(captureRequest.nonce);
  }, [captureRequest, editor, notesQuery.isPending, videoId]);

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
  const shareLabels = useShareCardLabels();
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
    {
      // 分享长图：按当前编辑器里的内容画，用户刚改的也算。
      label: t("export.notesImage"),
      run: () => {
        if (!editor || editor.isDestroyed) {
          return Promise.reject(new Error(t("notes.editorUnavailable")));
        }
        const canvas = renderNotesCard(
          shareCardHeader(qc, videoId, t("shareCard.notesKind")),
          tiptapToMarkdown(editor.getJSON()),
          shareLabels,
        );
        return saveShareCard(canvas, { videoId, fileName: t("shareCard.notesFile") });
      },
      mime: "image/png",
    },
  ];

  return (
    <div
      ref={rootRef}
      data-notes-root=""
      {...(showTimestamps ? {} : { "data-hide-timestamps": "" })}
      className="relative flex h-full flex-col"
    >
      {(writeState.status === "error" ||
        (!notesQuery.isPending && !notesQuery.isError)) && (
        <div className="relative flex flex-none items-center gap-2 border-b border-[var(--border-subtle)] py-1 pl-2 pr-3">
          {editor ? (
            <NotesToolbar
              editor={editor}
              imageBusy={imageBusy}
              onInsertImages={(files) => insertImages(files)}
              onCaptureFrame={captureFrame}
            />
          ) : (
            <span className="flex-1" />
          )}
          <span
            role="status"
            aria-live="polite"
            aria-atomic="true"
            className={`flex-none text-xs ${
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
      {imageError != null && <ErrorNote className="mx-3 mt-2" error={imageError} />}
      {notesQuery.isError && (
        <ErrorNote
          className="mx-3 mb-2"
          error={notesQuery.error}
          onRetry={() => void notesQuery.refetch()}
        />
      )}
      {dropAlert && (
        <div
          role="status"
          className="mx-3 mt-2 flex flex-none items-center gap-2 rounded-lg border border-[var(--status-warn,#d97706)]/40 bg-[var(--status-warn,#d97706)]/10 px-3 py-2 text-xs text-[var(--text-strong)]"
        >
          <span className="min-w-0 flex-1">{t("notes.dropAlert")}</span>
          <button
            type="button"
            className="ca-touch-44 flex-none rounded-md px-2 py-1 font-medium text-[var(--accent-text)] hover:bg-[var(--surface-card-hover)]"
            onClick={() => {
              editor?.commands.undo();
              setDropAlert(false);
            }}
          >
            {t("notes.dropUndo")}
          </button>
          <button
            type="button"
            className="ca-touch-44 flex-none rounded-md px-2 py-1 font-medium text-[var(--accent-text)] hover:bg-[var(--surface-card-hover)]"
            onClick={() => setHistoryOpen(true)}
          >
            {t("notes.viewHistory")}
          </button>
          <button
            type="button"
            aria-label={t("notes.dismissDropAlert")}
            className="ca-touch-44 grid h-6 w-6 flex-none place-items-center rounded-md text-[var(--text-muted)] hover:bg-[var(--surface-card-hover)]"
            onClick={() => setDropAlert(false)}
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
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
        leading={
          <>
            <button
              type="button"
              aria-label={t("notes.takeNote")}
              title={t("notes.takeNoteTitle", { key: keyLabel(takeNoteKey, t) })}
              onClick={() => useNoteCapture.getState().capture(videoId, usePlayer.getState().currentMs)}
              className={panelActionButtonClass}
            >
              <NotebookPen className="h-4 w-4" />
            </button>
            <button
              type="button"
              aria-label={t("notes.history")}
              title={t("notes.history")}
              onClick={() => setHistoryOpen(true)}
              className={panelActionButtonClass}
            >
              <ArchiveRestore className="h-4 w-4" />
            </button>
            <TimestampToggle />
          </>
        }
        onRegenerate={() => void requestGenerate()}
        regenerating={generate.isPending}
        hasContent={Boolean(localDraft ?? notesContent) || hasLocalEdits}
        stale={stale.has("notes")}
        exportItems={
          (notesQuery.isPending || notesQuery.isError) && !localDraft ? [] : exportItems
        }
      />
      <NoteHistoryDialog
        videoId={videoId}
        open={historyOpen}
        onOpenChange={setHistoryOpen}
        onRestore={(content) => {
          // 恢复是一次普通编辑：可以 ⌘Z 撤回，也照常自动保存（覆盖前的内容会再留一份底）。
          editor?.chain().focus().setContent(noteContentToDoc(content)).run();
          setDropAlert(false);
        }}
      />
    </div>
  );
}
