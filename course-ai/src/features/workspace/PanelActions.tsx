import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { RefreshCw } from "lucide-react";
import { Button } from "@/ui/button";
import { ExportMenu, type ExportItem } from "./ExportMenu";

/** 面板右下角悬浮的图标操作（重新生成 / 导出）。内容由流水线自动生成，
 *  这些按钮只是给需要手动重跑或导出的用户用，做成纯图标贴边放置，避免抢占内容区。
 *  按钮本身不带边框和阴影：一组按钮共用外面那一个磨砂底（.ca-workbench-panel-actions），
 *  不再是一排各自描边、各自投影的小方块。 */
export const panelActionButtonClass =
  "ca-touch-44 ca-workbench-touch grid h-8 w-8 place-items-center rounded-md text-[var(--text-muted)] transition hover:bg-[var(--surface-card-hover)] hover:text-[var(--text-strong)] disabled:cursor-not-allowed disabled:opacity-40";

/** 标题条里的同款按钮：不带浮起的边框与阴影，只是一个安静的图标。 */
const inlineActionButtonClass =
  "ca-touch-44 grid h-7 w-7 place-items-center rounded-md text-[var(--text-faint)] transition hover:bg-[var(--surface-card-hover)] hover:text-[var(--text-strong)] disabled:cursor-not-allowed disabled:opacity-40";

export function PanelActions({
  onRegenerate,
  regenerating,
  hasContent,
  exportItems = [],
  leading,
  inline = false,
}: {
  onRegenerate?: () => void;
  regenerating?: boolean;
  hasContent?: boolean;
  exportItems?: ExportItem[];
  leading?: ReactNode;
  /** 放进分区标题条（与标题同一行），不再悬浮盖在可滚动的正文上。 */
  inline?: boolean;
}) {
  const { t } = useTranslation();
  if (!leading && !onRegenerate && exportItems.length === 0) return null;
  return (
    <div
      className={
        inline
          ? "ml-auto flex flex-none items-center gap-1"
          : "ca-workbench-panel-actions absolute bottom-3 right-3 z-10 flex items-center gap-0.5 rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-panel)]/90 p-0.5 shadow-[var(--shadow-raise)] backdrop-blur"
      }
    >
      {leading}
      {exportItems.length > 0 && (
        <ExportMenu items={exportItems} icon placement="up" />
      )}
      {onRegenerate && (
        <button
          type="button"
          onClick={onRegenerate}
          disabled={regenerating}
          aria-label={hasContent ? t("panelActions.regenerate") : t("panelActions.generate")}
          title={hasContent ? t("panelActions.regenerate") : t("panelActions.generate")}
          className={inline ? inlineActionButtonClass : panelActionButtonClass}
        >
          <RefreshCw className={`h-4 w-4 ${regenerating ? "animate-spin" : ""}`} />
        </button>
      )}
    </div>
  );
}

/** 空态里的「生成」按钮：与笔记空态同款，不再让用户去角落里找图标按钮。 */
export function GenerateEmptyAction({
  onGenerate,
  generating,
}: {
  onGenerate: () => void;
  generating?: boolean;
}) {
  const { t } = useTranslation();
  return (
    <Button
      type="button"
      variant="primary"
      size="sm"
      onClick={onGenerate}
      disabled={generating}
      className="ca-touch-44 gap-1.5"
    >
      {generating ? t("panelActions.generating") : t("panelActions.generateWithAi")}
    </Button>
  );
}
