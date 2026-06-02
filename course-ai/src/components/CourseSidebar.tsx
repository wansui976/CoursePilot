import { open } from "@tauri-apps/plugin-dialog";
import { ClipboardList, FolderOpen, Library, Moon, Plus, Settings, Sun } from "lucide-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { ipc } from "@/lib/ipc";

export function CourseSidebar({
  selectedCourseId,
  onSelect,
  onOpenSettings,
  onToggleTheme,
  theme,
  themeToggleLabel,
  queueOpen = false,
  queueCount = 0,
  onToggleQueue,
  queuePanel,
}: {
  selectedCourseId: string | null;
  onSelect: (id: string) => void;
  onOpenSettings: () => void;
  onToggleTheme: () => void;
  theme: "dark" | "light";
  themeToggleLabel: string;
  queueOpen?: boolean;
  queueCount?: number;
  onToggleQueue?: () => void;
  queuePanel?: ReactNode;
}) {
  const queryClient = useQueryClient();
  const { data: courses = [] } = useQuery({
    queryKey: ["courses"],
    queryFn: ipc.courses.list,
  });
  const create = useMutation({
    mutationFn: async () => {
      const dir = await open({ directory: true, multiple: false });
      if (!dir || Array.isArray(dir)) return null;
      const name = dir.split(/[\\/]/).pop() || "Untitled";
      return ipc.courses.create(name, dir);
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["courses"] }),
  });

  return (
    <aside
      aria-label="课程侧栏"
      className="flex h-full w-[250px] flex-none flex-col border-r border-[var(--border-subtle)] bg-[var(--surface-sidebar)] px-3.5 py-[18px]"
    >
      <div className="flex-none">
        <div className="mb-4 flex items-center gap-2 text-[15px] font-semibold text-[var(--text-strong)]">
          <Library className="h-4 w-4 text-primary" />
          课程库
        </div>
        <Button
          aria-label="新建课程"
          className="h-10 w-full border border-dashed border-[var(--border-subtle)] bg-transparent text-[var(--text-normal)] hover:bg-[var(--surface-card-hover)] hover:text-[var(--text-strong)]"
          size="sm"
          variant="outline"
          onClick={() => create.mutate()}
        >
          <Plus className="h-4 w-4" />
          新建课程
        </Button>
        {onToggleQueue && (
          <Button
            aria-label="处理队列"
            className={`mt-2 h-9 w-full justify-start ${
              queueOpen
                ? "bg-[var(--surface-card-active)] text-[var(--text-strong)]"
                : "text-[var(--text-normal)]"
            }`}
            size="sm"
            variant="ghost"
            onClick={onToggleQueue}
          >
            <ClipboardList className="h-4 w-4" />
            处理队列
            {queueCount > 0 && (
              <span className="ml-auto rounded-full bg-primary/15 px-1.5 py-0.5 text-[11px] text-primary">
                {queueCount}
              </span>
            )}
          </Button>
        )}
      </div>
      {queueOpen && queuePanel}
      <div className="mt-6 mb-2 px-1 text-xs font-medium text-[var(--text-faint)]">
        我的课程
      </div>
      <div className="min-h-0 flex-1 space-y-1 overflow-y-auto">
        {courses.map((course) => (
          <button
            key={course.id}
            onClick={() => onSelect(course.id)}
            className={`flex w-full items-center gap-2 rounded-md px-2.5 py-2.5 text-left text-sm transition ${
              course.id === selectedCourseId
                ? "bg-[var(--surface-card-active)] text-[var(--text-strong)] shadow-sm"
                : "text-[var(--text-normal)] hover:bg-[var(--surface-card-hover)] hover:text-[var(--text-strong)]"
            }`}
          >
            <FolderOpen className="h-4 w-4 flex-none text-[var(--text-faint)]" />
            <span className="min-w-0 flex-1 truncate">{course.name}</span>
          </button>
        ))}
        {courses.length === 0 && (
          <div className="rounded-md border border-[var(--border-faint)] bg-[var(--surface-card)] px-3 py-4 text-xs leading-relaxed text-[var(--text-muted)]">
            选择一个课程文件夹后，视频会按课程归档。
          </div>
        )}
      </div>
      <div className="mt-4 flex flex-none items-center gap-2 border-t border-[var(--border-subtle)] pt-3">
        <Button
          size="icon"
          variant="ghost"
          onClick={onToggleTheme}
          title={themeToggleLabel}
          aria-label={themeToggleLabel}
        >
          {theme === "light" ? (
            <Moon className="h-4 w-4" />
          ) : (
            <Sun className="h-4 w-4" />
          )}
        </Button>
        <Button
          className="min-w-0 flex-1 justify-start"
          size="sm"
          variant="ghost"
          onClick={onOpenSettings}
        >
          <Settings className="h-4 w-4" />
          设置
        </Button>
      </div>
    </aside>
  );
}
