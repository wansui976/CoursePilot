import { useState } from "react";
import { qk } from "@/lib/queryKeys";
import { useTranslation } from "react-i18next";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Copy, RefreshCw, Trash2 } from "lucide-react";
import { Button } from "@/ui/button";
import { ViewHeader } from "@/ui/view-header";
import { ipc } from "@/lib/ipc";
import type { DevLogEntry, LlmUsageTotals } from "@/lib/types";

function statusClass(status: string): string {
  if (status.startsWith("已应用")) return "text-[var(--status-ok)] bg-[var(--status-ok-bg)]";
  return "text-red-500 bg-red-500/10";
}

function LogCard({ entry }: { entry: DevLogEntry }) {
  const { t } = useTranslation();
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
          {open ? t("devConsole.collapse") : t("devConsole.expand")}
        </span>
      </button>
      {open && (
        <div className="space-y-3 border-t border-[var(--border-subtle)] px-3 py-2.5">
          <div>
            <div className="mb-1 text-xs font-medium text-[var(--text-muted)]">
              {t("devConsole.request")}
            </div>
            <pre className="max-h-64 overflow-auto rounded-md bg-[var(--surface-input)] p-2 text-xs leading-relaxed text-[var(--text-normal)]">
              {entry.request}
            </pre>
          </div>
          <div>
            <div className="mb-1 text-xs font-medium text-[var(--text-muted)]">
              {t("devConsole.response")}
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
  const { t } = useTranslation();
  if (rows.length === 0) {
    return (
      <p className="text-xs text-[var(--text-faint)]">
        {t("devConsole.noUsage")}
      </p>
    );
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs">
        <thead className="text-[var(--text-muted)]">
          <tr className="text-left">
            <th className="py-1 pr-3 font-medium">{t("devConsole.colTier")}</th>
            <th className="py-1 pr-3 font-medium">{t("devConsole.colModel")}</th>
            <th className="py-1 pr-3 text-right font-medium">{t("devConsole.colCount")}</th>
            <th className="py-1 pr-3 text-right font-medium">{t("devConsole.colInput")}</th>
            <th className="py-1 pr-3 text-right font-medium">{t("devConsole.colCacheHit")}</th>
            <th className="py-1 pr-3 text-right font-medium">{t("devConsole.colOutput")}</th>
            <th className="py-1 text-right font-medium">{t("devConsole.colThinking")}</th>
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
  const { t } = useTranslation();
  const qc = useQueryClient();
  const { data: logs = [], isFetching } = useQuery({
    queryKey: qk.devLogs(),
    queryFn: ipc.dev.logs,
    refetchInterval: 3000,
  });
  const { data: usage = [] } = useQuery({
    queryKey: qk.llmUsage(),
    queryFn: ipc.dev.llmUsage,
    refetchInterval: 3000,
  });
  const clear = useMutation({
    mutationFn: async () => {
      await ipc.dev.clearLogs();
      await ipc.dev.clearLlmUsage();
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qk.devLogs() });
      qc.invalidateQueries({ queryKey: qk.llmUsage() });
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
      <ViewHeader
        title={t("devConsole.title")}
        onBack={onClose}
        backLabel={t("devConsole.back")}
        description={
          <>
            {t("devConsole.subtitle")}
            {logs.length > 0 && (
              <>
                {t("devConsole.total")}
                {logs.length}
                {t("devConsole.separator")}
                <span className="text-[var(--status-ok)]">{t("devConsole.applied", { count: applied })}</span>
                {" · "}
                <span className={failed > 0 ? "text-red-500" : ""}>{t("devConsole.failed", { count: failed })}</span>
              </>
            )}
          </>
        }
        actions={
          <div
            aria-label={t("devConsole.actions")}
            role="toolbar"
            className="flex items-center justify-end gap-2"
          >
            <Button
              size="sm"
              variant="outline"
              disabled={logs.length === 0}
              onClick={copyAll}
              aria-label={copied ? t("devConsole.copied") : t("devConsole.copyAll")}
              title={copied ? t("devConsole.copied") : t("devConsole.copyAll")}
            >
              {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
              <span className="max-[399px]:sr-only">
                {copied ? t("devConsole.copied") : t("devConsole.copyAll")}
              </span>
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => qc.invalidateQueries({ queryKey: qk.devLogs() })}
              aria-label={t("devConsole.refresh")}
              title={t("devConsole.refresh")}
            >
              <RefreshCw className={`h-3.5 w-3.5 ${isFetching ? "animate-spin" : ""}`} />
              <span className="max-[399px]:sr-only">{t("devConsole.refresh")}</span>
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={clear.isPending || (logs.length === 0 && usage.length === 0)}
              onClick={() => clear.mutate()}
              aria-label={t("devConsole.clear")}
              title={t("devConsole.clear")}
            >
              <Trash2 className="h-3.5 w-3.5" />
              <span className="max-[399px]:sr-only">{t("devConsole.clear")}</span>
            </Button>
          </div>
        }
      />

      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-4 sm:px-7 sm:py-6">
        <div className="mx-auto mb-6 max-w-3xl space-y-2">
          <h3 className="text-sm font-semibold text-[var(--text-strong)]">{t("devConsole.tokenUsage")}</h3>
          <p className="text-xs text-[var(--text-muted)]">
            {t("devConsole.tokenNote")}
          </p>
          <UsageTable rows={usage} />
        </div>
        <div className="mx-auto max-w-3xl space-y-2">
          <h3 className="text-sm font-semibold text-[var(--text-strong)]">{t("devConsole.correctionTitle")}</h3>
          {logs.length === 0 ? (
            <div className="flex h-full min-h-[240px] items-center justify-center text-center text-sm text-[var(--text-faint)]">
              {t("devConsole.noCorrections")}
            </div>
          ) : (
            logs.map((entry) => <LogCard key={entry.id} entry={entry} />)
          )}
        </div>
      </div>
    </div>
  );
}
