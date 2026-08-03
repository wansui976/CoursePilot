import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, ChevronLeft, Copy, RefreshCw, Terminal, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ipc } from "@/lib/ipc";
import type { DevLogEntry, LlmUsageTotals } from "@/lib/types";

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

function ratio(part: number, whole: number): string {
  if (whole <= 0) return "—";
  return `${Math.round((part / whole) * 100)}%`;
}

/**
 * 各档 LLM 调用的 token 用量。
 *
 * 三列是用来回答三个具体问题的：命中率说明共享前缀有没有真的生效（五个产物用的是
 * 同一份讲稿，第一次之后应该大比例命中）；输出说明纠错这类任务到底吐了多少字；
 * 「其中思考」是计费在输出里、但我们只读正式回答、并不使用的那部分——不为零就说明
 * 这一档路由到了推理模型，而那笔钱基本是白花的。
 */
function UsageTable({ rows }: { rows: LlmUsageTotals[] }) {
  if (rows.length === 0) {
    return (
      <p className="text-xs text-[var(--text-faint)]">
        还没有用量记录。跑一次 AI 生成或字幕纠错后，这里会按档显示 token 消耗。
        端点不返回用量时也会是空的。
      </p>
    );
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs">
        <thead className="text-[var(--text-muted)]">
          <tr className="text-left">
            <th className="py-1 pr-3 font-medium">档</th>
            <th className="py-1 pr-3 font-medium">模型</th>
            <th className="py-1 pr-3 text-right font-medium">次数</th>
            <th className="py-1 pr-3 text-right font-medium">输入</th>
            <th className="py-1 pr-3 text-right font-medium">命中缓存</th>
            <th className="py-1 pr-3 text-right font-medium">输出</th>
            <th className="py-1 text-right font-medium">其中思考</th>
          </tr>
        </thead>
        <tbody className="text-[var(--text-normal)]">
          {rows.map((row) => (
            <tr
              key={`${row.label}-${row.model}`}
              className="border-t border-[var(--border-subtle)]"
            >
              <td className="py-1 pr-3">{row.label}</td>
              <td className="py-1 pr-3 text-[var(--text-muted)]">{row.model}</td>
              <td className="py-1 pr-3 text-right tabular-nums">{row.calls}</td>
              <td className="py-1 pr-3 text-right tabular-nums">{row.prompt_tokens}</td>
              <td className="py-1 pr-3 text-right tabular-nums">
                {row.cached_tokens}
                <span className="ml-1 text-[var(--text-faint)]">
                  {ratio(row.cached_tokens, row.prompt_tokens)}
                </span>
              </td>
              <td className="py-1 pr-3 text-right tabular-nums">{row.completion_tokens}</td>
              <td
                className={`py-1 text-right tabular-nums ${
                  row.reasoning_tokens > 0 ? "text-[var(--status-warn)]" : ""
                }`}
              >
                {row.reasoning_tokens}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
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
  const { data: usage = [] } = useQuery({
    queryKey: ["llm-usage"],
    queryFn: ipc.dev.llmUsage,
    refetchInterval: 3000,
  });
  const clear = useMutation({
    mutationFn: async () => {
      await ipc.dev.clearLogs();
      await ipc.dev.clearLlmUsage();
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["dev-logs"] });
      qc.invalidateQueries({ queryKey: ["llm-usage"] });
    },
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
          disabled={clear.isPending || (logs.length === 0 && usage.length === 0)}
          onClick={() => clear.mutate()}
        >
          <Trash2 className="h-3.5 w-3.5" />
          清空
        </Button>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-7 py-6">
        <div className="mx-auto mb-6 max-w-3xl space-y-2">
          <h3 className="text-sm font-semibold text-[var(--text-strong)]">token 用量</h3>
          <p className="text-xs text-[var(--text-muted)]">
            按档累计，进程内统计、重启清空。只覆盖非流式调用（生成、纠错、提要、助手），
            流式的问答不在内。
          </p>
          <UsageTable rows={usage} />
        </div>
        <div className="mx-auto max-w-3xl space-y-2">
          <h3 className="text-sm font-semibold text-[var(--text-strong)]">纠错请求与回复</h3>
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
