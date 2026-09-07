import { useId, useState } from "react";
import {
  Check,
  ChevronRight,
  CircleAlert,
  CircleHelp,
  CircleStop,
  LoaderCircle,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import {
  reconcileAssistantToolRuns,
  type AssistantToolRun,
  type AssistantToolRunStatus,
} from "@/lib/assistantSession";

/**
 * 助手这一轮调了哪些工具，按调用顺序显示。
 *
 * 两点刻意的处理：
 *
 * 一是**用人话，不用函数名**。`search_bilibili` 是给模型看的标识符，
 * 摆在界面上只会让人去猜它是什么。
 *
 * 二是**默认收起来**。工具链是「回答怎么来的」的过程信息，不是结论本身；
 * 摊开着常驻，翻一屏回答要滚过好几排彩色标签。只调了一个工具时单独一行
 * 直接可读，调了多个才折叠成一行计数，点开才看明细。
 *
 * 三是状态降噪：完成/进行中保持中性灰，只有失败和停止才借用状态色；
 * 会改动东西的那几个仍用「准备」前缀的人话，别让人以为已经删了。
 */
interface CollapsedRun {
  name: string;
  status: AssistantToolRunStatus;
  count: number;
}

/** 只有工具和终态都相同才折叠；同名调用一成一败必须分别显示。 */
function collapseRuns(toolRuns: AssistantToolRun[]): CollapsedRun[] {
  const runs: CollapsedRun[] = [];
  for (const toolRun of toolRuns) {
    const last = runs[runs.length - 1];
    if (last && last.name === toolRun.name && last.status === toolRun.status) {
      last.count += 1;
    } else {
      runs.push({ name: toolRun.name, status: toolRun.status, count: 1 });
    }
  }
  return runs;
}

const STATUS_TEXT: Record<AssistantToolRunStatus, string> = {
  running: "text-[var(--text-muted)]",
  completed: "text-[var(--text-muted)]",
  failed: "text-[var(--status-err)]",
  canceled: "text-[var(--status-warn)]",
  unknown: "text-[var(--text-muted)]",
};

function statusIcon(status: AssistantToolRunStatus) {
  switch (status) {
    case "running":
      return <LoaderCircle className="h-3 w-3 animate-spin motion-reduce:animate-none" />;
    case "completed":
      return <Check className="h-3 w-3" />;
    case "failed":
      return <CircleAlert className="h-3 w-3" />;
    case "canceled":
      return <CircleStop className="h-3 w-3" />;
    case "unknown":
      return <CircleHelp className="h-3 w-3" />;
  }
}

export function AssistantToolChips({
  tools,
  toolRuns,
}: {
  tools: string[];
  toolRuns?: AssistantToolRun[];
}) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const listId = useId();
  const visibleRuns = reconcileAssistantToolRuns(tools, toolRuns ?? []);
  const runs = collapseRuns(visibleRuns);
  if (visibleRuns.length === 0) return null;

  const multi = visibleRuns.length > 1;
  const running = visibleRuns.find((run) => run.status === "running");
  const showList = !multi || expanded;

  return (
    <div data-testid="tool-chips" className="text-[11px]">
      {multi && (
        <button
          type="button"
          aria-expanded={showList}
          aria-controls={listId}
          onClick={() => setExpanded((value) => !value)}
          className="-ml-1 flex max-w-full items-center gap-1 rounded px-1 py-0.5 text-left text-[var(--text-faint)] transition-colors hover:text-[var(--text-strong)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)] motion-reduce:transition-none"
        >
          <ChevronRight
            aria-hidden="true"
            className={`h-3 w-3 flex-none transition-transform motion-reduce:transition-none ${
              showList ? "rotate-90" : ""
            }`}
          />
          {running && (
            <LoaderCircle
              className="h-3 w-3 flex-none animate-spin motion-reduce:animate-none"
              aria-hidden="true"
            />
          )}
          <span className="min-w-0 truncate">
            {running
              ? t("assistant.usingTool", {
                  tool: t(`assistantTools.${running.name}`, { defaultValue: running.name }),
                })
              : t("assistant.toolTraceSummary", { count: visibleRuns.length })}
          </span>
        </button>
      )}
      {showList && (
        <div
          id={multi ? listId : undefined}
          role="list"
          aria-label={t("assistant.toolTrace")}
          className={multi ? "mt-1 space-y-0.5" : ""}
        >
          {runs.map((run, i) => {
            const toolLabel = t(`assistantTools.${run.name}`, { defaultValue: run.name });
            const statusLabel = t(`assistant.toolRunStatus.${run.status}`);
            // 完成是默认预期，不必逐行写出来；只有没按预期走完的才值得多一个词。
            const explain = run.status === "failed" || run.status === "canceled";
            return (
              <span
                key={`${run.name}-${run.status}-${i}`}
                role="listitem"
                aria-label={
                  run.count > 1
                    ? t("assistant.toolRunStatusCount", {
                        tool: toolLabel,
                        status: statusLabel,
                        count: run.count,
                      })
                    : t("assistant.toolRunStatusLabel", {
                        tool: toolLabel,
                        status: statusLabel,
                      })
                }
                className={`flex items-center gap-1.5 py-0.5 ${STATUS_TEXT[run.status]}`}
              >
                <span aria-hidden="true" className="flex-none">
                  {statusIcon(run.status)}
                </span>
                <span className="min-w-0 truncate">{toolLabel}</span>
                {run.count > 1 && (
                  <span aria-hidden="true" className="flex-none">
                    ×{run.count}
                  </span>
                )}
                {explain && (
                  <span aria-hidden="true" className="flex-none">
                    {statusLabel}
                  </span>
                )}
              </span>
            );
          })}
        </div>
      )}
    </div>
  );
}
