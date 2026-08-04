import type { ReactNode } from "react";
import { RefreshCw } from "lucide-react";
import { ExportMenu, type ExportItem } from "./ExportMenu";

/** 面板右下角悬浮的图标操作（重新生成 / 导出）。内容由流水线自动生成，
 *  这些按钮只是给需要手动重跑或导出的用户用，做成纯图标贴边放置，避免抢占内容区。 */
export const panelActionButtonClass =
  "ca-touch-44 ca-workbench-touch grid h-9 w-9 place-items-center rounded-md border border-[var(--border-subtle)] bg-[var(--surface-panel)]/90 text-[var(--text-muted)] shadow-[var(--shadow-raise)] backdrop-blur transition hover:bg-[var(--surface-card-hover)] hover:text-[var(--text-strong)] disabled:cursor-not-allowed disabled:opacity-40";

export function PanelActions({
  onRegenerate,
  regenerating,
  hasContent,
  stale,
  exportItems = [],
  leading,
}: {
  onRegenerate?: () => void;
  regenerating?: boolean;
  hasContent?: boolean;
  /** 这份内容是基于旧讲稿生成的（改过字幕、重跑过纠错、补认了课件文字）。 */
  stale?: boolean;
  exportItems?: ExportItem[];
  leading?: ReactNode;
}) {
  if (!leading && !onRegenerate && exportItems.length === 0) return null;
  return (
    <div className="absolute bottom-3 right-3 z-10 flex items-center gap-1.5">
      {/* 只标记、不自动重跑：重跑要花钱，跑不跑由用户决定。不标出来的话，这份内容
          讲的还是旧稿的事，界面上却看不出任何区别。 */}
      {stale && (
        <span
          className="rounded-md border border-[var(--accent)]/45 bg-[var(--accent)]/15 px-2 py-1 text-[11px] font-medium text-[var(--accent)]"
          title="字幕已更新，这份内容还是照着旧稿生成的。要用新稿重做，点右边的重新生成。"
        >
          已过期
        </span>
      )}
      {leading}
      {exportItems.length > 0 && (
        <ExportMenu items={exportItems} icon placement="up" />
      )}
      {onRegenerate && (
        <button
          type="button"
          onClick={onRegenerate}
          disabled={regenerating}
          aria-label={hasContent ? "重新生成" : "生成"}
          title={
            stale
              ? "字幕已更新：用新稿重新生成"
              : hasContent
                ? "重新生成"
                : "生成"
          }
          className={`${panelActionButtonClass} ${
            stale ? "border-[var(--accent)]/60 text-[var(--accent)]" : ""
          }`}
        >
          <RefreshCw className={`h-4 w-4 ${regenerating ? "animate-spin" : ""}`} />
        </button>
      )}
    </div>
  );
}
