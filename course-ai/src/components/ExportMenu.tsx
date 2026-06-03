import { useState } from "react";
import { Check, ChevronDown, Download } from "lucide-react";
import { Button } from "@/components/ui/button";

export interface ExportItem {
  label: string;
  /** 执行导出，返回落地文件路径（用于反馈）。 */
  run: () => Promise<string>;
}

/**
 * 统一的「导出」按钮：单格式直接导出，多格式弹出下拉；导出后就地给出
 * 「已导出 / 失败」反馈。各面板放在同一位置（标题栏右侧），保证位置一致。
 */
export function ExportMenu({
  items,
  disabled,
}: {
  items: ExportItem[];
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ text: string; error?: boolean } | null>(null);

  if (items.length === 0) return null;
  const single = items.length === 1;

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
      {open && !single && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div className="absolute right-0 top-full z-20 mt-1 w-40 overflow-hidden rounded-md border border-[var(--border-subtle)] bg-[var(--surface-panel)] py-1 shadow-[var(--shadow-pop)]">
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
          className={`absolute right-0 top-full z-30 mt-1 max-w-[260px] truncate rounded-md border border-[var(--border-subtle)] bg-[var(--surface-panel)] px-2 py-1 text-xs shadow-[var(--shadow-pop)] ${
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
