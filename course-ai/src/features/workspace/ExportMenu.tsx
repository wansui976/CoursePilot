import { useEffect, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Check, ChevronDown, Download, Share2, X } from "lucide-react";
import { Button } from "@/ui/button";
import { humanizeError } from "@/lib/errors";
import { isMobile, shareFile } from "@/lib/mobileFiles";
import { panelActionButtonClass } from "./PanelActions";

export interface ExportItem {
  label: string;
  /** 执行导出，返回落地文件路径（用于反馈）。 */
  run: () => Promise<string>;
  mime?: string;
  saveAs?: string;
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
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ text: string; error?: boolean } | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const messageTimerRef = useRef<number | null>(null);
  const menuId = useId();

  useEffect(() => {
    return () => {
      if (messageTimerRef.current !== null) {
        window.clearTimeout(messageTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    if (!open) return;
    setActiveIndex(0);
    window.requestAnimationFrame(() => itemRefs.current[0]?.focus());
  }, [open]);

  if (items.length === 0) return null;
  const mobile = isMobile();
  const directShare = mobile && items.length === 1;
  const up = placement === "up";
  const popClass = up ? "bottom-full mb-1" : "top-full mt-1";

  function restoreTriggerFocus() {
    window.requestAnimationFrame(() => triggerRef.current?.focus());
  }

  function closeMenu(restoreFocus = false) {
    setOpen(false);
    if (restoreFocus) restoreTriggerFocus();
  }

  function showMessage(next: { text: string; error?: boolean }) {
    setMsg(next);
    if (messageTimerRef.current !== null) {
      window.clearTimeout(messageTimerRef.current);
      messageTimerRef.current = null;
    }
    if (!next.error) {
      messageTimerRef.current = window.setTimeout(() => {
        setMsg(null);
        messageTimerRef.current = null;
      }, 4000);
    }
  }

  async function share(item: ExportItem) {
    closeMenu(true);
    setMsg(null);
    setBusy(true);
    try {
      const sourcePath = await item.run();
      await shareFile(sourcePath, item.mime ?? "application/octet-stream");
      showMessage({ text: t("export.shared", { path: shorten(sourcePath) }) });
    } catch (error) {
      showMessage({ text: humanizeError(error), error: true });
    } finally {
      setBusy(false);
    }
  }

  async function run(item: ExportItem) {
    closeMenu(true);
    setMsg(null);
    setBusy(true);
    try {
      const path = await item.run();
      showMessage({ text: t("export.exported", { path: shorten(path) }) });
    } catch (error) {
      showMessage({ text: humanizeError(error), error: true });
    } finally {
      setBusy(false);
    }
  }

  function onMenuKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    let next = activeIndex;
    if (event.key === "ArrowDown") next = (activeIndex + 1) % items.length;
    else if (event.key === "ArrowUp") next = (activeIndex - 1 + items.length) % items.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = items.length - 1;
    else if (event.key === "Escape") {
      event.preventDefault();
      closeMenu(true);
      return;
    } else if (event.key === "Tab") {
      closeMenu();
      return;
    } else {
      return;
    }
    event.preventDefault();
    setActiveIndex(next);
    itemRefs.current[next]?.focus();
  }

  return (
    <div className="relative">
      {icon ? (
        <button
          ref={triggerRef}
          type="button"
          disabled={disabled || busy}
          onClick={() => {
            if (directShare) {
              void share(items[0]);
              return;
            }
            setOpen((o) => !o);
          }}
          aria-label={directShare ? t("export.exportAndShare") : t("export.exportButton")}
          aria-haspopup={directShare ? undefined : "menu"}
          aria-expanded={directShare ? undefined : open}
          aria-controls={!directShare && open ? menuId : undefined}
          aria-busy={busy}
          title={directShare ? t("export.exportAndShare") : t("export.exportButton")}
          className={panelActionButtonClass}
        >
          {directShare ? (
            <Share2 className={`h-4 w-4 ${busy ? "animate-pulse" : ""}`} />
          ) : (
            <Download className={`h-4 w-4 ${busy ? "animate-pulse" : ""}`} />
          )}
        </button>
      ) : (
        <Button
          ref={triggerRef}
          size="sm"
          variant="outline"
          disabled={disabled || busy}
          onClick={() => {
            if (directShare) {
              void share(items[0]);
              return;
            }
            setOpen((o) => !o);
          }}
          title={directShare ? t("export.exportAndShare") : t("export.exportButton")}
          aria-haspopup={directShare ? undefined : "menu"}
          aria-expanded={directShare ? undefined : open}
          aria-controls={!directShare && open ? menuId : undefined}
          aria-busy={busy}
        >
          {directShare ? (
            <Share2 className="h-3.5 w-3.5" />
          ) : (
            <Download className="h-3.5 w-3.5" />
          )}
          {busy ? (directShare ? t("export.sharing") : t("export.exporting")) : t("export.exportButton")}
          {!directShare && <ChevronDown className="h-3 w-3 opacity-70" />}
        </Button>
      )}
      {open && (
        <>
          <div
            aria-hidden="true"
            className="fixed inset-0 z-10"
            onClick={() => closeMenu(true)}
          />
          <div
            id={menuId}
            role="menu"
            aria-label={t("export.exportButton")}
            onKeyDown={onMenuKeyDown}
            className={`absolute right-0 z-20 w-40 overflow-hidden rounded-md border border-[var(--border-subtle)] bg-[var(--surface-panel)] py-1 shadow-[var(--shadow-pop)] ${popClass}`}
          >
            {items.map((item, index) => (
              <div key={item.label} className="flex items-center">
                <button
                  ref={(element) => {
                    itemRefs.current[index] = element;
                  }}
                  type="button"
                  role="menuitem"
                  tabIndex={index === activeIndex ? 0 : -1}
                  onFocus={() => setActiveIndex(index)}
                  onClick={() => void (mobile ? share(item) : run(item))}
                  className="ca-touch-44 flex-1 px-3 py-1.5 text-left text-sm text-[var(--text-normal)] hover:bg-[var(--surface-card-hover)]"
                >
                  {item.label}
                </button>
              </div>
            ))}
          </div>
        </>
      )}
      {msg && (
        <div
          role={msg.error ? "alert" : "status"}
          aria-live={msg.error ? "assertive" : "polite"}
          aria-atomic="true"
          className={`absolute right-0 z-30 max-w-[min(320px,calc(100vw-1rem))] whitespace-normal break-words rounded-md border border-[var(--border-subtle)] bg-[var(--surface-panel)] px-2 py-1 text-xs shadow-[var(--shadow-pop)] ${popClass} ${
            msg.error ? "text-[var(--status-err)]" : "text-[var(--status-ok)]"
          }`}
          title={msg.text}
        >
          {msg.error ? (
            <span className="flex items-start gap-2">
              <span className="min-w-0 flex-1">{msg.text}</span>
              <button
                type="button"
                aria-label={t("common.close")}
                title={t("common.close")}
                onClick={() => setMsg(null)}
                className="ca-touch-44 -m-2 grid h-8 w-8 flex-none place-items-center rounded-md hover:bg-[var(--status-err-bg)]"
              >
                <X aria-hidden="true" className="h-3.5 w-3.5" />
              </button>
            </span>
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
