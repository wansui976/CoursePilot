import { open } from "@tauri-apps/plugin-dialog";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { ipc } from "@/lib/ipc";
import { WhisperModelsPanel } from "./WhisperModelsPanel";
import { LlmSettingsPanel } from "./LlmSettingsPanel";

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

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
      <div className="max-h-[80vh] w-[520px] overflow-y-auto rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-rail)] p-6 text-[var(--text-normal)] shadow-[var(--shadow-pop)]">
        <h2 className="mb-4 text-lg font-semibold text-[var(--text-strong)]">设置</h2>
        <label className="mb-1 block text-sm">
          默认数据根目录（留空 = 跟视频同目录的 .courseai/）
        </label>
        <div className="mb-4 flex items-center gap-2">
          <input
            className="flex-1 rounded border border-[var(--border-subtle)] bg-[var(--surface-input)] px-2 py-1 text-sm text-[var(--text-strong)]"
            value={root}
            readOnly
            placeholder="未设置"
          />
          <Button size="sm" variant="outline" onClick={pickRoot}>
            选择
          </Button>
        </div>
        <label className="mb-1 block text-sm" htmlFor="asr-backend">
          语音识别后端
        </label>
        <select
          id="asr-backend"
          value={asrBackend}
          onChange={(event) => void changeAsrBackend(event.target.value)}
          className="mb-4 w-full rounded border border-[var(--border-subtle)] bg-[var(--surface-input)] px-2 py-1 text-sm text-[var(--text-strong)]"
        >
          <option value="whisper">本地 Whisper</option>
          <option value="volcengine">火山录音文件识别</option>
          <option value="aliyun">阿里云 DashScope 录音文件识别</option>
        </select>
        {asrBackend === "whisper" && (
          <>
            <label className="mb-1 block text-sm" htmlFor="whisper-model">
              默认 Whisper 模型
            </label>
            <select
              id="whisper-model"
              value={model}
              onChange={(event) => void changeModel(event.target.value)}
              className="mb-4 w-full rounded border border-[var(--border-subtle)] bg-[var(--surface-input)] px-2 py-1 text-sm text-[var(--text-strong)]"
            >
              <option value="tiny">tiny</option>
              <option value="base">base</option>
              <option value="small">small</option>
              <option value="medium">medium</option>
              <option value="large-v3-turbo">large-v3-turbo</option>
            </select>
            <WhisperModelsPanel />
          </>
        )}
        {asrBackend === "volcengine" && (
          <div className="mb-4 space-y-2">
            <label className="block text-sm" htmlFor="volcengine-asr-app-id">
              火山 ASR App ID
            </label>
            <input
              id="volcengine-asr-app-id"
              type="text"
              className="w-full rounded border border-[var(--border-subtle)] bg-[var(--surface-input)] px-2 py-1 text-sm text-[var(--text-strong)]"
              value={volcengineAppId}
              placeholder="控制台「应用」的 App ID"
              onChange={(event) => setVolcengineAppId(event.target.value)}
            />
            <label className="block text-sm" htmlFor="volcengine-asr-token">
              火山 ASR Access Token
            </label>
            <input
              id="volcengine-asr-token"
              type="password"
              className="w-full rounded border border-[var(--border-subtle)] bg-[var(--surface-input)] px-2 py-1 text-sm text-[var(--text-strong)]"
              value={volcengineToken}
              placeholder="留空 = 不修改"
              onChange={(event) => setVolcengineToken(event.target.value)}
            />
            <div className="flex items-center gap-2">
              <Button size="sm" variant="outline" onClick={saveVolcengineKey}>
                保存火山 ASR 凭证
              </Button>
              {volcengineSaved && (
                <span className="text-xs text-emerald-500">{volcengineSaved}</span>
              )}
            </div>
          </div>
        )}
        {asrBackend === "aliyun" && (
          <div className="mb-4 space-y-2">
            <label className="block text-sm" htmlFor="aliyun-asr-model">
              识别模型
            </label>
            <select
              id="aliyun-asr-model"
              value={aliyunModel}
              onChange={(event) => void changeAliyunModel(event.target.value)}
              className="w-full rounded border border-[var(--border-subtle)] bg-[var(--surface-input)] px-2 py-1 text-sm text-[var(--text-strong)]"
            >
              <option value="qwen3-asr-flash-filetrans">千问3-ASR-Flash-Filetrans</option>
              <option value="fun-asr">Fun-ASR</option>
              <option value="paraformer-v2">Paraformer-v2</option>
            </select>
            <label className="block text-sm" htmlFor="dashscope-key">
              百炼 API Key
            </label>
            <input
              id="dashscope-key"
              type="password"
              className="w-full rounded border border-[var(--border-subtle)] bg-[var(--surface-input)] px-2 py-1 text-sm text-[var(--text-strong)]"
              value={dashscopeKey}
              placeholder="留空 = 不修改"
              onChange={(event) => setDashscopeKey(event.target.value)}
            />
            <div className="flex items-center gap-2">
              <Button size="sm" variant="outline" onClick={saveDashscopeKey}>
                保存百炼 API Key
              </Button>
              {dashscopeSaved && (
                <span className="text-xs text-emerald-500">{dashscopeSaved}</span>
              )}
            </div>
          </div>
        )}
        <div className="my-4 border-t border-[var(--border-subtle)]" />
        <LlmSettingsPanel />
        <div className="mt-6 text-right">
          <Button onClick={onClose}>关闭</Button>
        </div>
      </div>
    </div>
  );
}
