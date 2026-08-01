import {
  Download,
  FolderPlus,
  Gauge,
  ListChecks,
  ListVideo,
  Navigation,
  PenLine,
  Search,
  Settings2,
  Sparkles,
  Trash2,
  Wrench,
} from "lucide-react";

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
const LABELS: Record<string, { text: string; icon: React.ReactNode }> = {
  list_courses: { text: "查看课程", icon: <ListVideo className="h-3 w-3" /> },
  list_videos: { text: "查看视频列表", icon: <ListVideo className="h-3 w-3" /> },
  get_study_progress: { text: "读取学习进度", icon: <Gauge className="h-3 w-3" /> },
  list_due_reviews: { text: "查看待复习", icon: <ListChecks className="h-3 w-3" /> },
  search_content: { text: "搜索课程内容", icon: <Search className="h-3 w-3" /> },
  search_bilibili: { text: "搜索 B 站", icon: <Search className="h-3 w-3" /> },
  open_video: { text: "打开视频", icon: <Navigation className="h-3 w-3" /> },
  seek_to: { text: "跳转", icon: <Navigation className="h-3 w-3" /> },
  set_theme: { text: "切换主题", icon: <Sparkles className="h-3 w-3" /> },
  rename_video: { text: "准备改名", icon: <PenLine className="h-3 w-3" /> },
  rename_course: { text: "准备课程改名", icon: <PenLine className="h-3 w-3" /> },
  delete_video: { text: "准备删除", icon: <Trash2 className="h-3 w-3" /> },
  update_setting: { text: "准备改设置", icon: <Settings2 className="h-3 w-3" /> },
  create_course: { text: "准备新建课程", icon: <FolderPlus className="h-3 w-3" /> },
  import_video: { text: "准备导入", icon: <Download className="h-3 w-3" /> },
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
  if (tools.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-1" data-testid="tool-chips">
      {collapseRuns(tools).map((run, i) => {
        const label = LABELS[run.name];
        return (
          <span
            key={`${run.name}-${i}`}
            className="inline-flex items-center gap-1 rounded-full border border-[var(--border-subtle)] bg-[var(--surface-input)] px-2 py-0.5 text-[11px] text-[var(--text-muted)]"
          >
            {label?.icon ?? <Wrench className="h-3 w-3" />}
            {label?.text ?? run.name}
            {run.count > 1 && <span className="text-[var(--text-faint)]">×{run.count}</span>}
          </span>
        );
      })}
    </div>
  );
}
