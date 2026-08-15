import {
  BookOpen,
  Check,
  CircleAlert,
  CircleHelp,
  CircleStop,
  Download,
  FolderPlus,
  Gauge,
  ListChecks,
  ListVideo,
  LoaderCircle,
  Navigation,
  PenLine,
  Play,
  Search,
  Settings2,
  Sparkles,
  Target,
  Trash2,
  Wrench,
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
 * 二是会改动东西的那几个一律加「准备」前缀。它们只生成了确认卡、什么都没做，
 * 而写成「删除视频」会让人以为已经删了——助手底下紧跟着的确认卡就白设了。
 */
const ICONS: Record<string, React.ReactNode> = {
  list_courses: <ListVideo className="h-3 w-3" />,
  list_videos: <ListVideo className="h-3 w-3" />,
  get_course_outline: <BookOpen className="h-3 w-3" />,
  get_study_progress: <Gauge className="h-3 w-3" />,
  resume_learning: <Play className="h-3 w-3" />,
  list_weak_concepts: <Target className="h-3 w-3" />,
  list_due_reviews: <ListChecks className="h-3 w-3" />,
  search_content: <Search className="h-3 w-3" />,
  search_bilibili: <Search className="h-3 w-3" />,
  open_video: <Navigation className="h-3 w-3" />,
  seek_to: <Navigation className="h-3 w-3" />,
  set_theme: <Sparkles className="h-3 w-3" />,
  rename_video: <PenLine className="h-3 w-3" />,
  rename_course: <PenLine className="h-3 w-3" />,
  delete_video: <Trash2 className="h-3 w-3" />,
  update_setting: <Settings2 className="h-3 w-3" />,
  create_course: <FolderPlus className="h-3 w-3" />,
  import_video: <Download className="h-3 w-3" />,
};

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

const STATUS_STYLES: Record<AssistantToolRunStatus, string> = {
  running: "border-[var(--accent-text)] bg-[var(--accent-weak)]",
  completed: "border-[var(--status-ok)] bg-[var(--status-ok-bg)]",
  failed: "border-[var(--status-err)] bg-[var(--status-err-bg)]",
  canceled: "border-[var(--status-warn)] bg-[var(--status-warn-bg)]",
  unknown: "border-[var(--border-subtle)] bg-[var(--surface-input)]",
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
  const visibleRuns = reconcileAssistantToolRuns(tools, toolRuns ?? []);
  if (visibleRuns.length === 0) return null;
  return (
    <div
      className="flex flex-wrap gap-1"
      data-testid="tool-chips"
      role="list"
      aria-label={t("assistant.toolTrace")}
    >
      {collapseRuns(visibleRuns).map((run, i) => {
        const toolLabel = t(`assistantTools.${run.name}`, { defaultValue: run.name });
        const statusLabel = t(`assistant.toolRunStatus.${run.status}`);
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
            className={`inline-flex min-h-6 items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] text-[var(--text-strong)] ${STATUS_STYLES[run.status]}`}
          >
            <span aria-hidden="true">{ICONS[run.name] ?? <Wrench className="h-3 w-3" />}</span>
            <span>{toolLabel}</span>
            {run.count > 1 && <span aria-hidden="true">×{run.count}</span>}
            <span className="inline-flex items-center gap-0.5" aria-hidden="true">
              {statusIcon(run.status)}
              {statusLabel}
            </span>
          </span>
        );
      })}
    </div>
  );
}
