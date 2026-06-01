import { listen } from "@tauri-apps/api/event";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { ipc, type WhisperModel } from "@/lib/ipc";

type Row = [WhisperModel, boolean];

export function WhisperModelsPanel() {
  const [rows, setRows] = useState<Row[]>([]);
  const [progress, setProgress] = useState<
    Record<string, { received: number; total: number; done: boolean }>
  >({});

  async function refresh() {
    setRows(await ipc.whisper.list());
  }

  useEffect(() => {
    void refresh();
  }, []);

  useEffect(() => {
    const unlisten = listen<{
      id: string;
      received: number;
      total: number;
      done: boolean;
    }>("whisper:download", (event) => {
      setProgress((current) => ({
        ...current,
        [event.payload.id]: event.payload,
      }));
      if (event.payload.done) void refresh();
    });
    return () => {
      void unlisten.then((fn) => fn());
    };
  }, []);

  return (
    <div className="space-y-2">
      <h3 className="text-sm font-medium">Whisper 模型</h3>
      {rows.map(([model, installed]) => {
        const item = progress[model.id];
        const pct = item && item.total ? Math.floor((item.received / item.total) * 100) : 0;
        return (
          <div
            key={model.id}
            className="flex items-center justify-between gap-3 py-1 text-sm"
          >
            <span>
              {model.display_name}{" "}
              {installed && <span className="text-green-400">已安装</span>}
            </span>
            {!installed && (
              <Button
                size="sm"
                variant="outline"
                disabled={!!item && !item.done}
                onClick={() => void ipc.whisper.download(model.id)}
              >
                {item && !item.done ? `${pct}%` : "下载"}
              </Button>
            )}
          </div>
        );
      })}
    </div>
  );
}
