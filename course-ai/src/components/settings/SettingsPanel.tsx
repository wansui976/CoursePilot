import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ChevronLeft, ChevronRight, Terminal } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Modal } from "@/components/ui/dialog";
import { LlmSettingsPanel, type LlmSettingsActions } from "@/components/LlmSettingsPanel";
import { useContainerWidth } from "@/lib/useContainerWidth";
import { CATEGORY_META, SETTINGS_CATEGORIES, type SettingsCategory } from "./categories";
import { Group, StackRow } from "./primitives";
import { useSettingsForm } from "./useSettingsForm";
import { AppearanceSection } from "./sections/AppearanceSection";
import { AsrSection } from "./sections/AsrSection";
import { CoursewareSection } from "./sections/CoursewareSection";
import { ShortcutsSection } from "./sections/ShortcutsSection";
import { StorageSection } from "./sections/StorageSection";
import { StudySection } from "./sections/StudySection";

type PendingSettingsExit =
  | { kind: "category"; category: SettingsCategory | null }
  | { kind: "close" }
  | { kind: "dev-console" }
  | { kind: "external"; continuation: () => void };

/**
 * 设置整页：宽屏左侧分类 + 右侧内容；窄屏「分类列表 → 进入某分类」下钻。
 *
 * 当前分类由宿主通过 `category` / `onCategoryChange` 受控（Home 接到 `/settings/$category`
 * 路由上）；不传时退回组件内部状态，便于单独渲染。`category` 为 null 表示没有进入具体分类：
 * 窄屏显示分类列表，宽屏显示第一个分类。
 *
 * 离开 LLM 分类时若有未保存修改，先弹确认；宿主的跨页动作通过 onRegisterExitRequest
 * 拿到同一道关卡，保证任何出口都不会绕过它。
 */
export function SettingsPanel({
  category: controlledCategory,
  onCategoryChange,
  onClose,
  onOpenDevConsole,
  onRegisterExitRequest,
  onRegisterBackRequest,
}: {
  category?: SettingsCategory | null;
  onCategoryChange?: (category: SettingsCategory | null) => void;
  onClose: () => void;
  onOpenDevConsole?: () => void;
  onRegisterExitRequest?: (
    request: ((continuation: () => void) => void) | null,
  ) => void;
  onRegisterBackRequest?: (request: (() => void) | null) => void;
}) {
  const { t } = useTranslation();
  const form = useSettingsForm();
  const [localCategory, setLocalCategory] = useState<SettingsCategory | null>(null);
  const routeCategory = controlledCategory !== undefined ? controlledCategory : localCategory;
  const setRouteCategory = onCategoryChange ?? setLocalCategory;
  const [llmDirty, setLlmDirty] = useState(false);
  const llmActionsRef = useRef<LlmSettingsActions | null>(null);
  const [pendingExit, setPendingExit] = useState<PendingSettingsExit | null>(null);
  const [resolvingPendingExit, setResolvingPendingExit] = useState(false);
  const registerLlmActions = useCallback((actions: LlmSettingsActions | null) => {
    llmActionsRef.current = actions;
  }, []);
  const externalExitRequestRef = useRef<(continuation: () => void) => void>(
    (continuation) => continuation(),
  );
  const backRequestRef = useRef<() => void>(() => undefined);
  // 设置面板自身随 .ca-app 宽度走窄屏下钻；非宽屏即紧凑。
  const settingsRef = useRef<HTMLDivElement>(null);
  const compact = useContainerWidth(settingsRef) !== "wide";

  const categories = SETTINGS_CATEGORIES.filter(
    (key) => key !== "dev" || onOpenDevConsole,
  );
  const activeCategory =
    routeCategory && categories.includes(routeCategory) ? routeCategory : categories[0];
  // 窄屏下「进入了某分类」才显示详情；宽屏始终显示当前分类。
  const inDetail = compact && routeCategory !== null;
  const shownCategory = compact ? (inDetail ? activeCategory : null) : activeCategory;

  function applySettingsExit(intent: PendingSettingsExit) {
    if (intent.kind === "category") {
      setRouteCategory(intent.category);
      return;
    }
    if (intent.kind === "dev-console") {
      onOpenDevConsole?.();
      return;
    }
    if (intent.kind === "external") {
      intent.continuation();
      return;
    }
    onClose();
  }

  function requestSettingsExit(intent: PendingSettingsExit) {
    if (intent.kind === "category" && intent.category === shownCategory) return;
    if (activeCategory === "llm" && llmDirty) {
      setPendingExit(intent);
      return;
    }
    applySettingsExit(intent);
  }

  externalExitRequestRef.current = (continuation) =>
    requestSettingsExit({ kind: "external", continuation });
  // 系统返回是层级回退：窄屏详情先回分类列表，根层才关闭设置。
  // 两条路径都继续走 requestSettingsExit，因此 LLM 未保存保护不会被绕过。
  backRequestRef.current = () =>
    requestSettingsExit(inDetail ? { kind: "category", category: null } : { kind: "close" });

  useEffect(() => {
    if (!onRegisterExitRequest) return;
    const request = (continuation: () => void) =>
      externalExitRequestRef.current(continuation);
    onRegisterExitRequest(request);
    return () => onRegisterExitRequest(null);
  }, [onRegisterExitRequest]);

  useEffect(() => {
    if (!onRegisterBackRequest) return;
    const request = () => backRequestRef.current();
    onRegisterBackRequest(request);
    return () => onRegisterBackRequest(null);
  }, [onRegisterBackRequest]);

  async function saveAndContinue() {
    const intent = pendingExit;
    const actions = llmActionsRef.current;
    if (!intent || !actions) return;
    setResolvingPendingExit(true);
    const saved = await actions.save();
    setResolvingPendingExit(false);
    if (!saved) return;
    setLlmDirty(false);
    setPendingExit(null);
    applySettingsExit(intent);
  }

  function discardAndContinue() {
    if (!pendingExit) return;
    const intent = pendingExit;
    llmActionsRef.current?.discard();
    setLlmDirty(false);
    setPendingExit(null);
    applySettingsExit(intent);
  }

  // 竖屏下钻时：进入了某分类则顶栏显示该分类名 + 返回到分类列表；否则显示「设置」+ 关闭。
  const headerTitle = inDetail ? t(CATEGORY_META[activeCategory].i18nKey) : t("settings.title");
  const onHeaderBack = () =>
    requestSettingsExit(inDetail ? { kind: "category", category: null } : { kind: "close" });

  return (
    <div
      ref={settingsRef}
      className="relative flex h-full min-h-0 flex-1 flex-col bg-[var(--surface-app)] text-[var(--text-normal)]"
    >
      {/* 头部 */}
      <header className="flex flex-none items-center gap-3 border-b border-[var(--border-subtle)] bg-[var(--surface-header)] px-5 py-3.5">
        <button
          aria-label={t("settings.back")}
          onClick={onHeaderBack}
          className="ca-icon-btn ca-touch-44 ml-0"
        >
          <ChevronLeft className="h-5 w-5" />
        </button>
        <h2 className="ca-t-md font-semibold text-[var(--text-strong)]">{headerTitle}</h2>
      </header>

      {/* 侧栏分类 + 右侧分组卡片；竖屏改为「分类列表 → 下钻」 */}
      <div className="flex min-h-0 flex-1">
        {!compact && (
          <nav
            aria-label={t("settings.category")}
            className="flex w-52 flex-none flex-col gap-0.5 overflow-y-auto border-r border-[var(--border-subtle)] bg-[var(--surface-sidebar)] p-3"
          >
            {categories.map((key) => {
              const meta = CATEGORY_META[key];
              const active = key === activeCategory;
              return (
                <button
                  key={key}
                  onClick={() => requestSettingsExit({ kind: "category", category: key })}
                  aria-current={active ? "page" : undefined}
                  className={`flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left ca-t-sm transition ${
                    active
                      ? "bg-[var(--accent-weak)] font-medium text-[var(--accent-text)]"
                      : "text-[var(--text-normal)] hover:bg-[var(--surface-card-hover)]"
                  }`}
                >
                  <span
                    className="grid h-6 w-6 flex-none place-items-center rounded-[6px] text-white"
                    style={{ background: meta.tint }}
                  >
                    {meta.icon}
                  </span>
                  {t(meta.i18nKey)}
                </button>
              );
            })}
          </nav>
        )}

        {compact && !inDetail ? (
          <nav
            aria-label={t("settings.category")}
            className="min-h-0 flex-1 overflow-y-auto px-4 py-5"
          >
            <div className="mx-auto max-w-2xl divide-y divide-[var(--border-faint)] overflow-hidden rounded-2xl border border-[var(--border-subtle)] bg-[var(--surface-card)]">
              {categories.map((key) => {
                const meta = CATEGORY_META[key];
                return (
                  <button
                    key={key}
                    onClick={() => requestSettingsExit({ kind: "category", category: key })}
                    className="flex min-h-[52px] w-full items-center gap-3 px-4 py-3 text-left transition hover:bg-[var(--surface-card-hover)] active:bg-[var(--surface-card-active)]"
                  >
                    <span
                      className="grid h-7 w-7 flex-none place-items-center rounded-[7px] text-white"
                      style={{ background: meta.tint }}
                    >
                      {meta.icon}
                    </span>
                    <span className="flex-1 ca-t-md text-[var(--text-strong)]">
                      {t(meta.i18nKey)}
                    </span>
                    <ChevronRight className="h-4 w-4 flex-none text-[var(--text-faint)]" />
                  </button>
                );
              })}
            </div>
          </nav>
        ) : (
          <div className={`min-h-0 flex-1 overflow-y-auto ${compact ? "px-4 py-5" : "px-8 py-6"}`}>
            <div className="mx-auto max-w-2xl">
              {!compact && (
                <h2 className="mb-5 ca-t-xl font-semibold tracking-[-0.02em] text-[var(--text-strong)]">
                  {t(CATEGORY_META[activeCategory].i18nKey)}
                </h2>
              )}

              {form.loadError && (
                <div
                  role="alert"
                  className="mb-4 rounded-lg border border-[var(--status-err)] bg-[var(--status-err-bg)] px-3 py-2 text-xs leading-relaxed text-[var(--status-err)]"
                >
                  {t("settings.loadError", { error: form.loadError })}
                </div>
              )}

              {form.saveError && (
                <div
                  role="alert"
                  className="mb-4 rounded-lg border border-[var(--status-err)] bg-[var(--status-err-bg)] px-3 py-2 text-xs leading-relaxed text-[var(--status-err)]"
                >
                  {t("settings.saveError", { error: form.saveError })}
                </div>
              )}

              {activeCategory === "appearance" && <AppearanceSection />}
              {activeCategory === "study" && <StudySection />}
              {activeCategory === "shortcuts" && <ShortcutsSection />}
              {activeCategory === "storage" && <StorageSection form={form} />}
              {activeCategory === "asr" && <AsrSection form={form} />}
              {activeCategory === "llm" && (
                <Group header={t("settings.llm.title")}>
                  <StackRow>
                    <LlmSettingsPanel
                      onDirtyChange={setLlmDirty}
                      onRegisterActions={registerLlmActions}
                    />
                  </StackRow>
                </Group>
              )}
              {activeCategory === "courseware" && <CoursewareSection form={form} />}
              {activeCategory === "dev" && (
                <Group header={t("settings.dev.title")} footnote={t("settings.dev.footnote")}>
                  <StackRow>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => requestSettingsExit({ kind: "dev-console" })}
                    >
                      <Terminal className="h-3.5 w-3.5" />
                      {t("settings.dev.openConsole")}
                    </Button>
                  </StackRow>
                </Group>
              )}
            </div>
          </div>
        )}
      </div>
      <Modal
        open={pendingExit !== null}
        onOpenChange={(open) => {
          if (!open) setPendingExit(null);
        }}
        locked={resolvingPendingExit}
        size="sm"
        title={t("settings.unsavedChangesTitle")}
        titleClassName="text-base"
        description={t("settings.unsavedChangesDescription")}
        descriptionClassName="mt-2 text-sm"
      >
        <div className="mt-5 flex flex-wrap justify-end gap-2">
          <Button
            variant="ghost"
            disabled={resolvingPendingExit}
            onClick={() => setPendingExit(null)}
          >
            {t("settings.keepEditing")}
          </Button>
          <Button
            variant="outline"
            disabled={resolvingPendingExit}
            onClick={discardAndContinue}
            className="text-[var(--status-err)]"
          >
            {t("settings.discardChanges")}
          </Button>
          <Button
            variant="primary"
            disabled={resolvingPendingExit}
            onClick={() => void saveAndContinue()}
          >
            {resolvingPendingExit
              ? t("llmSettings.saving")
              : t("settings.saveAndContinue")}
          </Button>
        </div>
      </Modal>
    </div>
  );
}
