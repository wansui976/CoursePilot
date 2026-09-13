import { useCallback, useEffect, useRef, useState, type ChangeEvent, type CSSProperties, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import {
  AudioLines,
  Bell,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  FolderCog,
  Keyboard,
  Palette,
  ScanText,
  Sparkles,
  Terminal,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { useContainerWidth } from "@/lib/useContainerWidth";
import { ipc } from "@/lib/ipc";
import { ACCENTS, useTheme, type ThemePref } from "@/stores/theme";
import {
  SHORTCUT_ACTIONS,
  keyLabel,
  useShortcuts,
  type ShortcutAction,
} from "@/stores/shortcuts";
import {
  AUTO_SENSITIVITY,
  DEFAULT_SLIDES_SENSITIVITY,
  getSlidesSensitivity,
  setSlidesSensitivity,
  type SlidesSensitivity,
} from "@/lib/slides";
import { defaultAsrBackend, normalizeAsrBackend } from "@/lib/asrDefaults";
import { defaultOcrBackend, normalizeOcrBackend } from "@/lib/ocrDefaults";
import { changeLanguage } from "@/i18n";
import { isMobile } from "@/lib/platform";
import { readReminderEnabled, writeReminderEnabled } from "@/lib/studyReminder";
import { pickDirectoryPath } from "@/lib/mobileFiles";
import { createSettingsWriter } from "@/lib/settingsWriteQueue";
import { Switch } from "@/components/ui/switch";
import { WhisperModelsPanel } from "./WhisperModelsPanel";
import {
  LlmSettingsPanel,
  type LlmSettingsActions,
} from "./LlmSettingsPanel";
import { DatabaseBackupAction } from "./DatabaseBackupAction";

const FIELD =
  "w-full rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-input)] px-3 py-2 text-sm text-[var(--text-strong)] outline-none transition placeholder:text-[var(--text-faint)]";

/** 统一外观的下拉框：去掉原生箭头，加自定义 chevron，和输入框风格一致。 */
function Select({
  id,
  value,
  onChange,
  children,
}: {
  id?: string;
  value: string;
  onChange: (event: ChangeEvent<HTMLSelectElement>) => void;
  children: ReactNode;
}) {
  return (
    <div className="relative">
      <select
        id={id}
        value={value}
        onChange={onChange}
        className={`${FIELD} cursor-pointer appearance-none pr-9`}
      >
        {children}
      </select>
      <ChevronDown className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--text-muted)]" />
    </div>
  );
}

type SettingsCategory =
  | "appearance"
  | "study"
  | "shortcuts"
  | "storage"
  | "asr"
  | "llm"
  | "courseware"
  | "dev";

type PendingSettingsExit =
  | { kind: "category"; category: SettingsCategory }
  | { kind: "category-list" }
  | { kind: "close" }
  | { kind: "dev-console" }
  | { kind: "external"; continuation: () => void };

const CATEGORY_META: Record<
  SettingsCategory,
  { i18nKey: string; icon: ReactNode; tint: string }
> = {
  appearance: { i18nKey: "settings.categories.appearance", icon: <Palette className="h-3.5 w-3.5" />, tint: "#e0568f" },
  study: { i18nKey: "settings.categories.study", icon: <Bell className="h-3.5 w-3.5" />, tint: "#0ea5e9" },
  shortcuts: { i18nKey: "settings.categories.shortcuts", icon: <Keyboard className="h-3.5 w-3.5" />, tint: "#10b981" },
  storage: { i18nKey: "settings.categories.storage", icon: <FolderCog className="h-3.5 w-3.5" />, tint: "#8e8e93" },
  asr: { i18nKey: "settings.categories.asr", icon: <AudioLines className="h-3.5 w-3.5" />, tint: "#2f6cea" },
  llm: { i18nKey: "settings.categories.llm", icon: <Sparkles className="h-3.5 w-3.5" />, tint: "#a855f7" },
  courseware: { i18nKey: "settings.categories.courseware", icon: <ScanText className="h-3.5 w-3.5" />, tint: "#f59e0b" },
  dev: { i18nKey: "settings.categories.dev", icon: <Terminal className="h-3.5 w-3.5" />, tint: "#64748b" },
};

const THEME_OPTIONS: { key: ThemePref; i18nKey: string }[] = [
  { key: "light", i18nKey: "settings.theme.light" },
  { key: "dark", i18nKey: "settings.theme.dark" },
  { key: "auto", i18nKey: "settings.theme.auto" },
];

/** 外观主题的小缩略图（仿一个迷你窗口）。auto 用左浅右深的斜分。 */
function ThemeMock({ pref }: { pref: ThemePref }) {
  const light = { bg: "#e9eaf0", bar: "#f7f8fa", win: "#ffffff", line: "#d7dae2" };
  const dark = { bg: "#1b1e25", bar: "#23262e", win: "#2c2f38", line: "#3a3e48" };
  if (pref === "auto") {
    return (
      <span className="relative block h-full w-full overflow-hidden">
        <span className="absolute inset-0" style={{ background: light.bg }} />
        <span
          className="absolute inset-0"
          style={{ clipPath: "polygon(100% 0, 0 100%, 100% 100%)", background: dark.bg }}
        />
        <span
          className="absolute left-1.5 top-1.5 h-1.5 w-7 rounded-full"
          style={{ background: "var(--accent, #2f6cea)" }}
        />
      </span>
    );
  }
  const c = pref === "dark" ? dark : light;
  return (
    <span className="relative block h-full w-full" style={{ background: c.bg }}>
      <span className="absolute left-1.5 top-1.5 h-1.5 w-7 rounded-full" style={{ background: "var(--accent, #2f6cea)" }} />
      <span
        className="absolute bottom-1.5 left-1.5 right-1.5 top-4 rounded-[3px]"
        style={{ background: c.win, boxShadow: `inset 0 0 0 1px ${c.line}` }}
      />
    </span>
  );
}

/** 苹果系统设置风格的分组卡片：小标题 + 圆角卡片（行间细分隔线）+ 脚注。 */
function Group({
  header,
  footnote,
  children,
}: {
  header?: string;
  footnote?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="mb-7">
      {header && (
        <h3 className="mb-2 px-4 ca-t-sm font-semibold text-[var(--text-muted)]">
          {header}
        </h3>
      )}
      <div className="divide-y divide-[var(--border-faint)] overflow-hidden rounded-2xl border border-[var(--border-subtle)] bg-[var(--surface-card)]">
        {children}
      </div>
      {footnote && (
        <p className="mt-2 px-4 text-xs leading-relaxed text-[var(--text-muted)]">{footnote}</p>
      )}
    </div>
  );
}

/** 一行设置：标签在左、控件在右（紧凑）。hint 作为标签下的小字说明。 */
function Row({
  label,
  hint,
  htmlFor,
  children,
}: {
  label: string;
  hint?: ReactNode;
  htmlFor?: string;
  children: ReactNode;
}) {
  return (
    <div className="flex min-h-[44px] flex-col gap-1.5 px-4 py-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
      <div className="min-w-0">
        <label
          htmlFor={htmlFor}
          className="block text-sm font-medium tracking-[-0.01em] text-[var(--text-strong)]"
        >
          {label}
        </label>
        {hint && <p className="mt-0.5 text-xs leading-relaxed text-[var(--text-muted)]">{hint}</p>}
      </div>
      <div className="w-full sm:w-auto sm:flex-none">{children}</div>
    </div>
  );
}

/** 整行铺开的设置（控件较宽或多行时用）：标签在上、控件占满整行。 */
function StackRow({
  label,
  hint,
  htmlFor,
  children,
}: {
  label?: string;
  hint?: ReactNode;
  htmlFor?: string;
  children: ReactNode;
}) {
  return (
    <div className="px-4 py-3.5">
      {label && (
        <label
          htmlFor={htmlFor}
          className="block text-sm font-medium tracking-[-0.01em] text-[var(--text-strong)]"
        >
          {label}
        </label>
      )}
      {hint && <p className="mt-0.5 text-xs leading-relaxed text-[var(--text-muted)]">{hint}</p>}
      <div className={label || hint ? "mt-2" : ""}>{children}</div>
    </div>
  );
}

function SavedBadge({ text, isError = false }: { text: string; isError?: boolean }) {
  if (!text) return null;
  return (
    <span
      role={isError ? "alert" : "status"}
      aria-live={isError ? "assertive" : "polite"}
      aria-atomic="true"
      className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ${
        isError
          ? "bg-[var(--status-err-bg)] text-[var(--status-err)]"
          : "bg-[var(--status-ok-bg)] text-[var(--status-ok)]"
      }`}
    >
      {isError ? <X className="h-3 w-3" /> : <Check className="h-3 w-3" />}
      {text}
    </span>
  );
}

/** 查询某项凭证「是否已配置」（只回布尔、不回读明文），供密钥字段旁显示「已配置」。
 *  refresh() 在保存成功后调用，把状态刷新为最新。 */
function useSecretConfigured(name: string) {
  const [configured, setConfigured] = useState(false);
  const refresh = useCallback(() => {
    ipc.secrets
      .has(name)
      .then(setConfigured)
      .catch(() => {});
  }, [name]);
  useEffect(() => {
    refresh();
  }, [refresh]);
  return { configured, refresh };
}

export function SettingsPanel({
  onClose,
  onOpenDevConsole,
  onRegisterExitRequest,
  onRegisterBackRequest,
}: {
  onClose: () => void;
  onOpenDevConsole?: () => void;
  onRegisterExitRequest?: (
    request: ((continuation: () => void) => void) | null,
  ) => void;
  onRegisterBackRequest?: (request: (() => void) | null) => void;
}) {
  const { t, i18n } = useTranslation();
  const mobile = isMobile();
  const [activeCategory, setActiveCategory] = useState<SettingsCategory>("appearance");
  const [llmDirty, setLlmDirty] = useState(false);
  const llmActionsRef = useRef<LlmSettingsActions | null>(null);
  const [pendingExit, setPendingExit] = useState<PendingSettingsExit | null>(null);
  const [resolvingPendingExit, setResolvingPendingExit] = useState(false);
  const resolvingPendingExitRef = useRef(false);
  resolvingPendingExitRef.current = resolvingPendingExit;
  const pendingDialogRef = useRef<HTMLDivElement>(null);
  const registerLlmActions = useCallback((actions: LlmSettingsActions | null) => {
    llmActionsRef.current = actions;
  }, []);
  const externalExitRequestRef = useRef<(continuation: () => void) => void>(
    (continuation) => continuation(),
  );
  const backRequestRef = useRef<() => void>(() => undefined);
  // 竖屏（手机 / 平板竖屏）：取消左侧分类栏，改成「分类列表 → 进入某分类」的下钻，
  // 顶部左上角放返回按钮 + 当前层级标题。entered=false 显示分类列表，true 显示该分类详情。
  // 设置面板自身随 .ca-app 宽度走窄屏下钻；非宽屏即紧凑。
  const settingsRef = useRef<HTMLDivElement>(null);
  const compact = useContainerWidth(settingsRef) !== "wide";
  // 密钥字段是否已配置：保存后清空输入框，靠这个在字段旁回显「已配置」，
  // 让用户知道当前确实存了凭证（不回读明文）。
  const volcSecret = useSecretConfigured("volcengine_asr_access_token");
  const dashSecret = useSecretConfigured("dashscope_api_key");
  const ocrSecret2 = useSecretConfigured("aliyun_ocr_access_key_secret");
  const deepseekSecret = useSecretConfigured("deepseek_ocr_api_key");
  const [entered, setEntered] = useState(false);
  const themePref = useTheme((s) => s.pref);
  const setThemePref = useTheme((s) => s.setPref);
  const accent = useTheme((s) => s.accent);
  const customAccent = useTheme((s) => s.customAccent);
  const setAccent = useTheme((s) => s.setAccent);
  const setCustomAccent = useTheme((s) => s.setCustomAccent);
  const bindings = useShortcuts((s) => s.bindings);
  const setBinding = useShortcuts((s) => s.setBinding);
  const resetBindings = useShortcuts((s) => s.resetBindings);
  // 正在为哪个动作录入新按键（null = 不在录入）。录入时下一次按键即写入；Esc 取消。
  const [capturing, setCapturing] = useState<ShortcutAction | null>(null);
  // 学习提醒开关（本地存储）：开启时立刻发一条确认通知，顺带触发系统权限询问。
  const [remindOn, setRemindOn] = useState(() => readReminderEnabled());
  async function toggleReminder(on: boolean) {
    writeReminderEnabled(on);
    setRemindOn(on);
    if (!on) return;
    try {
      await ipc.notify(t("settings.studyReminder.enabled"), t("settings.studyReminder.enabledBody"));
    } catch {
      // 权限被拒 / 发送失败时静默：开关状态仍已保存。
    }
  }

  useEffect(() => {
    if (!capturing) return;
    const onKey = (event: KeyboardEvent) => {
      event.preventDefault();
      event.stopPropagation();
      if (event.key === "Escape") {
        setCapturing(null);
        return;
      }
      // 单按修饰键不作为快捷键。
      if (["Shift", "Control", "Alt", "Meta"].includes(event.key)) return;
      setBinding(capturing, event.key);
      setCapturing(null);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [capturing, setBinding]);

  useEffect(() => {
    if (!pendingExit) return;
    const dialog = pendingDialogRef.current;
    const previousFocus = document.activeElement as HTMLElement | null;
    const focusable = () =>
      [...(dialog?.querySelectorAll<HTMLElement>("button:not(:disabled)") ?? [])];
    focusable()[0]?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !resolvingPendingExitRef.current) {
        event.preventDefault();
        setPendingExit(null);
        return;
      }
      if (event.key !== "Tab") return;
      const items = focusable();
      if (items.length === 0) return;
      const first = items[0];
      const last = items[items.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    dialog?.addEventListener("keydown", onKeyDown);
    return () => {
      dialog?.removeEventListener("keydown", onKeyDown);
      previousFocus?.focus();
    };
  }, [pendingExit]);
  const [root, setRoot] = useState("");
  const [model, setModel] = useState("large-v3-turbo");
  const [asrBackend, setAsrBackend] = useState(defaultAsrBackend());
  const [asrLanguage, setAsrLanguage] = useState("zh");
  const [correctionConcurrency, setCorrectionConcurrency] = useState("8");
  const [subtitleAutocorrect, setSubtitleAutocorrect] = useState(true);
  const [slidesAutoExtract, setSlidesAutoExtract] = useState(true);
  const [volcengineAppId, setVolcengineAppId] = useState("");
  const [volcengineToken, setVolcengineToken] = useState("");
  const [volcengineSaved, setVolcengineSaved] = useState("");
  const [volcengineSavedErr, setVolcengineSavedErr] = useState(false);
  const [volcengineHotwords, setVolcengineHotwords] = useState("");
  const [volcengineContext, setVolcengineContext] = useState("");
  const [volcengineCtxSaved, setVolcengineCtxSaved] = useState("");
  const [volcengineCtxSavedErr, setVolcengineCtxSavedErr] = useState(false);
  const [dashscopeKey, setDashscopeKey] = useState("");
  const [dashscopeSaved, setDashscopeSaved] = useState("");
  const [dashscopeSavedErr, setDashscopeSavedErr] = useState(false);
  const [aliyunModel, setAliyunModel] = useState("qwen3-asr-flash-filetrans");
  const [ocrBackend, setOcrBackend] = useState(defaultOcrBackend());
  const [ocrType, setOcrType] = useState("Advanced");
  const [ocrKeyId, setOcrKeyId] = useState("");
  const [ocrSecret, setOcrSecret] = useState("");
  const [ocrSaved, setOcrSaved] = useState("");
  const [ocrSavedErr, setOcrSavedErr] = useState(false);
  const [deepseekModel, setDeepseekModel] = useState("deepseek-v4-flash-vision-exp");
  const [deepseekBaseUrl, setDeepseekBaseUrl] = useState("https://api.deepseek.com");
  const [deepseekKey, setDeepseekKey] = useState("");
  const [deepseekSaved, setDeepseekSaved] = useState("");
  const [deepseekSavedErr, setDeepseekSavedErr] = useState(false);
  const [slidesSensitivity, setSlidesSensitivityState] = useState(() =>
    getSlidesSensitivity(),
  );
  const slidesAuto = slidesSensitivity === AUTO_SENSITIVITY;
  // 关掉「自动」时回到手调档位；滑块本身只在手调模式下可用。
  const slidesSliderValue = slidesAuto ? DEFAULT_SLIDES_SENSITIVITY : slidesSensitivity;
  const changeSlidesSensitivity = (value: SlidesSensitivity) => {
    setSlidesSensitivityState(value);
    setSlidesSensitivity(value);
  };
  // 同一个 key 的即时写入必须按触发顺序落库；否则快速切换时，较慢的旧请求可能最后覆盖新值。
  const settingsWriterRef = useRef<ReturnType<typeof createSettingsWriter> | null>(null);
  if (!settingsWriterRef.current) {
    settingsWriterRef.current = createSettingsWriter(ipc.settings.set);
  }
  const latestSaveByKeyRef = useRef(new Map<string, number>());
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveErrors, setSaveErrors] = useState<Record<string, string>>({});
  const saveError = Object.values(saveErrors)[0] ?? null;
  const saveSetting = useCallback(async (key: string, value: string) => {
    const requestId = (latestSaveByKeyRef.current.get(key) ?? 0) + 1;
    latestSaveByKeyRef.current.set(key, requestId);
    try {
      await settingsWriterRef.current!(key, value);
      if (requestId !== latestSaveByKeyRef.current.get(key)) return;
      setSaveErrors((current) => {
        if (!(key in current)) return current;
        const next = { ...current };
        delete next[key];
        return next;
      });
    } catch (error) {
      if (requestId !== latestSaveByKeyRef.current.get(key)) return;
      setSaveErrors((current) => ({ ...current, [key]: String(error) }));
    }
  }, []);
  // 凭证保存进行中：禁用保存按钮防连点。
  const [savingCred, setSavingCred] = useState<"volc" | "ctx" | "dash" | "ocr" | "deepseek" | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = async (key: string, apply: (value: string | null) => void) => {
      const value = await ipc.settings.get(key);
      if (!cancelled) apply(value);
    };
    const requests = [
      load("default_storage_root", (value) => setRoot(value ?? "")),
      load("whisper_model", (value) => setModel(value ?? "large-v3-turbo")),
      load("asr_backend", (value) => setAsrBackend(normalizeAsrBackend(value))),
      load("asr_language", (value) => setAsrLanguage(value ?? "zh")),
      load("asr_correction_concurrency", (value) => setCorrectionConcurrency(value ?? "8")),
      load("subtitle_autocorrect", (value) => setSubtitleAutocorrect(value !== "false")),
      load("slides_auto_extract", (value) => setSlidesAutoExtract(value !== "off")),
      load("volcengine_asr_app_id", (value) => setVolcengineAppId(value ?? "")),
      load("volcengine_asr_hotwords", (value) => setVolcengineHotwords(value ?? "")),
      load("volcengine_asr_context", (value) => setVolcengineContext(value ?? "")),
      load("aliyun_asr_model", (value) =>
        setAliyunModel(value ?? "qwen3-asr-flash-filetrans"),
      ),
      load("ocr_backend", (value) => setOcrBackend(normalizeOcrBackend(value))),
      load("aliyun_ocr_type", (value) => setOcrType(value ?? "Advanced")),
      load("aliyun_ocr_access_key_id", (value) => setOcrKeyId(value ?? "")),
      load("deepseek_ocr_model", (value) =>
        setDeepseekModel(value ?? "deepseek-v4-flash-vision-exp"),
      ),
      load("deepseek_ocr_base_url", (value) =>
        setDeepseekBaseUrl(value ?? "https://api.deepseek.com"),
      ),
    ];
    void Promise.allSettled(requests).then((results) => {
      if (cancelled) return;
      const failed = results.find((result) => result.status === "rejected");
      setLoadError(failed?.status === "rejected" ? String(failed.reason) : null);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  async function pickRoot() {
    const dir = await pickDirectoryPath(["storage"]);
    if (typeof dir === "string") {
      setRoot(dir);
      await saveSetting("default_storage_root", dir);
    }
  }

  // 「留空 = 跟视频同目录」是文档承诺，必须给清空手段。
  async function clearRoot() {
    setRoot("");
    await saveSetting("default_storage_root", "");
  }

  async function changeModel(value: string) {
    setModel(value);
    await saveSetting("whisper_model", value);
  }

  async function changeAsrBackend(value: string) {
    const next = normalizeAsrBackend(value);
    setAsrBackend(next);
    await saveSetting("asr_backend", next);
  }

  async function changeAsrLanguage(value: string) {
    setAsrLanguage(value);
    await saveSetting("asr_language", value);
  }

  async function changeCorrectionConcurrency(value: string) {
    setCorrectionConcurrency(value);
    const n = Number(value);
    if (Number.isFinite(n) && n >= 1) {
      await saveSetting("asr_correction_concurrency", String(Math.min(2500, Math.floor(n))));
    }
  }

  // 失焦时把非法值（0/空/超限）夹回有效区间并落库，不留「显示 0 实存 8」的脱节。
  async function normalizeCorrectionConcurrency() {
    const n = Number(correctionConcurrency);
    const next = Number.isFinite(n)
      ? String(Math.min(2500, Math.max(1, Math.floor(n))))
      : "8";
    setCorrectionConcurrency(next);
    await saveSetting("asr_correction_concurrency", next);
  }

  async function changeSubtitleAutocorrect(value: boolean) {
    setSubtitleAutocorrect(value);
    await saveSetting("subtitle_autocorrect", value ? "true" : "false");
  }

  async function changeSlidesAutoExtract(value: boolean) {
    setSlidesAutoExtract(value);
    await saveSetting("slides_auto_extract", value ? "on" : "off");
  }

  async function saveVolcengineKey() {
    const appId = volcengineAppId.trim();
    const token = volcengineToken.trim();
    if (!appId && !token) return;
    setVolcengineSaved("");
    setVolcengineSavedErr(false);
    setSavingCred("volc");
    try {
      if (appId) await ipc.settings.set("volcengine_asr_app_id", appId);
      if (token) await ipc.secrets.set("volcengine_asr_access_token", token);
      if (token) {
        volcSecret.refresh();
        setVolcengineToken("");
      }
      setVolcengineSaved(t("settings.saved"));
      setVolcengineSavedErr(false);
    } catch (error) {
      // 不再无声失败：把后端写入错误直接显示出来，便于定位（例如 DB 不可写）。
      setVolcengineSaved(t("settings.saveFailed", { error }));
      setVolcengineSavedErr(true);
    } finally {
      setSavingCred(null);
    }
  }

  async function saveVolcengineContext() {
    setVolcengineCtxSaved("");
    setVolcengineCtxSavedErr(false);
    setSavingCred("ctx");
    try {
      await ipc.settings.set("volcengine_asr_hotwords", volcengineHotwords.trim());
      await ipc.settings.set("volcengine_asr_context", volcengineContext.trim());
      setVolcengineCtxSaved(t("settings.saved"));
      setVolcengineCtxSavedErr(false);
    } catch (error) {
      setVolcengineCtxSaved(t("settings.saveFailed", { error }));
      setVolcengineCtxSavedErr(true);
    } finally {
      setSavingCred(null);
    }
  }

  async function changeAliyunModel(value: string) {
    setAliyunModel(value);
    await saveSetting("aliyun_asr_model", value);
  }

  async function saveDashscopeKey() {
    if (!dashscopeKey.trim()) return;
    setDashscopeSaved("");
    setDashscopeSavedErr(false);
    setSavingCred("dash");
    try {
      await ipc.secrets.set("dashscope_api_key", dashscopeKey.trim());
      dashSecret.refresh();
      setDashscopeKey("");
      setDashscopeSaved(t("settings.saved"));
      setDashscopeSavedErr(false);
    } catch (error) {
      setDashscopeSaved(t("settings.saveFailed", { error }));
      setDashscopeSavedErr(true);
    } finally {
      setSavingCred(null);
    }
  }

  async function changeOcrBackend(value: string) {
    const next = normalizeOcrBackend(value);
    setOcrBackend(next);
    await saveSetting("ocr_backend", next);
  }

  async function changeOcrType(value: string) {
    setOcrType(value);
    await saveSetting("aliyun_ocr_type", value);
  }

  async function saveOcrCreds() {
    const keyId = ocrKeyId.trim();
    const secret = ocrSecret.trim();
    if (!keyId && !secret) return;
    setOcrSaved("");
    setOcrSavedErr(false);
    setSavingCred("ocr");
    try {
      if (keyId) await ipc.settings.set("aliyun_ocr_access_key_id", keyId);
      if (secret) await ipc.secrets.set("aliyun_ocr_access_key_secret", secret);
      if (secret) {
        ocrSecret2.refresh();
        setOcrSecret("");
      }
      setOcrSaved(t("settings.saved"));
      setOcrSavedErr(false);
    } catch (error) {
      setOcrSaved(t("settings.saveFailed", { error }));
      setOcrSavedErr(true);
    } finally {
      setSavingCred(null);
    }
  }

  async function saveDeepseekOcr() {
    const model = deepseekModel.trim();
    const baseUrl = deepseekBaseUrl.trim();
    const key = deepseekKey.trim();
    if (!key && !model && !baseUrl) return;
    setDeepseekSaved("");
    setDeepseekSavedErr(false);
    setSavingCred("deepseek");
    try {
      if (model) await ipc.settings.set("deepseek_ocr_model", model);
      if (baseUrl) await ipc.settings.set("deepseek_ocr_base_url", baseUrl);
      if (key) {
        await ipc.secrets.set("deepseek_ocr_api_key", key);
        deepseekSecret.refresh();
        setDeepseekKey("");
      }
      setDeepseekSaved(t("settings.saved"));
      setDeepseekSavedErr(false);
    } catch (error) {
      setDeepseekSaved(t("settings.saveFailed", { error }));
      setDeepseekSavedErr(true);
    } finally {
      setSavingCred(null);
    }
  }

  const categories: SettingsCategory[] = [
    "appearance",
    "study",
    "shortcuts",
    "storage",
    "asr",
    "llm",
    "courseware",
  ];
  if (onOpenDevConsole) categories.push("dev");

  function applySettingsExit(intent: PendingSettingsExit) {
    if (intent.kind === "category") {
      setActiveCategory(intent.category);
      if (compact) setEntered(true);
      return;
    }
    if (intent.kind === "category-list") {
      setEntered(false);
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
    if (
      intent.kind === "category" &&
      intent.category === activeCategory &&
      (!compact || entered)
    ) {
      return;
    }
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
    requestSettingsExit(compact && entered ? { kind: "category-list" } : { kind: "close" });

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
  const inDetail = compact && entered;
  const headerTitle = inDetail ? t(CATEGORY_META[activeCategory].i18nKey) : t("settings.title");
  const onHeaderBack = inDetail
    ? () => requestSettingsExit({ kind: "category-list" })
    : () => requestSettingsExit({ kind: "close" });

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
                  onClick={() =>
                    requestSettingsExit({ kind: "category", category: key })
                  }
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

        {compact && !entered ? (
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
                    onClick={() => {
                      requestSettingsExit({ kind: "category", category: key });
                    }}
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

            {loadError && (
              <div
                role="alert"
                className="mb-4 rounded-lg border border-[var(--status-err)] bg-[var(--status-err-bg)] px-3 py-2 text-xs leading-relaxed text-[var(--status-err)]"
              >
                {t("settings.loadError", { error: loadError })}
              </div>
            )}

            {saveError && (
              <div
                role="alert"
                className="mb-4 rounded-lg border border-[var(--status-err)] bg-[var(--status-err-bg)] px-3 py-2 text-xs leading-relaxed text-[var(--status-err)]"
              >
                {t("settings.saveError", { error: saveError })}
              </div>
            )}

            {activeCategory === "appearance" && (
              <>
                <Group header={t("settings.appearance.title")}>
                  <StackRow>
                    <div className="flex gap-6">
                      {THEME_OPTIONS.map((opt) => {
                        const active = themePref === opt.key;
                        return (
                          <button
                            key={opt.key}
                            onClick={() => setThemePref(opt.key)}
                            className="flex flex-col items-center gap-2"
                            aria-pressed={active}
                          >
                            <span
                              className={`block h-14 w-20 overflow-hidden rounded-lg ring-2 transition ${
                                active
                                  ? "ring-[var(--accent)]"
                                  : "ring-[var(--border-subtle)] hover:ring-[var(--text-faint)]"
                              }`}
                            >
                              <ThemeMock pref={opt.key} />
                            </span>
                            <span
                              className={`text-xs ${
                                active
                                  ? "font-medium text-[var(--text-strong)]"
                                  : "text-[var(--text-muted)]"
                              }`}
                            >
                              {t(opt.i18nKey)}
                            </span>
                          </button>
                        );
                      })}
                    </div>
                  </StackRow>
                </Group>

                <Group
                  header={t("settings.appearance.accentColor")}
                >
                  <StackRow>
                    <div className="flex flex-wrap items-center gap-3">
                      {ACCENTS.map((option) => {
                        const selected = accent === option.key;
                        if (option.key === "custom") {
                          return (
                            <label
                              key={option.key}
                              title={t(option.i18nKey)}
                              className={`ca-touch-44 relative grid h-7 w-7 cursor-pointer place-items-center rounded-full ring-2 ring-offset-2 ring-offset-[var(--surface-card)] transition ${
                                selected ? "ring-[var(--text-muted)]" : "ring-transparent"
                              }`}
                            >
                              <input
                                aria-label={t("settings.appearance.customAccent")}
                                type="color"
                                value={customAccent}
                                onChange={(event) => setCustomAccent(event.target.value)}
                                className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
                              />
                              <span
                                className="h-5 w-5 rounded-full"
                                style={{
                                  background:
                                    "conic-gradient(from 210deg, #f25555, #f2a13d, #f2d83d, #5cc46b, #3d8bf2, #a05cf2, #f25590, #f25555)",
                                }}
                              />
                            </label>
                          );
                        }
                        return (
                          <button
                            key={option.key}
                            onClick={() => setAccent(option.key)}
                            title={t(option.i18nKey)}
                            aria-label={t(option.i18nKey)}
                            aria-pressed={selected}
                            className={`ca-touch-44 grid h-7 w-7 place-items-center rounded-full ring-2 ring-offset-2 ring-offset-[var(--surface-card)] transition ${
                              selected ? "ring-[var(--text-muted)]" : "ring-transparent"
                            }`}
                          >
                            <span
                              className="h-5 w-5 rounded-full"
                              style={{ background: option.accent }}
                            />
                          </button>
                        );
                      })}
                    </div>
                  </StackRow>
                </Group>

                <Group header={t("settings.appearance.language")}>
                  <Row label={t("settings.appearance.language")} htmlFor="app-language">
                    <Select
                      id="app-language"
                      value={i18n.language}
                      onChange={(e) => changeLanguage(e.target.value)}
                    >
                      <option value="zh-CN">{t("settings.appearance.languageZh")}</option>
                      <option value="en">{t("settings.appearance.languageEn")}</option>
                    </Select>
                  </Row>
                </Group>
              </>
            )}

            {activeCategory === "study" && (
              <Group
                header={t("settings.studyReminder.title")}
                footnote={t("settings.studyReminder.footnote")}
              >
                <Row
                  label={t("settings.studyReminder.label")}
                  hint={t("settings.studyReminder.hint")}
                  htmlFor="study-reminder"
                >
                  <Switch
                    id="study-reminder"
                    aria-label={t("settings.studyReminder.label")}
                    checked={remindOn}
                    onCheckedChange={(next) => void toggleReminder(next)}
                  />
                </Row>
              </Group>
            )}

            {activeCategory === "shortcuts" && (
              <Group
                header={t("settings.shortcuts.title")}
              >
                {SHORTCUT_ACTIONS.map(({ action, i18nKey, i18nHint }) => (
                  <Row key={action} label={t(i18nKey)} hint={i18nHint ? t(i18nHint) : undefined}>
                    <button
                      type="button"
                      onClick={() => setCapturing(action)}
                      aria-label={t("settings.shortcuts.setKey", { label: t(i18nKey) })}
                      className={`min-h-11 min-w-[88px] rounded-lg border px-3 py-1.5 text-center text-sm font-medium transition ${
                        capturing === action
                          ? "border-[var(--accent-text)] bg-[var(--accent-weak)] text-[var(--accent-text)]"
                          : "border-[var(--border-subtle)] bg-[var(--surface-input)] text-[var(--text-strong)] hover:border-[var(--text-faint)]"
                      }`}
                    >
                      {capturing === action ? t("settings.shortcuts.pressKey") : keyLabel(bindings[action], t)}
                    </button>
                  </Row>
                ))}
                <StackRow>
                  <Button variant="outline" size="sm" onClick={resetBindings}>
                    {t("settings.shortcuts.restoreDefaults")}
                  </Button>
                </StackRow>
              </Group>
            )}

            {activeCategory === "storage" && (
              <>
                <Group
                  header={t("settings.storage.title")}
                  footnote={t("settings.storage.footnote")}
                >
                  <StackRow label={t("settings.storage.defaultRoot")}>
                    <div className="flex items-center gap-2">
                      <input className={FIELD} value={root} readOnly placeholder={t("settings.storage.notSet")} />
                      <Button size="sm" variant="outline" onClick={pickRoot}>
                        {t("settings.storage.select")}
                      </Button>
                      {root && (
                        <Button size="sm" variant="ghost" onClick={() => void clearRoot()}>
                          {t("settings.storage.clear")}
                        </Button>
                      )}
                    </div>
                  </StackRow>
                </Group>
                <Group
                  header={t("settings.storage.security")}
                  footnote={t("settings.storage.securityFootnote")}
                >
                  <Row
                    label={t("backup.label")}
                    hint={t("backup.hint")}
                  >
                    <DatabaseBackupAction />
                  </Row>
                </Group>
              </>
            )}

            {activeCategory === "asr" && (
              <>
                <Group header={t("settings.asr.engineTitle")}>
                  <Row label={t("settings.asr.backend")} htmlFor="asr-backend">
                    <div className="w-full sm:w-56">
                      <Select
                        id="asr-backend"
                        value={asrBackend}
                        onChange={(event) => void changeAsrBackend(event.target.value)}
                      >
                        {!mobile && <option value="whisper">{t("settings.asr.localWhisper")}</option>}
                        <option value="volcengine">{t("settings.asr.volcengine")}</option>
                        <option value="aliyun">{t("settings.asr.aliyun")}</option>
                      </Select>
                    </div>
                  </Row>
                  <Row
                    label={t("settings.asr.language")}
                    htmlFor="asr-language"
                    hint={
                      mobile
                        ? t("settings.asr.languageHintMobile")
                        : t("settings.asr.languageHintDesktop")
                    }
                  >
                    <div className="w-full sm:w-40">
                      <Select
                        id="asr-language"
                        value={asrLanguage}
                        onChange={(event) => void changeAsrLanguage(event.target.value)}
                      >
                        <option value="auto">{t("settings.asr.autoDetect")}</option>
                        <option value="zh">{t("settings.asr.zh")}</option>
                        <option value="en">{t("settings.asr.en")}</option>
                        <option value="ja">{t("settings.asr.ja")}</option>
                        <option value="ko">{t("settings.asr.ko")}</option>
                        <option value="yue">{t("settings.asr.yue")}</option>
                        <option value="fr">{t("settings.asr.fr")}</option>
                        <option value="de">{t("settings.asr.de")}</option>
                        <option value="es">{t("settings.asr.es")}</option>
                        <option value="ru">{t("settings.asr.ru")}</option>
                      </Select>
                    </div>
                  </Row>
                  <Row
                    label={t("settings.asr.concurrency")}
                    htmlFor="asr-correction-concurrency"
                    hint={t("settings.asr.concurrencyHint")}
                  >
                    <input
                      id="asr-correction-concurrency"
                      type="number"
                      min={1}
                      max={2500}
                      step={1}
                      className={`${FIELD} w-24 text-right`}
                      value={correctionConcurrency}
                      onChange={(event) =>
                        void changeCorrectionConcurrency(event.target.value)
                      }
                      onBlur={() => void normalizeCorrectionConcurrency()}
                    />
                  </Row>
                  <Row
                    label={t("settings.asr.importCorrection")}
                    htmlFor="subtitle-autocorrect"
                    hint={t("settings.asr.importCorrectionHint")}
                  >
                    <Switch
                      id="subtitle-autocorrect"
                      checked={subtitleAutocorrect}
                      onCheckedChange={(next) =>
                        void changeSubtitleAutocorrect(next)
                      }
                    />
                  </Row>
                </Group>

                {!mobile && asrBackend === "whisper" && (
                  <Group header={t("settings.asr.whisperTitle")}>
                    <Row label={t("settings.asr.defaultModel")} htmlFor="whisper-model">
                      <div className="w-full sm:w-44">
                        <Select
                          id="whisper-model"
                          value={model}
                          onChange={(event) => void changeModel(event.target.value)}
                        >
                          <option value="tiny">tiny</option>
                          <option value="base">base</option>
                          <option value="small">small</option>
                          <option value="medium">medium</option>
                          <option value="large-v3-turbo">large-v3-turbo</option>
                        </Select>
                      </div>
                    </Row>
                    <StackRow label={t("settings.asr.modelDownload")}>
                      <WhisperModelsPanel />
                    </StackRow>
                  </Group>
                )}

                {asrBackend === "volcengine" && (
                  <Group header={t("settings.asr.volcengineTitle")}>
                    <Row label="App ID" htmlFor="volcengine-asr-app-id">
                      <input
                        id="volcengine-asr-app-id"
                        type="text"
                        className={`${FIELD} w-full sm:w-64`}
                        value={volcengineAppId}
                        placeholder={t("settings.asr.appIdPlaceholder")}
                        onChange={(event) => setVolcengineAppId(event.target.value)}
                      />
                    </Row>
                    <Row
                      label="Access Token"
                      htmlFor="volcengine-asr-token"
                      hint={volcSecret.configured ? t("settings.configured") : t("settings.notConfigured")}
                    >
                      <input
                        id="volcengine-asr-token"
                        type="password"
                        className={`${FIELD} w-full sm:w-64`}
                        value={volcengineToken}
                        placeholder="••••••••"
                        onChange={(event) => setVolcengineToken(event.target.value)}
                      />
                    </Row>
                    <StackRow>
                      <div className="flex items-center gap-3">
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={savingCred !== null}
                          onClick={saveVolcengineKey}
                        >
                          {t("settings.asr.saveVolcCreds")}
                        </Button>
                        <SavedBadge text={volcengineSaved} isError={volcengineSavedErr} />
                      </div>
                    </StackRow>
                    <StackRow
                      label={t("settings.asr.hotwords")}
                      htmlFor="volcengine-asr-hotwords"
                      hint={t("settings.asr.hotwordsHint")}
                    >
                      <textarea
                        id="volcengine-asr-hotwords"
                        className={`${FIELD} min-h-[72px] resize-y`}
                        value={volcengineHotwords}
                        placeholder={t("settings.asr.hotwordsPlaceholder")}
                        onChange={(event) => setVolcengineHotwords(event.target.value)}
                      />
                    </StackRow>
                    <StackRow
                      label={t("settings.asr.context")}
                      htmlFor="volcengine-asr-context"
                      hint={t("settings.asr.contextHint")}
                    >
                      <textarea
                        id="volcengine-asr-context"
                        className={`${FIELD} min-h-[72px] resize-y`}
                        value={volcengineContext}
                        placeholder={t("settings.asr.contextPlaceholder")}
                        onChange={(event) => setVolcengineContext(event.target.value)}
                      />
                    </StackRow>
                    <StackRow>
                      <div className="flex items-center gap-3">
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={savingCred !== null}
                          onClick={saveVolcengineContext}
                        >
                          {t("settings.asr.saveHotwordsContext")}
                        </Button>
                        <SavedBadge text={volcengineCtxSaved} isError={volcengineCtxSavedErr} />
                      </div>
                    </StackRow>
                  </Group>
                )}

                {asrBackend === "aliyun" && (
                  <Group header={t("settings.asr.aliyunTitle")}>
                    <Row label={t("settings.asr.aliyunModel")} htmlFor="aliyun-asr-model">
                      <div className="w-full sm:w-64">
                        <Select
                          id="aliyun-asr-model"
                          value={aliyunModel}
                          onChange={(event) => void changeAliyunModel(event.target.value)}
                        >
                          <option value="qwen3-asr-flash-filetrans">
                            {t("settings.asr.qwen3AsrFlash")}
                          </option>
                          <option value="fun-asr">Fun-ASR</option>
                          <option value="paraformer-v2">Paraformer-v2</option>
                        </Select>
                      </div>
                    </Row>
                    <Row
                      label={t("settings.asr.aliyunApiKey")}
                      htmlFor="dashscope-key"
                      hint={dashSecret.configured ? t("settings.configured") : t("settings.notConfigured")}
                    >
                      <input
                        id="dashscope-key"
                        type="password"
                        className={`${FIELD} w-full sm:w-64`}
                        value={dashscopeKey}
                        placeholder="••••••••"
                        onChange={(event) => setDashscopeKey(event.target.value)}
                      />
                    </Row>
                    <StackRow>
                      <div className="flex items-center gap-3">
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={savingCred !== null}
                          onClick={saveDashscopeKey}
                        >
                          {t("settings.asr.saveAliyunKey")}
                        </Button>
                        <SavedBadge text={dashscopeSaved} isError={dashscopeSavedErr} />
                      </div>
                    </StackRow>
                  </Group>
                )}
              </>
            )}

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

            {activeCategory === "courseware" && (
              <>
                <Group
                  header={t("settings.ocr.title")}
                >
                  <Row label={t("settings.ocr.engine")} htmlFor="ocr-backend">
                    <div className="w-full sm:w-56">
                      <Select
                        id="ocr-backend"
                        value={ocrBackend}
                        onChange={(event) => void changeOcrBackend(event.target.value)}
                      >
                        <option value="local">{t("settings.ocr.localOcr")}</option>
                        <option value="aliyun">{t("settings.ocr.aliyunOcr")}</option>
                        <option value="deepseek">{t("settings.ocr.deepseekOcr")}</option>
                      </Select>
                    </div>
                  </Row>

                  {ocrBackend === "aliyun" && (
                    <>
                      <Row label={t("settings.ocr.aliyunType")} htmlFor="aliyun-ocr-type">
                        <div className="w-full sm:w-56">
                          <Select
                            id="aliyun-ocr-type"
                            value={ocrType}
                            onChange={(event) => void changeOcrType(event.target.value)}
                          >
                            <option value="Advanced">{t("settings.ocr.advanced")}</option>
                            <option value="General">{t("settings.ocr.general")}</option>
                            <option value="HandWriting">{t("settings.ocr.handwriting")}</option>
                            <option value="MultiLanguage">{t("settings.ocr.multiLanguage")}</option>
                            <option value="Table">{t("settings.ocr.table")}</option>
                          </Select>
                        </div>
                      </Row>
                      <Row label="AccessKey ID" htmlFor="aliyun-ocr-key-id">
                        <input
                          id="aliyun-ocr-key-id"
                          type="text"
                          className={`${FIELD} w-full sm:w-64`}
                          value={ocrKeyId}
                          placeholder={t("settings.ocr.accessKeyPlaceholder")}
                          onChange={(event) => setOcrKeyId(event.target.value)}
                        />
                      </Row>
                      <Row
                        label="AccessKey Secret"
                        htmlFor="aliyun-ocr-secret"
                        hint={
                          ocrSecret2.configured
                            ? t("settings.ocr.aliyunSecretConfigured")
                            : t("settings.ocr.aliyunSecretNotConfigured")
                        }
                      >
                        <input
                          id="aliyun-ocr-secret"
                          type="password"
                          className={`${FIELD} w-full sm:w-64`}
                          value={ocrSecret}
                          placeholder="••••••••"
                          onChange={(event) => setOcrSecret(event.target.value)}
                        />
                      </Row>
                      <StackRow>
                        <div className="flex items-center gap-3">
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={savingCred !== null}
                            onClick={saveOcrCreds}
                          >
                            {t("settings.ocr.saveAliyunOcr")}
                          </Button>
                          <SavedBadge text={ocrSaved} isError={ocrSavedErr} />
                        </div>
                      </StackRow>
                    </>
                  )}

                  {ocrBackend === "deepseek" && (
                    <>
                      <Row
                        label={t("settings.ocr.deepseekModel")}
                        htmlFor="deepseek-ocr-model"
                      >
                        <input
                          id="deepseek-ocr-model"
                          type="text"
                          className={`${FIELD} w-full sm:w-64`}
                          value={deepseekModel}
                          placeholder="deepseek-v4-flash-vision-exp"
                          onChange={(event) => setDeepseekModel(event.target.value)}
                        />
                      </Row>
                      <Row
                        label={t("settings.ocr.deepseekBaseUrl")}
                        htmlFor="deepseek-ocr-base-url"
                      >
                        <input
                          id="deepseek-ocr-base-url"
                          type="text"
                          className={`${FIELD} w-full sm:w-64`}
                          value={deepseekBaseUrl}
                          placeholder="https://api.deepseek.com"
                          onChange={(event) => setDeepseekBaseUrl(event.target.value)}
                        />
                      </Row>
                      <Row
                        label={t("settings.ocr.deepseekApiKey")}
                        htmlFor="deepseek-ocr-key"
                        hint={
                          deepseekSecret.configured
                            ? t("settings.ocr.deepseekConfigured")
                            : t("settings.ocr.deepseekNotConfigured")
                        }
                      >
                        <input
                          id="deepseek-ocr-key"
                          type="password"
                          className={`${FIELD} w-full sm:w-64`}
                          value={deepseekKey}
                          placeholder="••••••••"
                          onChange={(event) => setDeepseekKey(event.target.value)}
                        />
                      </Row>
                      <StackRow>
                        <div className="flex items-center gap-3">
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={savingCred !== null}
                            onClick={saveDeepseekOcr}
                          >
                            {t("settings.ocr.saveDeepseekOcr")}
                          </Button>
                          <SavedBadge text={deepseekSaved} isError={deepseekSavedErr} />
                        </div>
                      </StackRow>
                    </>
                  )}
                </Group>

                <Group
                  header={t("settings.courseware.title")}
                >
                  <Row
                    label={t("settings.courseware.autoExtract")}
                    htmlFor="slides-auto-extract"
                  >
                    <Switch
                      id="slides-auto-extract"
                      aria-label={t("settings.courseware.autoExtractLabel")}
                      checked={slidesAutoExtract}
                      onCheckedChange={(next) => void changeSlidesAutoExtract(next)}
                    />
                  </Row>
                  <Row
                    label={t("settings.courseware.autoSensitivity")}
                    htmlFor="slides-auto"
                  >
                    <Switch
                      id="slides-auto"
                      aria-label={t("settings.courseware.autoSensitivityLabel")}
                      checked={slidesAuto}
                      onCheckedChange={(next) =>
                        changeSlidesSensitivity(next ? AUTO_SENSITIVITY : DEFAULT_SLIDES_SENSITIVITY)
                      }
                    />
                  </Row>
                  <StackRow label={t("settings.courseware.sensitivity")}>
                    <div className="flex items-center gap-3 text-xs text-[var(--text-muted)]">
                      <span>{t("settings.courseware.low")}</span>
                      <input
                        aria-label={t("settings.courseware.sensitivityLabel")}
                        type="range"
                        min={0}
                        max={100}
                        step={5}
                        disabled={slidesAuto}
                        value={slidesSliderValue}
                        onChange={(event) => changeSlidesSensitivity(Number(event.target.value))}
                        className="ca-slider flex-1 disabled:opacity-40"
                        style={{ "--slider-fill": `${slidesSliderValue}%` } as CSSProperties}
                      />
                      <span>{t("settings.courseware.high")}</span>
                      <span className="w-8 text-right tabular-nums text-[var(--text-faint)]">
                        {slidesAuto ? t("settings.theme.auto") : slidesSensitivity}
                      </span>
                    </div>
                  </StackRow>
                </Group>
              </>
            )}

            {activeCategory === "dev" && onOpenDevConsole && (
              <Group
                header={t("settings.dev.title")}
                footnote={t("settings.dev.footnote")}
              >
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
      {pendingExit && (
        <div className="absolute inset-0 z-30 grid place-items-center bg-black/30 p-4">
          <div
            ref={pendingDialogRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby="llm-unsaved-title"
            aria-describedby="llm-unsaved-description"
            className="w-full max-w-sm rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-panel)] p-5 shadow-[var(--shadow-pop)]"
          >
            <h3
              id="llm-unsaved-title"
              className="text-base font-semibold text-[var(--text-strong)]"
            >
              {t("settings.unsavedChangesTitle")}
            </h3>
            <p
              id="llm-unsaved-description"
              className="mt-2 text-sm leading-relaxed text-[var(--text-muted)]"
            >
              {t("settings.unsavedChangesDescription")}
            </p>
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
          </div>
        </div>
      )}
    </div>
  );
}
