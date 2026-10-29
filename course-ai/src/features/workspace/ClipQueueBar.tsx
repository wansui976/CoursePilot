import { useTranslation } from "react-i18next";
import { ListVideo, SkipForward, X } from "lucide-react";
import { useOptionalShell } from "@/app/shell";
import { displayTitle } from "@/lib/videoTitle";
import { formatMs } from "@/lib/time";
import { useClipQueue } from "@/stores/clipQueue";

/**
 * 「依次播放这几段」的进度条：第几段 / 共几段、这一段出自哪里，一个「下一段」一个「结束」。
 * 什么时候去下一段由用户决定——讲解长短不一，自动切容易把正讲到一半的话掐断。
 */
export function ClipQueueBar() {
  const { t } = useTranslation();
  const shell = useOptionalShell();
  const items = useClipQueue((state) => state.items);
  const index = useClipQueue((state) => state.index);
  if (items.length === 0 || !shell) return null;
  const current = items[index];
  const last = index + 1 >= items.length;

  return (
    <div
      role="region"
      aria-label={t("clipQueue.label")}
      className="flex items-center gap-2 border-b border-[var(--border-faint)] bg-[var(--accent-weak)] px-3 py-1.5 text-xs"
    >
      <ListVideo className="h-3.5 w-3.5 flex-none text-[var(--accent-text)]" aria-hidden="true" />
      <span className="flex-none font-medium text-[var(--accent-text)]">
        {t("clipQueue.progress", { index: index + 1, total: items.length })}
      </span>
      <span className="min-w-0 flex-1 truncate text-[var(--text-muted)]">
        {displayTitle(current.videoTitle)} · {formatMs(current.startMs)}
      </span>
      <button
        type="button"
        onClick={() => {
          const next = useClipQueue.getState().next();
          if (next) shell.openVideoAt(next.videoId, next.startMs);
        }}
        className="ca-touch-44 inline-flex flex-none items-center gap-1 rounded-md px-2 py-1 font-medium text-[var(--accent-text)] hover:bg-[var(--accent-weak-2)]"
      >
        <SkipForward className="h-3.5 w-3.5" aria-hidden="true" />
        {last ? t("clipQueue.finish") : t("clipQueue.next")}
      </button>
      {!last && (
        <button
          type="button"
          aria-label={t("clipQueue.stop")}
          title={t("clipQueue.stop")}
          onClick={() => useClipQueue.getState().clear()}
          className="ca-touch-44 grid h-6 w-6 flex-none place-items-center rounded text-[var(--text-muted)] hover:text-[var(--text-strong)]"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      )}
    </div>
  );
}
