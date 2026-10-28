import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import { Check, ChevronDown, Cpu } from "lucide-react";
import { ipc } from "@/lib/ipc";
import type { LlmProfile } from "@/lib/types";

interface ModelOption {
  profile: LlmProfile;
  hasKey: boolean;
}

interface LoadedModels {
  options: ModelOption[];
  /** 设置里给助手路由的那个（没配路由就是第一个）。用来给「默认」一项标上名字。 */
  defaultId: string | null;
}

async function loadModels(): Promise<LoadedModels> {
  const profiles = await ipc.ai.getProfiles();
  if (profiles.length === 0) return { options: [], defaultId: null };
  const [flags, routingRaw] = await Promise.all([
    Promise.all(profiles.map((p) => ipc.ai.hasApiKey(p.id).catch(() => false))),
    Promise.resolve()
      .then(() => ipc.settings.get("llm_task_routing"))
      .catch(() => null),
  ]);
  let routed: string | null = null;
  try {
    const routing = routingRaw ? (JSON.parse(routingRaw) as Record<string, unknown>) : null;
    if (typeof routing?.assistant === "string") routed = routing.assistant;
  } catch {
    // 路由 JSON 损坏时后端同样退回第一个，这里跟着走。
  }
  const defaultId = profiles.some((p) => p.id === routed) ? routed : (profiles[0]?.id ?? null);
  return {
    options: profiles.map((profile, index) => ({ profile, hasKey: flags[index] === true })),
    defaultId,
  };
}

/**
 * 助手底栏的模型选择：「默认（跟随设置）」加上每一个已配置的模型。
 *
 * 每次展开都重新读一遍配置——用户可能刚在设置里加了模型或填了 Key，
 * 不该要重开面板才看得见。选中的模型被删掉时退回默认，并告诉面板。
 */
export function AssistantModelPicker({
  value,
  onChange,
  onUnavailable,
  disabled,
}: {
  value: string | null;
  onChange: (profileId: string | null) => void;
  /** 记住的模型已不在配置里（被删了）。已经自动改回默认，面板负责告诉用户。 */
  onUnavailable?: () => void;
  disabled?: boolean;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [models, setModels] = useState<LoadedModels | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const menuId = `assistant-model-menu-${useId()}`;
  const refresh = useCallback(async () => {
    try {
      setModels(await loadModels());
    } catch {
      // 读不到配置就只显示「默认模型」，提问时由后端报具体错误。
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (!models || !value) return;
    if (models.options.some((option) => option.profile.id === value)) return;
    onChange(null);
    onUnavailable?.();
  }, [models, value, onChange, onUnavailable]);

  function close(restoreFocus = true) {
    setOpen(false);
    if (restoreFocus) requestAnimationFrame(() => triggerRef.current?.focus());
  }

  useEffect(() => {
    if (!open) return;
    const frame = requestAnimationFrame(() => {
      const items = itemRefs.current.filter(
        (item): item is HTMLButtonElement => !!item && !item.disabled,
      );
      (items.find((item) => item.getAttribute("aria-checked") === "true") ?? items[0])?.focus();
    });
    const onPointerDown = (event: PointerEvent) => {
      if (menuRef.current?.contains(event.target as Node)) return;
      close(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener("pointerdown", onPointerDown);
    };
  }, [open]);

  function handleMenuKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const items = itemRefs.current.filter(
      (item): item is HTMLButtonElement => !!item && !item.disabled,
    );
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      close();
      return;
    }
    if (event.key === "Tab") {
      close(false);
      return;
    }
    if (!items.length) return;
    const current = items.indexOf(document.activeElement as HTMLButtonElement);
    let next: number | null = null;
    if (event.key === "ArrowDown") next = current < 0 ? 0 : (current + 1) % items.length;
    else if (event.key === "ArrowUp") next = current <= 0 ? items.length - 1 : current - 1;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = items.length - 1;
    if (next == null) return;
    event.preventDefault();
    items[next]?.focus();
  }

  const options = models?.options ?? [];
  const defaultName = options.find((o) => o.profile.id === models?.defaultId)?.profile.name;
  const defaultLabel = defaultName
    ? t("assistant.modelDefaultNamed", { name: defaultName })
    : t("assistant.modelDefault");
  const selected = value ? options.find((o) => o.profile.id === value) : undefined;
  const label = selected ? selected.profile.name : defaultLabel;

  const rows: Array<{ id: string | null; label: string; detail?: string; enabled: boolean }> = [
    { id: null, label: defaultLabel, enabled: true },
    ...options.map((option) => ({
      id: option.profile.id,
      label: option.profile.name,
      detail: option.hasKey ? option.profile.model : t("assistant.modelNoKey"),
      enabled: option.hasKey,
    })),
  ];

  return (
    <div ref={menuRef} className="relative min-w-0">
      <button
        ref={triggerRef}
        type="button"
        disabled={disabled}
        aria-label={t("assistant.modelLabel", { model: label })}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        title={t("assistant.modelHint")}
        onClick={() => {
          if (open) {
            close();
          } else {
            setOpen(true);
            void refresh();
          }
        }}
        className="inline-flex max-w-full items-center gap-1 rounded-full bg-[var(--surface-card)] px-1.5 py-0.5 ca-t-2xs text-[var(--text-muted)] transition-colors hover:text-[var(--text-strong)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)] disabled:cursor-not-allowed disabled:opacity-60"
      >
        <Cpu className="h-2.5 w-2.5 flex-none" aria-hidden="true" />
        <span className="truncate">{label}</span>
        <ChevronDown className="h-2.5 w-2.5 flex-none opacity-70" aria-hidden="true" />
      </button>
      {open && (
        <div
          id={menuId}
          role="menu"
          aria-label={t("assistant.modelMenuLabel")}
          onKeyDown={handleMenuKeyDown}
          className="absolute bottom-full right-0 z-20 mb-1 max-h-72 min-w-[200px] max-w-[min(280px,calc(100vw-2rem))] overflow-y-auto rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-panel)] p-1 shadow-[var(--shadow-pop)]"
        >
          {rows.map((row, index) => {
            const active = row.id === (selected ? value : null);
            return (
              <button
                key={row.id ?? "default"}
                ref={(element) => {
                  itemRefs.current[index] = element;
                }}
                type="button"
                role="menuitemradio"
                aria-checked={active}
                tabIndex={-1}
                disabled={!row.enabled}
                onClick={() => {
                  onChange(row.id);
                  close();
                }}
                className="ca-touch-44 flex w-full items-center justify-between gap-2 rounded-md px-2 py-1.5 text-left text-xs text-[var(--text-normal)] transition-colors hover:bg-[var(--surface-card-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--focus-ring)] disabled:cursor-not-allowed disabled:opacity-50"
              >
                <span className="min-w-0">
                  <span className="block truncate">{row.label}</span>
                  {row.detail && (
                    <span className="block truncate ca-t-2xs text-[var(--text-faint)]">
                      {row.detail}
                    </span>
                  )}
                </span>
                {active && <Check className="h-3.5 w-3.5 flex-none text-[var(--accent-text)]" />}
              </button>
            );
          })}
          {models && options.length === 0 && (
            <p className="px-2 py-1.5 ca-t-2xs text-[var(--text-faint)]">
              {t("assistant.modelNone")}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
