import { open } from "@tauri-apps/plugin-dialog";
import { useEffect, useState, type ChangeEvent, type ReactNode } from "react";
import {
  AudioLines,
  Check,
  ChevronDown,
  ChevronLeft,
  FolderCog,
  Images,
  ScanText,
  Sparkles,
  Terminal,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { ipc } from "@/lib/ipc";
import {
  getSlidesSensitivity,
  sensitivityToThreshold,
  setSlidesSensitivity,
} from "@/lib/slides";
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

function Section({
  icon,
  title,
  desc,
  children,
}: {
  icon: ReactNode;
  title: string;
  desc?: string;
  children: ReactNode;
}) {
  return (
    <section className="space-y-4 rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-card)] p-4 shadow-[var(--shadow-card)]">
      <div className="flex items-start gap-3">
        <div className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-[var(--accent-weak)] text-[var(--accent-text)]">
          {icon}
        </div>
        <div className="min-w-0">
          <h3 className="text-sm font-semibold text-[var(--text-strong)]">{title}</h3>
          {desc && <p className="mt-0.5 text-xs text-[var(--text-muted)]">{desc}</p>}
        </div>
      </div>
      <div className="space-y-4">{children}</div>
    </section>
  );
}

function Field({
  label,
  htmlFor,
  hint,
  children,
}: {
  label: string;
  htmlFor?: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <label
        htmlFor={htmlFor}
        className="block text-[13px] font-medium text-[var(--text-strong)]"
      >
        {label}
      </label>
      {children}
      {hint && <p className="text-xs text-[var(--text-muted)]">{hint}</p>}
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
  const [root, setRoot] = useState("");
  const [model, setModel] = useState("large-v3-turbo");
  const [asrBackend, setAsrBackend] = useState("whisper");
  const [asrLanguage, setAsrLanguage] = useState("zh");
  const [volcengineAppId, setVolcengineAppId] = useState("");
  const [volcengineToken, setVolcengineToken] = useState("");
  const [volcengineSaved, setVolcengineSaved] = useState("");
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
      .get("volcengine_asr_app_id")
      .then((value) => setVolcengineAppId(value ?? ""));
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
    const dir = await open({ directory: true, multiple: false });
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

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col bg-[var(--surface-app)] text-[var(--text-normal)]">
      {/* 头部 */}
      <header className="flex flex-none items-center gap-3 border-b border-[var(--border-subtle)] bg-[var(--surface-header)] px-7 py-4">
        <button
          aria-label="返回"
          onClick={onClose}
          className="grid h-8 w-8 flex-none place-items-center rounded-lg text-[var(--text-muted)] transition hover:bg-[var(--surface-card-hover)] hover:text-[var(--text-strong)]"
        >
          <ChevronLeft className="h-5 w-5" />
        </button>
        <div className="min-w-0">
          <h2 className="text-lg font-semibold text-[var(--text-strong)]">设置</h2>
          <p className="mt-0.5 text-xs text-[var(--text-muted)]">
            存储位置、语音识别与大模型配置
          </p>
        </div>
      </header>

      {/* 内容 */}
      <div className="min-h-0 flex-1 overflow-y-auto px-7 py-6">
        <div className="mx-auto max-w-2xl space-y-4">
          <Section
            icon={<FolderCog className="h-4 w-4" />}
            title="存储"
            desc="转写、字幕、课件等产物的存放位置"
          >
            <Field
              label="默认数据根目录"
              hint="留空 = 跟视频同目录的 .courseai/"
            >
              <div className="flex items-center gap-2">
                <input
                  className={FIELD}
                  value={root}
                  readOnly
                  placeholder="未设置"
                />
                <Button size="sm" variant="outline" onClick={pickRoot}>
                  选择
                </Button>
              </div>
            </Field>
          </Section>

          <Section
            icon={<AudioLines className="h-4 w-4" />}
            title="语音识别"
            desc="选择把视频转写成文字的引擎"
          >
            <Field label="语音识别后端" htmlFor="asr-backend">
              <Select
                id="asr-backend"
                value={asrBackend}
                onChange={(event) => void changeAsrBackend(event.target.value)}
              >
                <option value="whisper">本地 Whisper</option>
                <option value="volcengine">火山录音文件识别</option>
                <option value="aliyun">阿里云 DashScope 录音文件识别</option>
              </Select>
            </Field>

            <Field
              label="识别语言"
              htmlFor="asr-language"
              hint="对本地 Whisper 与阿里云 paraformer-v2 / fun-asr 生效；火山及通义千问 ASR 为自动识别"
            >
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
            </Field>

            {asrBackend === "whisper" && (
              <>
                <Field label="默认 Whisper 模型" htmlFor="whisper-model">
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
                </Field>
                <WhisperModelsPanel />
              </>
            )}

            {asrBackend === "volcengine" && (
              <>
                <Field label="火山 ASR App ID" htmlFor="volcengine-asr-app-id">
                  <input
                    id="volcengine-asr-app-id"
                    type="text"
                    className={FIELD}
                    value={volcengineAppId}
                    placeholder="控制台「应用」的 App ID"
                    onChange={(event) => setVolcengineAppId(event.target.value)}
                  />
                </Field>
                <Field
                  label="火山 ASR Access Token"
                  htmlFor="volcengine-asr-token"
                  hint="留空 = 不修改"
                >
                  <input
                    id="volcengine-asr-token"
                    type="password"
                    className={FIELD}
                    value={volcengineToken}
                    placeholder="••••••••"
                    onChange={(event) => setVolcengineToken(event.target.value)}
                  />
                </Field>
                <div className="flex items-center gap-3">
                  <Button size="sm" variant="outline" onClick={saveVolcengineKey}>
                    保存火山 ASR 凭证
                  </Button>
                  <SavedBadge text={volcengineSaved} />
                </div>
              </>
            )}

            {asrBackend === "aliyun" && (
              <>
                <Field label="识别模型" htmlFor="aliyun-asr-model">
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
                </Field>
                <Field
                  label="百炼 API Key"
                  htmlFor="dashscope-key"
                  hint="留空 = 不修改"
                >
                  <input
                    id="dashscope-key"
                    type="password"
                    className={FIELD}
                    value={dashscopeKey}
                    placeholder="••••••••"
                    onChange={(event) => setDashscopeKey(event.target.value)}
                  />
                </Field>
                <div className="flex items-center gap-3">
                  <Button size="sm" variant="outline" onClick={saveDashscopeKey}>
                    保存百炼 API Key
                  </Button>
                  <SavedBadge text={dashscopeSaved} />
                </div>
              </>
            )}
          </Section>

          <Section
            icon={<ScanText className="h-4 w-4" />}
            title="图文识别 (OCR)"
            desc="对课件帧「截字」时使用的文字识别引擎"
          >
            <Field label="OCR 引擎" htmlFor="ocr-backend">
              <Select
                id="ocr-backend"
                value={ocrBackend}
                onChange={(event) => void changeOcrBackend(event.target.value)}
              >
                <option value="tesseract">本地 Tesseract</option>
                <option value="aliyun">阿里云 OCR 统一识别</option>
              </Select>
            </Field>

            {ocrBackend === "aliyun" && (
              <>
                <Field label="识别类型" htmlFor="aliyun-ocr-type">
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
                </Field>
                <Field label="AccessKey ID" htmlFor="aliyun-ocr-key-id">
                  <input
                    id="aliyun-ocr-key-id"
                    type="text"
                    className={FIELD}
                    value={ocrKeyId}
                    placeholder="阿里云 RAM 账号 AccessKey ID"
                    onChange={(event) => setOcrKeyId(event.target.value)}
                  />
                </Field>
                <Field
                  label="AccessKey Secret"
                  htmlFor="aliyun-ocr-secret"
                  hint="留空 = 不修改；需在阿里云控制台开通「文字识别 OCR」"
                >
                  <input
                    id="aliyun-ocr-secret"
                    type="password"
                    className={FIELD}
                    value={ocrSecret}
                    placeholder="••••••••"
                    onChange={(event) => setOcrSecret(event.target.value)}
                  />
                </Field>
                <div className="flex items-center gap-3">
                  <Button size="sm" variant="outline" onClick={saveOcrCreds}>
                    保存阿里云 OCR 凭证
                  </Button>
                  <SavedBadge text={ocrSaved} />
                </div>
              </>
            )}
          </Section>

          <Section
            icon={<Images className="h-4 w-4" />}
            title="课件提取"
            desc="按画面变化自动识别换页的灵敏度"
          >
            <Field
              label="灵敏度"
              hint={`灵敏度越高抓取的课件页越多（当前差异阈值 ${sensitivityToThreshold(
                slidesSensitivity,
              )}）`}
            >
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
            </Field>
          </Section>

          <Section
            icon={<Sparkles className="h-4 w-4" />}
            title="大模型"
            desc="用于生成笔记、出题、脑图与问答"
          >
            <LlmSettingsPanel />
          </Section>

          {onOpenDevConsole && (
            <Section
              icon={<Terminal className="h-4 w-4" />}
              title="开发者"
              desc="查看 AI 文稿纠错的请求与回复，确认纠错是否真的实施"
            >
              <Button variant="outline" size="sm" onClick={onOpenDevConsole}>
                <Terminal className="h-3.5 w-3.5" />
                打开开发控制台
              </Button>
            </Section>
          )}
        </div>
      </div>
    </div>
  );
}
