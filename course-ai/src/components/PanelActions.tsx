import { RefreshCw } from "lucide-react";
import { ExportMenu, type ExportItem } from "./ExportMenu";

/** 面板右下角悬浮的图标操作（重新生成 / 导出）。内容由流水线自动生成，
 *  这些按钮只是给需要手动重跑或导出的用户用，做成纯图标贴边放置，避免抢占内容区。 */
export const panelActionButtonClass =
  "ca-touch-44 grid h-8 w-8 place-items-center rounded-md border border-[var(--border-subtle)] bg-[var(--surface-panel)]/90 text-[var(--text-muted)] shadow-sm backdrop-blur transition hover:bg-[var(--surface-card-hover)] hover:text-[var(--text-strong)] disabled:cursor-not-allowed disabled:opacity-40";

export function PanelActions({
  onRegenerate,
  regenerating,
  hasContent,
  exportItems = [],
}: {
  onRegenerate?: () => void;
  regenerating?: boolean;
  hasContent?: boolean;
  exportItems?: ExportItem[];
}) {
  if (!onRegenerate && exportItems.length === 0) return null;
  return (
    <div className="absolute bottom-3 right-3 z-10 flex items-center gap-1.5">
      {exportItems.length > 0 && (
        <ExportMenu items={exportItems} icon placement="up" />
      )}
      {onRegenerate && (
        <button
          type="button"
          onClick={onRegenerate}
          disabled={regenerating}
          aria-label={hasContent ? "重新生成" : "生成"}
          title={hasContent ? "重新生成" : "生成"}
          className={panelActionButtonClass}
        >
          <RefreshCw className={`h-4 w-4 ${regenerating ? "animate-spin" : ""}`} />
        </button>
      )}
    </div>
  );
}
