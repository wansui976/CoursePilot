import { listen } from "@tauri-apps/api/event";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { ipc, type WhisperModel } from "@/lib/ipc";
import { isMobile } from "@/lib/platform";

type Row = [WhisperModel, boolean];

function formatBytes(bytes: number) {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) return `${Math.round(bytes / 1024 ** 2)} MB`;
  return `${bytes} B`;
}

export function WhisperModelsPanel() {
  if (isMobile()) return null;
  return <WhisperModelsPanelDesktop />;
}

function WhisperModelsPanelDesktop() {
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
    <div className="space-y-1 rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-input)] p-3">
      <h4 className="mb-1 text-xs font-medium text-[var(--text-muted)]">
        Whisper 模型
      </h4>
      {rows.map(([model, installed]) => {
        const item = progress[model.id];
        const pct = item && item.total ? Math.floor((item.received / item.total) * 100) : 0;
        return (
          <div
            key={model.id}
            className="flex items-center justify-between gap-3 py-1 text-sm text-[var(--text-normal)]"
          >
            <span className="flex items-center gap-2">
              {model.display_name}
              {/* 体积帮助用户在下载前掂量（large 类模型 GB 级）。 */}
              <span className="text-xs text-[var(--text-faint)]">
                {formatBytes(model.size_bytes)}
              </span>
              {installed && (
                <span className="inline-flex items-center rounded-full bg-[var(--status-ok-bg)] px-1.5 py-0.5 text-xs font-medium text-[var(--status-ok)]">
                  已安装
                </span>
              )}
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
