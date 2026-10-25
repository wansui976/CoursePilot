import { useQuery } from "@tanstack/react-query";
import { EditorContent, useEditor } from "@tiptap/react";
import { Archive, History, RotateCcw } from "lucide-react";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { ipc, type NoteVersion } from "@/lib/ipc";
import { formatRelativeTime } from "@/lib/time";
import { cn } from "@/lib/utils";
import { Button } from "@/ui/button";
import { Modal } from "@/ui/dialog";
import { ErrorNote } from "@/ui/ErrorNote";
import { TextSkeleton } from "@/ui/skeleton";
import { notesExtensions } from "./extensions";
import { noteContentLength, noteContentToDoc } from "./noteVersionContent";

function versionTime(version: NoteVersion): number {
  return version.edited_at ?? version.captured_at;
}

/** 只读预览：和编辑器同一套节点，图片、待办、代码块都照原样显示。 */
function NotePreview({ content }: { content: string }) {
  const editor = useEditor(
    {
      editable: false,
      extensions: notesExtensions(),
      content: noteContentToDoc(content),
      editorProps: { attributes: { class: "tiptap-notes ca-reading" } },
    },
    [content],
  );
  return <EditorContent editor={editor} />;
}

/**
 * 笔记历史：左边版本列表，右边预览。恢复 = 把这一版交给 onRestore 装回编辑器，
 * 当作一次普通编辑（可撤销，并照常自动保存）。
 */
export function NoteHistoryDialog({
  videoId,
  open,
  onOpenChange,
  onRestore,
}: {
  videoId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onRestore: (content: string) => void;
}) {
  const { t, i18n } = useTranslation();
  const versions = useQuery({
    queryKey: ["note-versions", videoId],
    queryFn: () => ipc.ai.noteVersions(videoId),
    enabled: open,
    // 每次打开都重新读：留底在后台随保存产生。
    gcTime: 0,
    staleTime: 0,
  });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const list = useMemo(() => versions.data ?? [], [versions.data]);
  const selected = list.find((version) => version.id === selectedId) ?? list[0] ?? null;
  const absolute = new Intl.DateTimeFormat(i18n.language, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });

  return (
    <Modal
      open={open}
      onOpenChange={(next) => {
        if (!next) setSelectedId(null);
        onOpenChange(next);
      }}
      size="xl"
      icon={<History className="h-4 w-4 text-[var(--accent-text)]" />}
      title={t("noteHistory.title")}
      description={t("noteHistory.description")}
      className="flex max-h-[min(640px,calc(100dvh-32px))] flex-col"
    >
      {versions.isPending ? (
        <TextSkeleton lines={4} className="mt-3" />
      ) : versions.isError ? (
        <ErrorNote className="mt-3" error={versions.error} onRetry={() => void versions.refetch()} />
      ) : list.length === 0 ? (
        <p className="mt-4 rounded-lg bg-[var(--surface-card)] px-4 py-6 text-center text-sm text-[var(--text-muted)]">
          {t("noteHistory.empty")}
        </p>
      ) : (
        <div className="mt-3 flex min-h-0 flex-1 flex-col gap-3 sm:flex-row">
          <ul
            aria-label={t("noteHistory.listLabel")}
            className="flex max-h-40 flex-none flex-col gap-1 overflow-y-auto sm:max-h-none sm:w-56"
          >
            {list.map((version) => {
              const active = version.id === selected?.id;
              const time = versionTime(version);
              return (
                <li key={version.id}>
                  <button
                    type="button"
                    aria-current={active ? "true" : undefined}
                    onClick={() => setSelectedId(version.id)}
                    title={absolute.format(time)}
                    className={cn(
                      "ca-touch-44 flex w-full flex-col items-start gap-0.5 rounded-lg px-3 py-2 text-left transition-colors",
                      active
                        ? "bg-[var(--accent-weak)] text-[var(--text-strong)]"
                        : "text-[var(--text-normal)] hover:bg-[var(--surface-card-hover)]",
                    )}
                  >
                    <span className="text-sm font-medium">
                      {formatRelativeTime(time, Date.now(), i18n.language)}
                    </span>
                    <span className="flex items-center gap-1.5 text-xs text-[var(--text-muted)]">
                      {version.source === "backup" ? (
                        <>
                          <Archive aria-hidden="true" className="h-3 w-3" />
                          {t("noteHistory.fromBackup")}
                        </>
                      ) : (
                        t("noteHistory.autoSaved")
                      )}
                      <span aria-hidden="true">·</span>
                      {t("noteHistory.length", { count: noteContentLength(version.content) })}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
          {selected && (
            <section
              aria-label={t("noteHistory.previewLabel")}
              className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-card)]"
            >
              <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
                <NotePreview content={selected.content} />
              </div>
              <div className="flex flex-none items-center gap-2 border-t border-[var(--border-faint)] px-3 py-2">
                <span className="min-w-0 flex-1 truncate text-xs text-[var(--text-muted)]">
                  {t("noteHistory.writtenAt", { time: absolute.format(versionTime(selected)) })}
                </span>
                <Button
                  type="button"
                  size="sm"
                  variant="primary"
                  className="gap-1.5"
                  onClick={() => {
                    onRestore(selected.content);
                    setSelectedId(null);
                    onOpenChange(false);
                  }}
                >
                  <RotateCcw className="h-3.5 w-3.5" />
                  {t("noteHistory.restore")}
                </Button>
              </div>
            </section>
          )}
        </div>
      )}
    </Modal>
  );
}
