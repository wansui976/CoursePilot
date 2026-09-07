import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import { AtSign, Check, ChevronDown, Send, Square } from "lucide-react";

/** 提问范围的用户选择。auto 跟随界面当前选中项，其余三档显式覆盖。 */
export type ScopeChoice = "auto" | "video" | "course" | "all";

export interface ScopeOption {
  value: ScopeChoice;
  label: string;
  enabled: boolean;
}

/**
 * 助手的 composer：一条输入框 + 底行的范围 chip 与发送键。
 * 从 AssistantPanel 拆出的受控视图。草稿、发送、取消、范围选择的落点都在面板；
 * 这里只自带范围菜单的展开/外点关闭/键盘导航这些纯 UI 状态。
 */
export function AssistantComposer({
  inputRef,
  input,
  onInput,
  onKeyDown,
  busy,
  stopping,
  actionExecutionBusy,
  onSend,
  onStop,
  scopeLabel,
  scopeOptions,
  scopeChoice,
  onScopeChoice,
}: {
  inputRef: React.RefObject<HTMLTextAreaElement | null>;
  input: string;
  onInput: (value: string) => void;
  /** 面板传来的完整键处理：上下键召回历史问题、Enter 发送 Shift+Enter 换行。 */
  onKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => void;
  busy: boolean;
  stopping: boolean;
  actionExecutionBusy: boolean;
  onSend: () => void;
  onStop: () => void;
  scopeLabel: string;
  scopeOptions: ScopeOption[];
  scopeChoice: ScopeChoice;
  onScopeChoice: (value: ScopeChoice) => void;
}) {
  const { t } = useTranslation();
  const [scopeMenuOpen, setScopeMenuOpen] = useState(false);
  const scopeMenuRef = useRef<HTMLDivElement>(null);
  const scopeTriggerRef = useRef<HTMLButtonElement>(null);
  const scopeItemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const scopeMenuId = `assistant-scope-menu-${useId()}`;

  function closeScopeMenu(restoreFocus = true) {
    setScopeMenuOpen(false);
    if (restoreFocus) {
      requestAnimationFrame(() => scopeTriggerRef.current?.focus());
    }
  }

  function handleScopeMenuKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const items = scopeItemRefs.current.filter(
      (item): item is HTMLButtonElement => !!item && !item.disabled,
    );
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      closeScopeMenu();
      return;
    }
    if (event.key === "Tab") {
      closeScopeMenu(false);
      return;
    }
    if (!items.length) return;
    const current = items.indexOf(document.activeElement as HTMLButtonElement);
    let next: number | null = null;
    if (event.key === "ArrowDown" || event.key === "ArrowRight") {
      next = current < 0 ? 0 : (current + 1) % items.length;
    } else if (event.key === "ArrowUp" || event.key === "ArrowLeft") {
      next = current <= 0 ? items.length - 1 : current - 1;
    } else if (event.key === "Home") {
      next = 0;
    } else if (event.key === "End") {
      next = items.length - 1;
    }
    if (next == null) return;
    event.preventDefault();
    items[next]?.focus();
  }

  // 范围菜单：点菜单外任意处收起。
  useEffect(() => {
    if (!scopeMenuOpen) return;
    const frame = requestAnimationFrame(() => {
      const enabled = scopeItemRefs.current.filter(
        (item): item is HTMLButtonElement => !!item && !item.disabled,
      );
      const selectedIndex = enabled.findIndex(
        (item) => item.getAttribute("aria-checked") === "true",
      );
      (enabled[selectedIndex >= 0 ? selectedIndex : 0] ?? enabled[0])?.focus();
    });
    const onPointerDown = (event: PointerEvent) => {
      if (scopeMenuRef.current?.contains(event.target as Node)) return;
      if (scopeTriggerRef.current?.contains(event.target as Node)) return;
      closeScopeMenu(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener("pointerdown", onPointerDown);
    };
  }, [scopeMenuOpen]);

  return (
    <div className="p-2 pt-1">
      <div className="rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-input)] transition-colors focus-within:border-[var(--border-strong)] motion-reduce:transition-none">
        <textarea
          ref={inputRef}
          aria-label={t("assistant.inputLabel")}
          rows={1}
          value={input}
          placeholder={t("assistant.inputPlaceholder")}
          onChange={(e) => onInput(e.target.value)}
          onKeyDown={onKeyDown}
          className="ca-ask-input block max-h-24 w-full resize-none bg-transparent px-2.5 pb-0 pt-2 text-sm text-[var(--text-strong)] outline-none placeholder:text-[var(--text-faint)]"
        />
        <div className="flex items-end gap-2 px-1.5 pb-1.5 pt-1">
          <div ref={scopeMenuRef} className="relative min-w-0 flex-1">
            <button
              ref={scopeTriggerRef}
              type="button"
              aria-label={t("assistant.scopeLabel", { scope: scopeLabel })}
              aria-haspopup="menu"
              aria-expanded={scopeMenuOpen}
              aria-controls={scopeMenuOpen ? scopeMenuId : undefined}
              title={t("assistant.scopeHint")}
              onClick={() => {
                if (scopeMenuOpen) closeScopeMenu();
                else setScopeMenuOpen(true);
              }}
              className="inline-flex max-w-full items-center gap-1 rounded-full bg-[var(--surface-card)] px-1.5 py-0.5 text-[10px] text-[var(--text-muted)] transition-colors hover:text-[var(--text-strong)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]"
            >
              <AtSign className="h-2.5 w-2.5 flex-none" aria-hidden="true" />
              <span className="truncate">{scopeLabel}</span>
              <ChevronDown className="h-2.5 w-2.5 flex-none opacity-70" aria-hidden="true" />
            </button>
            {scopeMenuOpen && (
              <div
                id={scopeMenuId}
                role="menu"
                aria-label={t("assistant.scopeMenuLabel")}
                onKeyDown={handleScopeMenuKeyDown}
                className="absolute bottom-full left-0 z-20 mb-1 min-w-[180px] rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-panel)] p-1 shadow-[var(--shadow-pop)]"
              >
                {scopeOptions.map((option, index) => {
                  const active = option.value === scopeChoice;
                  return (
                    <button
                      key={option.value}
                      ref={(element) => {
                        scopeItemRefs.current[index] = element;
                      }}
                      type="button"
                      role="menuitemradio"
                      aria-checked={active}
                      tabIndex={-1}
                      disabled={!option.enabled}
                      onClick={() => {
                        onScopeChoice(option.value);
                        closeScopeMenu();
                      }}
                      className="ca-touch-44 flex w-full items-center justify-between gap-2 rounded-md px-2 py-1.5 text-left text-xs text-[var(--text-normal)] transition-colors hover:bg-[var(--surface-card-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--focus-ring)] disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      <span>{option.label}</span>
                      {active && (
                        <Check className="h-3.5 w-3.5 flex-none text-[var(--accent-text)]" />
                      )}
                    </button>
                  );
                })}
              </div>
            )}
          </div>
          {busy ? (
            <button
              type="button"
              aria-label={t("assistant.stopGeneration")}
              title={t("assistant.stopGeneration")}
              disabled={stopping}
              onClick={onStop}
              className="ca-touch-44 grid h-8 w-8 flex-none place-items-center rounded-full border border-[var(--border-subtle)] bg-[var(--surface-panel)] text-[var(--text-strong)] transition-colors hover:border-[var(--border-strong)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)] disabled:cursor-not-allowed disabled:opacity-60 motion-reduce:transition-none"
            >
              <Square className="h-3 w-3 fill-current" aria-hidden="true" />
            </button>
          ) : (
            <button
              type="button"
              aria-label={t("assistant.send")}
              title={t("assistant.sendTitle")}
              disabled={!input.trim() || actionExecutionBusy}
              onClick={onSend}
              className={`ca-touch-44 grid h-8 w-8 flex-none place-items-center rounded-full transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)] motion-reduce:transition-none ${
                input.trim() && !actionExecutionBusy
                  ? "ca-fill-brand text-[var(--on-accent)] hover:opacity-90"
                  : "bg-[var(--surface-card-active)] text-[var(--text-muted)]"
              }`}
            >
              <Send className="h-4 w-4" aria-hidden="true" />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
