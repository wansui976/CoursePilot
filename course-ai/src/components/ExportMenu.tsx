import { useState } from "react";
import { Check, ChevronDown, Download } from "lucide-react";
import { Button } from "@/components/ui/button";
import { panelActionButtonClass } from "./PanelActions";

export interface ExportItem {
  label: string;
  /** 执行导出，返回落地文件路径（用于反馈）。 */
  run: () => Promise<string>;
}

/**
 * 统一的「导出」按钮：单格式直接导出，多格式弹出下拉；导出后就地给出
 * 「已导出 / 失败」反馈。
 * - `icon`：纯图标形态（贴边的悬浮操作用），不显示文字。
 * - `placement`：下拉与反馈气泡的方向，贴底放置时用 "up" 向上弹出。
 */
export function ExportMenu({
  items,
  disabled,
  icon,
  placement = "down",
}: {
  items: ExportItem[];
  disabled?: boolean;
  icon?: boolean;
  placement?: "up" | "down";
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ text: string; error?: boolean } | null>(null);

  if (items.length === 0) return null;
  const single = items.length === 1;
  const up = placement === "up";
  const popClass = up ? "bottom-full mb-1" : "top-full mt-1";

  async function run(item: ExportItem) {
    setOpen(false);
    setBusy(true);
    try {
      const path = await item.run();
      setMsg({ text: `已导出 · ${shorten(path)}` });
    } catch (error) {
      setMsg({ text: String(error), error: true });
    } finally {
      setBusy(false);
      setTimeout(() => setMsg(null), 4000);
    }
  }

  return (
    <div className="relative">
      {icon ? (
        <button
          type="button"
          disabled={disabled || busy}
          onClick={() => (single ? void run(items[0]) : setOpen((o) => !o))}
          aria-label="导出"
          title="导出到视频数据目录"
          className={panelActionButtonClass}
        >
          <Download className={`h-4 w-4 ${busy ? "animate-pulse" : ""}`} />
        </button>
      ) : (
        <Button
          size="sm"
          variant="outline"
          disabled={disabled || busy}
          onClick={() => (single ? void run(items[0]) : setOpen((o) => !o))}
          title="导出到视频数据目录"
        >
          <Download className="h-3.5 w-3.5" />
          {busy ? "导出中…" : "导出"}
          {!single && <ChevronDown className="h-3 w-3 opacity-70" />}
        </Button>
      )}
      {open && !single && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div
            className={`absolute right-0 z-20 w-40 overflow-hidden rounded-md border border-[var(--border-subtle)] bg-[var(--surface-panel)] py-1 shadow-[var(--shadow-pop)] ${popClass}`}
          >
            {items.map((item) => (
              <button
                key={item.label}
                onClick={() => void run(item)}
                className="block w-full px-3 py-1.5 text-left text-sm text-[var(--text-normal)] hover:bg-[var(--surface-card-hover)]"
              >
                {item.label}
              </button>
            ))}
          </div>
        </>
      )}
      {msg && (
        <div
          className={`absolute right-0 z-30 max-w-[260px] truncate rounded-md border border-[var(--border-subtle)] bg-[var(--surface-panel)] px-2 py-1 text-xs shadow-[var(--shadow-pop)] ${popClass} ${
            msg.error ? "text-red-500" : "text-[var(--status-ok)]"
          }`}
          title={msg.text}
        >
          {msg.error ? (
            msg.text
          ) : (
            <span className="inline-flex items-center gap-1">
              <Check className="h-3 w-3 flex-none" />
              {msg.text}
            </span>
          )}
        </div>
      )}
    </div>
  );
}

function shorten(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] || path;
}
