import { useEffect, useState, type ChangeEvent, type ReactNode } from "react";
import {
  AudioLines,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  FolderCog,
  Palette,
  ScanText,
  Sparkles,
  Terminal,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { useDeviceLayout } from "@/lib/deviceLayout";
import { ipc } from "@/lib/ipc";
import { ACCENTS, useTheme, type ThemePref } from "@/stores/theme";
import {
  getSlidesSensitivity,
  sensitivityToThreshold,
  setSlidesSensitivity,
} from "@/lib/slides";
import { pickDirectoryPath } from "@/lib/mobileFiles";
import { WhisperModelsPanel } from "./WhisperModelsPanel";
import { LlmSettingsPanel } from "./LlmSettingsPanel";

const FIELD =
  "w-full rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-input)] px-3 py-2 text-sm text-[var(--text-strong)] outline-none transition placeholder:text-[var(--text-faint)] focus:border-[var(--accent-text)] focus:ring-2 focus:ring-[var(--accent-text)]/25";

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
  | "storage"
  | "asr"
  | "llm"
  | "courseware"
  | "dev";

const CATEGORY_META: Record<
  SettingsCategory,
  { label: string; icon: ReactNode; tint: string }
> = {
  appearance: { label: "外观", icon: <Palette className="h-3.5 w-3.5" />, tint: "#e0568f" },
  storage: { label: "存储", icon: <FolderCog className="h-3.5 w-3.5" />, tint: "#8e8e93" },
  asr: { label: "语音识别", icon: <AudioLines className="h-3.5 w-3.5" />, tint: "#2f6cea" },
  llm: { label: "大模型", icon: <Sparkles className="h-3.5 w-3.5" />, tint: "#a855f7" },
  courseware: { label: "课件 / OCR", icon: <ScanText className="h-3.5 w-3.5" />, tint: "#f59e0b" },
  dev: { label: "开发者", icon: <Terminal className="h-3.5 w-3.5" />, tint: "#64748b" },
};

const THEME_OPTIONS: { key: ThemePref; label: string }[] = [
  { key: "light", label: "浅色" },
  { key: "dark", label: "深色" },
  { key: "auto", label: "自动" },
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
    <div className="mb-6">
      {header && (
        <h3 className="mb-2 px-1 text-[11px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">
          {header}
        </h3>
      )}
      <div className="divide-y divide-[var(--border-faint)] overflow-hidden rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-card)] shadow-[var(--shadow-card)]">
        {children}
      </div>
      {footnote && (
        <p className="mt-2 px-1 text-xs leading-relaxed text-[var(--text-muted)]">{footnote}</p>
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
    <div className="flex flex-col gap-1.5 px-4 py-2.5 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
      <div className="min-w-0">
        <label
          htmlFor={htmlFor}
          className="block text-[13px] font-medium text-[var(--text-strong)]"
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
    <div className="px-4 py-3">
      {label && (
        <label
          htmlFor={htmlFor}
          className="block text-[13px] font-medium text-[var(--text-strong)]"
        >
          {label}
        </label>
      )}
      {hint && <p className="mt-0.5 text-xs leading-relaxed text-[var(--text-muted)]">{hint}</p>}
      <div className={label || hint ? "mt-2" : ""}>{children}</div>
    </div>
  );
}

function SavedBadge({ text }: { text: string }) {
  if (!text) return null;
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-[var(--status-ok-bg)] px-2 py-0.5 text-xs font-medium text-[var(--status-ok)]">
      <Check className="h-3 w-3" />
      {text}
    </span>
  );
}

export function SettingsPanel({
  onClose,
  onOpenDevConsole,
}: {
  onClose: () => void;
  onOpenDevConsole?: () => void;
}) {
  const [activeCategory, setActiveCategory] = useState<SettingsCategory>("appearance");
  // 竖屏（手机 / 平板竖屏）：取消左侧分类栏，改成「分类列表 → 进入某分类」的下钻，
  // 顶部左上角放返回按钮 + 当前层级标题。entered=false 显示分类列表，true 显示该分类详情。
  const deviceLayout = useDeviceLayout();
  const compact = deviceLayout === "phone" || deviceLayout === "tablet-portrait";
  const [entered, setEntered] = useState(false);
  const themePref = useTheme((s) => s.pref);
  const setThemePref = useTheme((s) => s.setPref);
  const accent = useTheme((s) => s.accent);
  const setAccent = useTheme((s) => s.setAccent);
  const [root, setRoot] = useState("");
  const [model, setModel] = useState("large-v3-turbo");
  const [asrBackend, setAsrBackend] = useState("whisper");
  const [asrLanguage, setAsrLanguage] = useState("zh");
  const [correctionConcurrency, setCorrectionConcurrency] = useState("8");
  const [volcengineAppId, setVolcengineAppId] = useState("");
  const [volcengineToken, setVolcengineToken] = useState("");
  const [volcengineSaved, setVolcengineSaved] = useState("");
  const [volcengineHotwords, setVolcengineHotwords] = useState("");
  const [volcengineContext, setVolcengineContext] = useState("");
  const [volcengineCtxSaved, setVolcengineCtxSaved] = useState("");
  const [dashscopeKey, setDashscopeKey] = useState("");
  const [dashscopeSaved, setDashscopeSaved] = useState("");
  const [aliyunModel, setAliyunModel] = useState("qwen3-asr-flash-filetrans");
  const [ocrBackend, setOcrBackend] = useState("tesseract");
  const [ocrType, setOcrType] = useState("Advanced");
  const [ocrKeyId, setOcrKeyId] = useState("");
  const [ocrSecret, setOcrSecret] = useState("");
  const [ocrSaved, setOcrSaved] = useState("");
  const [slidesSensitivity, setSlidesSensitivityState] = useState(() =>
    getSlidesSensitivity(),
  );

  useEffect(() => {
    void ipc.settings.get("default_storage_root").then((value) => setRoot(value ?? ""));
    void ipc.settings
      .get("whisper_model")
      .then((value) => setModel(value ?? "large-v3-turbo"));
    void ipc.settings
      .get("asr_backend")
      .then((value) => setAsrBackend(value ?? "whisper"));
    void ipc.settings
      .get("asr_language")
      .then((value) => setAsrLanguage(value ?? "zh"));
    void ipc.settings
      .get("asr_correction_concurrency")
      .then((value) => setCorrectionConcurrency(value ?? "8"));
    void ipc.settings
      .get("volcengine_asr_app_id")
      .then((value) => setVolcengineAppId(value ?? ""));
    void ipc.settings
      .get("volcengine_asr_hotwords")
      .then((value) => setVolcengineHotwords(value ?? ""));
    void ipc.settings
      .get("volcengine_asr_context")
      .then((value) => setVolcengineContext(value ?? ""));
    void ipc.settings
      .get("aliyun_asr_model")
      .then((value) => setAliyunModel(value ?? "qwen3-asr-flash-filetrans"));
    void ipc.settings
      .get("ocr_backend")
      .then((value) => setOcrBackend(value ?? "tesseract"));
    void ipc.settings
      .get("aliyun_ocr_type")
      .then((value) => setOcrType(value ?? "Advanced"));
    void ipc.settings
      .get("aliyun_ocr_access_key_id")
      .then((value) => setOcrKeyId(value ?? ""));
  }, []);

  async function pickRoot() {
    const dir = await pickDirectoryPath(["storage"]);
    if (typeof dir === "string") {
      setRoot(dir);
      await ipc.settings.set("default_storage_root", dir);
    }
  }

  async function changeModel(value: string) {
    setModel(value);
    await ipc.settings.set("whisper_model", value);
  }

  async function changeAsrBackend(value: string) {
    setAsrBackend(value);
    await ipc.settings.set("asr_backend", value);
  }

  async function changeAsrLanguage(value: string) {
    setAsrLanguage(value);
    await ipc.settings.set("asr_language", value);
  }

  async function changeCorrectionConcurrency(value: string) {
    setCorrectionConcurrency(value);
    const n = Number(value);
    if (Number.isFinite(n) && n >= 1) {
      await ipc.settings.set("asr_correction_concurrency", String(Math.min(2500, Math.floor(n))));
    }
  }

  async function saveVolcengineKey() {
    const appId = volcengineAppId.trim();
    const token = volcengineToken.trim();
    if (appId) await ipc.settings.set("volcengine_asr_app_id", appId);
    if (token) await ipc.secrets.set("volcengine_asr_access_token", token);
    if (!appId && !token) return;
    setVolcengineToken("");
    setVolcengineSaved("已保存");
    setTimeout(() => setVolcengineSaved(""), 1500);
  }

  async function saveVolcengineContext() {
    await ipc.settings.set("volcengine_asr_hotwords", volcengineHotwords.trim());
    await ipc.settings.set("volcengine_asr_context", volcengineContext.trim());
    setVolcengineCtxSaved("已保存");
    setTimeout(() => setVolcengineCtxSaved(""), 1500);
  }

  async function changeAliyunModel(value: string) {
    setAliyunModel(value);
    await ipc.settings.set("aliyun_asr_model", value);
  }

  async function saveDashscopeKey() {
    if (!dashscopeKey.trim()) return;
    await ipc.secrets.set("dashscope_api_key", dashscopeKey.trim());
    setDashscopeKey("");
    setDashscopeSaved("已保存");
    setTimeout(() => setDashscopeSaved(""), 1500);
  }

  async function changeOcrBackend(value: string) {
    setOcrBackend(value);
    await ipc.settings.set("ocr_backend", value);
  }

  async function changeOcrType(value: string) {
    setOcrType(value);
    await ipc.settings.set("aliyun_ocr_type", value);
  }

  async function saveOcrCreds() {
    const keyId = ocrKeyId.trim();
    const secret = ocrSecret.trim();
    if (keyId) await ipc.settings.set("aliyun_ocr_access_key_id", keyId);
    if (secret) await ipc.secrets.set("aliyun_ocr_access_key_secret", secret);
    if (!keyId && !secret) return;
    setOcrSecret("");
    setOcrSaved("已保存");
    setTimeout(() => setOcrSaved(""), 1500);
  }

  const categories: SettingsCategory[] = [
    "appearance",
    "storage",
    "asr",
    "llm",
    "courseware",
  ];
  if (onOpenDevConsole) categories.push("dev");

  // 竖屏下钻时：进入了某分类则顶栏显示该分类名 + 返回到分类列表；否则显示「设置」+ 关闭。
  const inDetail = compact && entered;
  const headerTitle = inDetail ? CATEGORY_META[activeCategory].label : "设置";
  const onHeaderBack = inDetail ? () => setEntered(false) : onClose;

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col bg-[var(--surface-app)] text-[var(--text-normal)]">
      {/* 头部 */}
      <header className="flex flex-none items-center gap-3 border-b border-[var(--border-subtle)] bg-[var(--surface-header)] px-5 py-3.5">
        <button
          aria-label="返回"
          onClick={onHeaderBack}
          className="grid h-8 w-8 flex-none place-items-center rounded-lg text-[var(--text-muted)] transition hover:bg-[var(--surface-card-hover)] hover:text-[var(--text-strong)]"
        >
          <ChevronLeft className="h-5 w-5" />
        </button>
        <h2 className="text-[15px] font-semibold text-[var(--text-strong)]">{headerTitle}</h2>
      </header>

      {/* 侧栏分类 + 右侧分组卡片；竖屏改为「分类列表 → 下钻」 */}
      <div className="flex min-h-0 flex-1">
        {!compact && (
          <nav
            aria-label="设置分类"
            className="flex w-52 flex-none flex-col gap-0.5 overflow-y-auto border-r border-[var(--border-subtle)] bg-[var(--surface-sidebar)] p-3"
          >
            {categories.map((key) => {
              const meta = CATEGORY_META[key];
              const active = key === activeCategory;
              return (
                <button
                  key={key}
                  onClick={() => setActiveCategory(key)}
                  aria-current={active ? "page" : undefined}
                  className={`flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left text-[13px] transition ${
                    active
                      ? "bg-[var(--accent-weak)] font-medium text-[var(--accent-text)]"
                      : "text-[var(--text-normal)] hover:bg-[var(--surface-card-hover)]"
                  }`}
                >
                  <span
                    className="grid h-6 w-6 flex-none place-items-center rounded-md text-white"
                    style={{ background: meta.tint }}
                  >
                    {meta.icon}
                  </span>
                  {meta.label}
                </button>
              );
            })}
          </nav>
        )}

        {compact && !entered ? (
          <nav
            aria-label="设置分类"
            className="min-h-0 flex-1 overflow-y-auto px-4 py-5"
          >
            <div className="mx-auto max-w-2xl divide-y divide-[var(--border-faint)] overflow-hidden rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-card)] shadow-[var(--shadow-card)]">
              {categories.map((key) => {
                const meta = CATEGORY_META[key];
                return (
                  <button
                    key={key}
                    onClick={() => {
                      setActiveCategory(key);
                      setEntered(true);
                    }}
                    className="flex w-full items-center gap-3 px-4 py-3 text-left transition hover:bg-[var(--surface-card-hover)]"
                  >
                    <span
                      className="grid h-7 w-7 flex-none place-items-center rounded-md text-white"
                      style={{ background: meta.tint }}
                    >
                      {meta.icon}
                    </span>
                    <span className="flex-1 text-[15px] text-[var(--text-strong)]">
                      {meta.label}
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
              <h2 className="mb-5 text-xl font-semibold text-[var(--text-strong)]">
                {CATEGORY_META[activeCategory].label}
              </h2>
            )}

            {activeCategory === "appearance" && (
              <>
                <Group header="外观">
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
                              {opt.label}
                            </span>
                          </button>
                        );
                      })}
                    </div>
                  </StackRow>
                </Group>

                <Group
                  header="强调色"
                  footnote="影响按钮、选中态等点缀色；「多色」即默认蓝。"
                >
                  <StackRow>
                    <div className="flex flex-wrap items-center gap-3">
                      {ACCENTS.map((option) => {
                        const selected = accent === option.key;
                        return (
                          <button
                            key={option.key}
                            onClick={() => setAccent(option.key)}
                            title={option.label}
                            aria-label={option.label}
                            aria-pressed={selected}
                            className={`grid h-7 w-7 place-items-center rounded-full ring-2 ring-offset-2 ring-offset-[var(--surface-card)] transition ${
                              selected ? "ring-[var(--text-muted)]" : "ring-transparent"
                            }`}
                          >
                            <span
                              className="h-5 w-5 rounded-full"
                              style={{
                                background:
                                  option.key === "multi"
                                    ? "conic-gradient(from 210deg, #f25555, #f2a13d, #f2d83d, #5cc46b, #3d8bf2, #a05cf2, #f25590, #f25555)"
                                    : option.accent,
                              }}
                            />
                          </button>
                        );
                      })}
                    </div>
                  </StackRow>
                </Group>
              </>
            )}

            {activeCategory === "storage" && (
              <Group
                header="存储位置"
                footnote="转写、字幕、课件等产物的存放位置；留空 = 跟视频同目录的 .courseai/。"
              >
                <StackRow label="默认数据根目录">
                  <div className="flex items-center gap-2">
                    <input className={FIELD} value={root} readOnly placeholder="未设置" />
                    <Button size="sm" variant="outline" onClick={pickRoot}>
                      选择
                    </Button>
                  </div>
                </StackRow>
              </Group>
            )}

            {activeCategory === "asr" && (
              <>
                <Group header="识别引擎">
                  <Row label="识别后端" htmlFor="asr-backend">
                    <div className="w-full sm:w-56">
                      <Select
                        id="asr-backend"
                        value={asrBackend}
                        onChange={(event) => void changeAsrBackend(event.target.value)}
                      >
                        <option value="whisper">本地 Whisper</option>
                        <option value="volcengine">火山录音文件识别</option>
                        <option value="aliyun">阿里云 DashScope 录音文件识别</option>
                      </Select>
                    </div>
                  </Row>
                  <Row
                    label="识别语言"
                    htmlFor="asr-language"
                    hint="对本地 Whisper 与阿里云 paraformer-v2 / fun-asr 生效；火山及通义千问 ASR 为自动识别"
                  >
                    <div className="w-full sm:w-40">
                      <Select
                        id="asr-language"
                        value={asrLanguage}
                        onChange={(event) => void changeAsrLanguage(event.target.value)}
                      >
                        <option value="auto">自动检测</option>
                        <option value="zh">中文</option>
                        <option value="en">英语</option>
                        <option value="ja">日语</option>
                        <option value="ko">韩语</option>
                        <option value="yue">粤语</option>
                        <option value="fr">法语</option>
                        <option value="de">德语</option>
                        <option value="es">西班牙语</option>
                        <option value="ru">俄语</option>
                      </Select>
                    </div>
                  </Row>
                  <Row
                    label="AI 纠错并发数"
                    htmlFor="asr-correction-concurrency"
                    hint="字幕分批并发交给大模型纠错；越大越快，但受模型并发上限约束（DeepSeek-flash 2500 / pro 500，普通端点建议 5~16）。"
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
                    />
                  </Row>
                </Group>

                {asrBackend === "whisper" && (
                  <Group header="本地 Whisper">
                    <Row label="默认 Whisper 模型" htmlFor="whisper-model">
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
                    <StackRow label="模型下载">
                      <WhisperModelsPanel />
                    </StackRow>
                  </Group>
                )}

                {asrBackend === "volcengine" && (
                  <Group header="火山引擎">
                    <Row label="App ID" htmlFor="volcengine-asr-app-id">
                      <input
                        id="volcengine-asr-app-id"
                        type="text"
                        className={`${FIELD} w-full sm:w-64`}
                        value={volcengineAppId}
                        placeholder="控制台「应用」的 App ID"
                        onChange={(event) => setVolcengineAppId(event.target.value)}
                      />
                    </Row>
                    <Row
                      label="Access Token"
                      htmlFor="volcengine-asr-token"
                      hint="留空 = 不修改"
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
                        <Button size="sm" variant="outline" onClick={saveVolcengineKey}>
                          保存火山 ASR 凭证
                        </Button>
                        <SavedBadge text={volcengineSaved} />
                      </div>
                    </StackRow>
                    <StackRow
                      label="热词"
                      htmlFor="volcengine-asr-hotwords"
                      hint="一行一个（也可用逗号/顿号分隔），最多 5000 词；专有名词、人名、术语"
                    >
                      <textarea
                        id="volcengine-asr-hotwords"
                        className={`${FIELD} min-h-[72px] resize-y`}
                        value={volcengineHotwords}
                        placeholder={"勒沙特列原理\n焓变\n范德华力"}
                        onChange={(event) => setVolcengineHotwords(event.target.value)}
                      />
                    </StackRow>
                    <StackRow
                      label="上下文"
                      htmlFor="volcengine-asr-context"
                      hint="视频标题、课程名会自动加入；此处可补充口音/领域/场景等（约 800 tokens 上限，一行一条）"
                    >
                      <textarea
                        id="volcengine-asr-context"
                        className={`${FIELD} min-h-[72px] resize-y`}
                        value={volcengineContext}
                        placeholder={"本片为高中化学反应原理课\n讲师有四川口音"}
                        onChange={(event) => setVolcengineContext(event.target.value)}
                      />
                    </StackRow>
                    <StackRow>
                      <div className="flex items-center gap-3">
                        <Button size="sm" variant="outline" onClick={saveVolcengineContext}>
                          保存热词与上下文
                        </Button>
                        <SavedBadge text={volcengineCtxSaved} />
                      </div>
                    </StackRow>
                  </Group>
                )}

                {asrBackend === "aliyun" && (
                  <Group header="阿里云 DashScope">
                    <Row label="识别模型" htmlFor="aliyun-asr-model">
                      <div className="w-full sm:w-64">
                        <Select
                          id="aliyun-asr-model"
                          value={aliyunModel}
                          onChange={(event) => void changeAliyunModel(event.target.value)}
                        >
                          <option value="qwen3-asr-flash-filetrans">
                            千问3-ASR-Flash-Filetrans
                          </option>
                          <option value="fun-asr">Fun-ASR</option>
                          <option value="paraformer-v2">Paraformer-v2</option>
                        </Select>
                      </div>
                    </Row>
                    <Row
                      label="百炼 API Key"
                      htmlFor="dashscope-key"
                      hint="留空 = 不修改"
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
                        <Button size="sm" variant="outline" onClick={saveDashscopeKey}>
                          保存百炼 API Key
                        </Button>
                        <SavedBadge text={dashscopeSaved} />
                      </div>
                    </StackRow>
                  </Group>
                )}
              </>
            )}

            {activeCategory === "llm" && (
              <Group header="大模型" footnote="用于生成笔记、出题、脑图与问答。">
                <StackRow>
                  <LlmSettingsPanel />
                </StackRow>
              </Group>
            )}

            {activeCategory === "courseware" && (
              <>
                <Group
                  header="图文识别 (OCR)"
                  footnote="对课件帧「截字」时使用的文字识别引擎。"
                >
                  <Row label="OCR 引擎" htmlFor="ocr-backend">
                    <div className="w-full sm:w-56">
                      <Select
                        id="ocr-backend"
                        value={ocrBackend}
                        onChange={(event) => void changeOcrBackend(event.target.value)}
                      >
                        <option value="tesseract">本地 Tesseract</option>
                        <option value="aliyun">阿里云 OCR 统一识别</option>
                      </Select>
                    </div>
                  </Row>

                  {ocrBackend === "aliyun" && (
                    <>
                      <Row label="识别类型" htmlFor="aliyun-ocr-type">
                        <div className="w-full sm:w-56">
                          <Select
                            id="aliyun-ocr-type"
                            value={ocrType}
                            onChange={(event) => void changeOcrType(event.target.value)}
                          >
                            <option value="Advanced">通用文字识别（高精版）</option>
                            <option value="General">通用文字识别</option>
                            <option value="HandWriting">手写文字识别</option>
                            <option value="MultiLanguage">多语言识别</option>
                            <option value="Table">表格识别</option>
                          </Select>
                        </div>
                      </Row>
                      <Row label="AccessKey ID" htmlFor="aliyun-ocr-key-id">
                        <input
                          id="aliyun-ocr-key-id"
                          type="text"
                          className={`${FIELD} w-full sm:w-64`}
                          value={ocrKeyId}
                          placeholder="阿里云 RAM 账号 AccessKey ID"
                          onChange={(event) => setOcrKeyId(event.target.value)}
                        />
                      </Row>
                      <Row
                        label="AccessKey Secret"
                        htmlFor="aliyun-ocr-secret"
                        hint="留空 = 不修改；需在阿里云控制台开通「文字识别 OCR」"
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
                          <Button size="sm" variant="outline" onClick={saveOcrCreds}>
                            保存阿里云 OCR 凭证
                          </Button>
                          <SavedBadge text={ocrSaved} />
                        </div>
                      </StackRow>
                    </>
                  )}
                </Group>

                <Group
                  header="课件提取"
                  footnote={`灵敏度越高抓取的课件页越多（当前差异阈值 ${sensitivityToThreshold(
                    slidesSensitivity,
                  )}）。`}
                >
                  <StackRow label="换页灵敏度">
                    <div className="flex items-center gap-3 text-xs text-[var(--text-muted)]">
                      <span>低</span>
                      <input
                        aria-label="课件提取灵敏度"
                        type="range"
                        min={0}
                        max={100}
                        step={5}
                        value={slidesSensitivity}
                        onChange={(event) => {
                          const value = Number(event.target.value);
                          setSlidesSensitivityState(value);
                          setSlidesSensitivity(value);
                        }}
                        className="h-1 flex-1 accent-primary"
                      />
                      <span>高</span>
                      <span className="w-8 text-right tabular-nums text-[var(--text-faint)]">
                        {slidesSensitivity}
                      </span>
                    </div>
                  </StackRow>
                </Group>
              </>
            )}

            {activeCategory === "dev" && onOpenDevConsole && (
              <Group
                header="开发者"
                footnote="查看 AI 文稿纠错的请求与回复，确认纠错是否真的实施。"
              >
                <StackRow>
                  <Button variant="outline" size="sm" onClick={onOpenDevConsole}>
                    <Terminal className="h-3.5 w-3.5" />
                    打开开发控制台
                  </Button>
                </StackRow>
              </Group>
            )}
          </div>
        </div>
        )}
      </div>
    </div>
  );
}
