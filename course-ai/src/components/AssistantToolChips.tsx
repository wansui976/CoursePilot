import {
  BookOpen,
  Download,
  FolderPlus,
  Gauge,
  ListChecks,
  ListVideo,
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

/** 相邻的同一个工具折叠成「×N」。连着搜三次就该显示「搜索 B 站 ×3」，而不是三颗一样的。 */
function collapseRuns(tools: string[]): { name: string; count: number }[] {
  const runs: { name: string; count: number }[] = [];
  for (const name of tools) {
    const last = runs[runs.length - 1];
    if (last && last.name === name) last.count += 1;
    else runs.push({ name, count: 1 });
  }
  return runs;
}

export function AssistantToolChips({ tools }: { tools: string[] }) {
  const { t } = useTranslation();
  if (tools.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-1" data-testid="tool-chips">
      {collapseRuns(tools).map((run, i) => {
        return (
          <span
            key={`${run.name}-${i}`}
            className="inline-flex items-center gap-1 rounded-full border border-[var(--border-subtle)] bg-[var(--surface-input)] px-2 py-0.5 text-[11px] text-[var(--text-muted)]"
          >
            {ICONS[run.name] ?? <Wrench className="h-3 w-3" />}
            {t(`assistantTools.${run.name}`, { defaultValue: run.name })}
            {run.count > 1 && <span className="text-[var(--text-faint)]">×{run.count}</span>}
          </span>
        );
      })}
    </div>
  );
}
