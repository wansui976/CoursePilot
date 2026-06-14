import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, ChevronLeft, Copy, RefreshCw, Terminal, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ipc } from "@/lib/ipc";
import type { DevLogEntry } from "@/lib/types";

function statusClass(status: string): string {
  if (status.startsWith("已应用")) return "text-[var(--status-ok)] bg-[var(--status-ok-bg)]";
  return "text-red-500 bg-red-500/10";
}

function LogCard({ entry }: { entry: DevLogEntry }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-card)]">
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-3 px-3 py-2 text-left"
      >
        <span
          className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-medium ${statusClass(
            entry.status,
          )}`}
        >
          {entry.status}
        </span>
        <span className="min-w-0 flex-1 truncate text-xs text-[var(--text-muted)]">
          {entry.kind} · {new Date(entry.at_ms).toLocaleTimeString()}
        </span>
        <span className="shrink-0 text-xs text-[var(--text-faint)]">
          {open ? "收起" : "展开"}
        </span>
      </button>
      {open && (
        <div className="space-y-3 border-t border-[var(--border-subtle)] px-3 py-2.5">
          <div>
            <div className="mb-1 text-xs font-medium text-[var(--text-muted)]">
              发送给模型（原始分段）
            </div>
            <pre className="max-h-64 overflow-auto rounded-md bg-[var(--surface-input)] p-2 text-xs leading-relaxed text-[var(--text-normal)]">
              {entry.request}
            </pre>
          </div>
          <div>
            <div className="mb-1 text-xs font-medium text-[var(--text-muted)]">
              模型回复（纠正结果）
            </div>
            <pre className="max-h-64 overflow-auto rounded-md bg-[var(--surface-input)] p-2 text-xs leading-relaxed text-[var(--text-normal)]">
              {entry.response}
            </pre>
          </div>
        </div>
      )}
    </div>
  );
}

export function DevConsole({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const { data: logs = [], isFetching } = useQuery({
    queryKey: ["dev-logs"],
    queryFn: ipc.dev.logs,
    refetchInterval: 3000,
  });
  const clear = useMutation({
    mutationFn: ipc.dev.clearLogs,
    onSuccess: () => qc.invalidateQueries({ queryKey: ["dev-logs"] }),
  });
  const [copied, setCopied] = useState(false);

  const applied = logs.filter((l) => l.status.startsWith("已应用")).length;
  const failed = logs.length - applied;

  async function copyAll() {
    const text = logs
      .map(
        (l) =>
          `[${new Date(l.at_ms).toLocaleTimeString()}] ${l.status}\n请求:\n${l.request}\n回复:\n${l.response}\n`,
      )
      .join("\n----------\n");
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* ignore */
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col bg-[var(--surface-app)] text-[var(--text-normal)]">
      <header className="flex flex-none items-center gap-3 border-b border-[var(--border-subtle)] bg-[var(--surface-header)] px-7 py-4">
        <button
          aria-label="返回"
          onClick={onClose}
          className="ca-icon-btn ca-touch-44 ml-0"
        >
          <ChevronLeft className="h-5 w-5" />
        </button>
        <div className="min-w-0 flex-1">
          <h2 className="flex items-center gap-2 text-lg font-semibold text-[var(--text-strong)]">
            <Terminal className="h-4 w-4" />
            开发控制台
          </h2>
          <p className="mt-0.5 text-xs text-[var(--text-muted)]">
            AI 文稿纠错的请求与回复（每 3 秒刷新，仅保留最近 200 条，重启清空）
            {logs.length > 0 && (
              <>
                {" · 共 "}
                {logs.length}
                {" 条 · "}
                <span className="text-[var(--status-ok)]">已应用 {applied}</span>
                {" · "}
                <span className={failed > 0 ? "text-red-500" : ""}>失败 {failed}</span>
              </>
            )}
          </p>
        </div>
        <Button size="sm" variant="outline" disabled={logs.length === 0} onClick={copyAll}>
          {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
          {copied ? "已复制" : "复制全部"}
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={() => qc.invalidateQueries({ queryKey: ["dev-logs"] })}
        >
          <RefreshCw className={`h-3.5 w-3.5 ${isFetching ? "animate-spin" : ""}`} />
          刷新
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={clear.isPending || logs.length === 0}
          onClick={() => clear.mutate()}
        >
          <Trash2 className="h-3.5 w-3.5" />
          清空
        </Button>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-7 py-6">
        <div className="mx-auto max-w-3xl space-y-2">
          {logs.length === 0 ? (
            <div className="flex h-full min-h-[240px] items-center justify-center text-center text-sm text-[var(--text-faint)]">
              还没有 AI 纠错记录。处理一个视频后（且已配置大模型），
              这里会显示每批发送的原文和模型返回的纠正结果。
            </div>
          ) : (
            logs.map((entry) => <LogCard key={entry.id} entry={entry} />)
          )}
        </div>
      </div>
    </div>
  );
}
