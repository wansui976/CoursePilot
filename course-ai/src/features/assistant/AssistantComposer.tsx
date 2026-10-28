import {
  useEffect,
  useId,
  useRef,
  useState,
  type ClipboardEvent,
  type KeyboardEvent,
} from "react";
import { useTranslation } from "react-i18next";
import { AtSign, Check, ChevronDown, ImagePlus, Send, Square, X } from "lucide-react";
import { imageFilesFromClipboard, type AssistantImage } from "@/lib/assistantImages";
import { AssistantModelPicker } from "./AssistantModelPicker";
import { ImageLightbox } from "./ImageLightbox";

/** 提问范围的用户选择。auto 跟随界面当前选中项，其余三档显式覆盖。 */
export type ScopeChoice = "auto" | "video" | "course" | "all";

export interface ScopeOption {
  value: ScopeChoice;
  label: string;
  enabled: boolean;
}

/**
 * 助手的 composer：一条输入框（上方是待发的附图）+ 底行的附图键、范围与模型 chip、发送键。
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
  images,
  onAddImages,
  onRemoveImage,
  modelProfileId,
  onModelChange,
  onModelUnavailable,
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
  /** 待随下一句发出的附图。 */
  images: AssistantImage[];
  /** 粘贴或选了图片文件。压缩、数量上限由面板处理。 */
  onAddImages: (files: File[]) => void;
  onRemoveImage: (id: string) => void;
  modelProfileId: string | null;
  onModelChange: (profileId: string | null) => void;
  onModelUnavailable?: () => void;
}) {
  const { t } = useTranslation();
  const [scopeMenuOpen, setScopeMenuOpen] = useState(false);
  const scopeMenuRef = useRef<HTMLDivElement>(null);
  const scopeTriggerRef = useRef<HTMLButtonElement>(null);
  const scopeItemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const scopeMenuId = `assistant-scope-menu-${useId()}`;
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [previewing, setPreviewing] = useState<number | null>(null);
  const canSend = (!!input.trim() || images.length > 0) && !actionExecutionBusy;

  // 剪贴板里有图片就收下图片；同时带的文字（如从网页复制的图文）照常粘进输入框。
  function handlePaste(event: ClipboardEvent<HTMLTextAreaElement>) {
    const files = imageFilesFromClipboard(event.clipboardData);
    if (files.length === 0) return;
    if (!event.clipboardData.getData("text/plain")) event.preventDefault();
    onAddImages(files);
  }

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
        {images.length > 0 && (
          <div className="flex flex-wrap gap-1.5 px-2 pt-2">
            {images.map((image, index) => (
              <div key={image.id} className="relative">
                <button
                  type="button"
                  aria-label={t("assistant.viewImage", { index: index + 1 })}
                  title={t("assistant.viewImage", { index: index + 1 })}
                  onClick={() => setPreviewing(index)}
                  className="block overflow-hidden rounded-lg border border-[var(--border-subtle)] transition hover:border-[var(--border-strong)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]"
                >
                  <img
                    src={image.dataUrl}
                    alt={t("assistant.attachedImageAlt", { index: index + 1 })}
                    className="h-14 w-14 object-cover"
                  />
                </button>
                <button
                  type="button"
                  aria-label={t("assistant.removeImage", { index: index + 1 })}
                  title={t("assistant.removeImage", { index: index + 1 })}
                  onClick={() => onRemoveImage(image.id)}
                  className="absolute -right-1.5 -top-1.5 grid h-5 w-5 place-items-center rounded-full border border-[var(--border-subtle)] bg-[var(--surface-panel)] text-[var(--text-muted)] shadow-[var(--shadow-raise)] transition-colors hover:text-[var(--text-strong)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]"
                >
                  <X className="h-3 w-3" aria-hidden="true" />
                </button>
              </div>
            ))}
            <ImageLightbox
              images={images.map((image) => image.dataUrl)}
              index={previewing}
              onClose={() => setPreviewing(null)}
            />
          </div>
        )}
        <textarea
          ref={inputRef}
          aria-label={t("assistant.inputLabel")}
          rows={1}
          value={input}
          placeholder={t("assistant.inputPlaceholder")}
          onChange={(e) => onInput(e.target.value)}
          onKeyDown={onKeyDown}
          onPaste={handlePaste}
          className="ca-ask-input block max-h-24 w-full resize-none bg-transparent px-2.5 pb-0 pt-2 text-sm text-[var(--text-strong)] outline-none placeholder:text-[var(--text-faint)]"
        />
        <div className="flex items-end gap-2 px-1.5 pb-1.5 pt-1">
          <button
            type="button"
            aria-label={t("assistant.attachImage")}
            title={t("assistant.attachImageHint")}
            onClick={() => fileInputRef.current?.click()}
            className="ca-touch-44 grid h-5 w-5 flex-none place-items-center rounded-full text-[var(--text-muted)] transition-colors hover:text-[var(--text-strong)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]"
          >
            <ImagePlus className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/png,image/jpeg,image/webp,image/gif"
            multiple
            hidden
            data-testid="assistant-image-input"
            onChange={(event) => {
              const files = Array.from(event.target.files ?? []);
              // 清掉值，否则同一张图删掉后再选一次不会触发 change。
              event.target.value = "";
              if (files.length) onAddImages(files);
            }}
          />
          <div className="flex min-w-0 flex-1 items-end gap-1">
            <div ref={scopeMenuRef} className="relative min-w-0 flex-shrink">
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
                className="inline-flex max-w-full items-center gap-1 rounded-full bg-[var(--surface-card)] px-1.5 py-0.5 ca-t-2xs text-[var(--text-muted)] transition-colors hover:text-[var(--text-strong)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]"
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
            <AssistantModelPicker
              value={modelProfileId}
              onChange={onModelChange}
              onUnavailable={onModelUnavailable}
            />
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
              disabled={!canSend}
              onClick={onSend}
              className={`ca-touch-44 grid h-8 w-8 flex-none place-items-center rounded-full transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)] motion-reduce:transition-none ${
                canSend
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
