import { open } from "@tauri-apps/plugin-dialog";
import { useEffect, useState, type ReactNode } from "react";
import { AudioLines, Check, FolderCog, ScanText, Sparkles, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ipc } from "@/lib/ipc";
import { WhisperModelsPanel } from "./WhisperModelsPanel";
import { LlmSettingsPanel } from "./LlmSettingsPanel";

const FIELD =
  "w-full rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-input)] px-3 py-2 text-sm text-[var(--text-strong)] outline-none transition placeholder:text-[var(--text-faint)] focus:border-[var(--accent-text)] focus:ring-2 focus:ring-[var(--accent-text)]/25";

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

export function SettingsPanel({ onClose }: { onClose: () => void }) {
  const [root, setRoot] = useState("");
  const [model, setModel] = useState("large-v3-turbo");
  const [asrBackend, setAsrBackend] = useState("whisper");
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

  useEffect(() => {
    void ipc.settings.get("default_storage_root").then((value) => setRoot(value ?? ""));
    void ipc.settings
      .get("whisper_model")
      .then((value) => setModel(value ?? "large-v3-turbo"));
    void ipc.settings
      .get("asr_backend")
      .then((value) => setAsrBackend(value ?? "whisper"));
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

  async function saveVolcengineKey() {
    const appId = volcengineAppId.trim();
    const token = volcengineToken.trim();
    if (appId) await ipc.settings.set("volcengine_asr_app_id", appId);
    if (token) await ipc.settings.set("volcengine_asr_access_token", token);
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
    await ipc.settings.set("dashscope_api_key", dashscopeKey.trim());
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
    if (secret) await ipc.settings.set("aliyun_ocr_access_key_secret", secret);
    if (!keyId && !secret) return;
    setOcrSecret("");
    setOcrSaved("已保存");
    setTimeout(() => setOcrSaved(""), 1500);
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="flex max-h-[86vh] w-[560px] max-w-full flex-col overflow-hidden rounded-2xl border border-[var(--border-subtle)] bg-[var(--surface-rail)] text-[var(--text-normal)] shadow-[var(--shadow-pop)]"
        onClick={(e) => e.stopPropagation()}
      >
        {/* 头部 */}
        <header className="flex items-center justify-between border-b border-[var(--border-subtle)] px-5 py-4">
          <div>
            <h2 className="text-base font-semibold text-[var(--text-strong)]">设置</h2>
            <p className="mt-0.5 text-xs text-[var(--text-muted)]">
              存储位置、语音识别与大模型配置
            </p>
          </div>
          <button
            aria-label="关闭设置"
            onClick={onClose}
            className="grid h-8 w-8 place-items-center rounded-lg text-[var(--text-muted)] transition hover:bg-[var(--surface-card-hover)] hover:text-[var(--text-strong)]"
          >
            <X className="h-4 w-4" />
          </button>
        </header>

        {/* 内容 */}
        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-5 py-5">
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
              <select
                id="asr-backend"
                value={asrBackend}
                onChange={(event) => void changeAsrBackend(event.target.value)}
                className={FIELD}
              >
                <option value="whisper">本地 Whisper</option>
                <option value="volcengine">火山录音文件识别</option>
                <option value="aliyun">阿里云 DashScope 录音文件识别</option>
              </select>
            </Field>

            {asrBackend === "whisper" && (
              <>
                <Field label="默认 Whisper 模型" htmlFor="whisper-model">
                  <select
                    id="whisper-model"
                    value={model}
                    onChange={(event) => void changeModel(event.target.value)}
                    className={FIELD}
                  >
                    <option value="tiny">tiny</option>
                    <option value="base">base</option>
                    <option value="small">small</option>
                    <option value="medium">medium</option>
                    <option value="large-v3-turbo">large-v3-turbo</option>
                  </select>
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
                  <select
                    id="aliyun-asr-model"
                    value={aliyunModel}
                    onChange={(event) => void changeAliyunModel(event.target.value)}
                    className={FIELD}
                  >
                    <option value="qwen3-asr-flash-filetrans">
                      千问3-ASR-Flash-Filetrans
                    </option>
                    <option value="fun-asr">Fun-ASR</option>
                    <option value="paraformer-v2">Paraformer-v2</option>
                  </select>
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
              <select
                id="ocr-backend"
                value={ocrBackend}
                onChange={(event) => void changeOcrBackend(event.target.value)}
                className={FIELD}
              >
                <option value="tesseract">本地 Tesseract</option>
                <option value="aliyun">阿里云 OCR 统一识别</option>
              </select>
            </Field>

            {ocrBackend === "aliyun" && (
              <>
                <Field label="识别类型" htmlFor="aliyun-ocr-type">
                  <select
                    id="aliyun-ocr-type"
                    value={ocrType}
                    onChange={(event) => void changeOcrType(event.target.value)}
                    className={FIELD}
                  >
                    <option value="Advanced">通用文字识别（高精版）</option>
                    <option value="General">通用文字识别</option>
                    <option value="HandWriting">手写文字识别</option>
                    <option value="MultiLanguage">多语言识别</option>
                    <option value="Table">表格识别</option>
                  </select>
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
            icon={<Sparkles className="h-4 w-4" />}
            title="大模型"
            desc="用于生成笔记、出题、脑图与问答"
          >
            <LlmSettingsPanel />
          </Section>
        </div>

        {/* 底部 */}
        <footer className="flex items-center justify-end gap-2 border-t border-[var(--border-subtle)] px-5 py-3">
          <Button onClick={onClose}>关闭</Button>
        </footer>
      </div>
    </div>
  );
}
