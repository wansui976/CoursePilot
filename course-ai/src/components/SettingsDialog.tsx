import { open } from "@tauri-apps/plugin-dialog";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { ipc } from "@/lib/ipc";
import { WhisperModelsPanel } from "./WhisperModelsPanel";

export function SettingsPanel({ onClose }: { onClose: () => void }) {
  const [root, setRoot] = useState("");
  const [model, setModel] = useState("large-v3-turbo");

  useEffect(() => {
    void ipc.settings.get("default_storage_root").then((value) => setRoot(value ?? ""));
    void ipc.settings
      .get("whisper_model")
      .then((value) => setModel(value ?? "large-v3-turbo"));
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

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
      <div className="w-[520px] rounded border border-white/10 bg-zinc-900 p-6 shadow-xl">
        <h2 className="mb-4 text-lg">设置</h2>
        <label className="mb-1 block text-sm">
          默认数据根目录（留空 = 跟视频同目录的 .courseai/）
        </label>
        <div className="mb-4 flex items-center gap-2">
          <input
            className="flex-1 rounded bg-zinc-800 px-2 py-1 text-sm"
            value={root}
            readOnly
            placeholder="未设置"
          />
          <Button size="sm" variant="outline" onClick={pickRoot}>
            选择
          </Button>
        </div>
        <label className="mb-1 block text-sm">默认 Whisper 模型</label>
        <select
          value={model}
          onChange={(event) => void changeModel(event.target.value)}
          className="mb-4 w-full rounded bg-zinc-800 px-2 py-1 text-sm"
        >
          <option value="tiny">tiny</option>
          <option value="base">base</option>
          <option value="small">small</option>
          <option value="medium">medium</option>
          <option value="large-v3-turbo">large-v3-turbo</option>
        </select>
        <WhisperModelsPanel />
        <div className="mt-6 text-right">
          <Button onClick={onClose}>关闭</Button>
        </div>
      </div>
    </div>
  );
}
