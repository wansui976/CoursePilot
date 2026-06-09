import { confirm as confirmDialog } from "@tauri-apps/plugin-dialog";
import {
  ClipboardList,
  FolderOpen,
  Library,
  MoreHorizontal,
  Moon,
  Pencil,
  Plus,
  Settings,
  Sun,
  Trash2,
  X,
} from "lucide-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { ipc } from "@/lib/ipc";
import { pickDirectoryPath } from "@/lib/mobileFiles";
import { cn } from "@/lib/utils";

function nextCourseName(courses: { name: string }[]) {
  const names = new Set(courses.map((course) => course.name));
  if (!names.has("新课程")) return "新课程";
  let index = 2;
  while (names.has(`新课程 ${index}`)) index += 1;
  return `新课程 ${index}`;
}

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
  onOpenRecycleBin,
  onCloseDrawer,
  className,
  variant = "sidebar",
}: {
  selectedCourseId: string | null;
  onSelect: (id: string) => void;
  onOpenSettings?: () => void;
  onToggleTheme?: () => void;
  theme: "dark" | "light";
  themeToggleLabel: string;
  queueOpen?: boolean;
  queueCount?: number;
  onToggleQueue?: () => void;
  onOpenRecycleBin?: () => void;
  onCloseDrawer?: () => void;
  className?: string;
  variant?: "sidebar" | "screen";
}) {
  const queryClient = useQueryClient();
  const { data: courses = [] } = useQuery({
    queryKey: ["courses"],
    queryFn: ipc.courses.list,
  });
  const create = useMutation({
    mutationFn: async () => {
      const name = nextCourseName(courses);
      const dir = await pickDirectoryPath(["courses", name]);
      if (!dir) return null;
      return ipc.courses.create(name, dir);
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["courses"] }),
  });

  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");

  function closeMenu() {
    setMenuFor(null);
  }

  const rename = useMutation({
    mutationFn: ({ id, name }: { id: string; name: string }) =>
      ipc.courses.rename(id, name),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["courses"] }),
  });
  const remove = useMutation({
    mutationFn: (id: string) => ipc.courses.delete(id),
    onSuccess: (_data, id) => {
      queryClient.invalidateQueries({ queryKey: ["courses"] });
      if (id === selectedCourseId) {
        const next = courses.find((course) => course.id !== id);
        if (next) onSelect(next.id);
      }
    },
  });

  function startRename(id: string, name: string) {
    closeMenu();
    setRenamingId(id);
    setRenameDraft(name);
  }
  function commitRename() {
    const name = renameDraft.trim();
    if (renamingId && name) rename.mutate({ id: renamingId, name });
    setRenamingId(null);
  }
  async function confirmDelete(id: string, name: string) {
    closeMenu();
    const ok = await confirmDialog(
      `删除课程「${name}」？\n该课程下的视频会移入回收站，可在 30 天内恢复。`,
      { title: "删除课程", kind: "warning", okLabel: "删除", cancelLabel: "取消" },
    );
    if (ok) remove.mutate(id);
  }

  return (
    <aside
      aria-label="课程侧栏"
      className={cn(
        variant === "screen" ? "ca-course-screen" : "ca-side",
        className,
      )}
    >
      <div className="flex-none">
        <div className="ca-brand">
          <div className="logo">
            <Library className="h-4 w-4" />
          </div>
          <div className="label">
            <h1>课程库</h1>
          </div>
          {onCloseDrawer && (
            <button
              type="button"
              aria-label="关闭课程库"
              className="ca-icon-btn ml-auto"
              onClick={onCloseDrawer}
            >
              <X className="h-4 w-4" />
            </button>
          )}
          {variant === "screen" && onOpenRecycleBin && (
            <button
              type="button"
              aria-label="回收站"
              title="回收站"
              className="ca-icon-btn ml-auto"
              onClick={onOpenRecycleBin}
            >
              <Trash2 className="h-4 w-4" />
            </button>
          )}
        </div>
        <Button
          aria-label="新建课程"
          className="ca-new-btn"
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
            className={`ca-nav-item mt-2 ${queueOpen ? "active" : ""}`}
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
      <div className="ca-nav-label">
        我的课程
      </div>
      <div className="ca-nav">
        {menuFor && (
          // 透明背板：点菜单外区域即关闭。
          <div className="fixed inset-0 z-10" onClick={closeMenu} />
        )}
        {courses.map((course) => {
          const selected = course.id === selectedCourseId;
          if (renamingId === course.id) {
            return (
              <input
                key={course.id}
                aria-label="重命名课程"
                autoFocus
                value={renameDraft}
                onChange={(e) => setRenameDraft(e.target.value)}
                onBlur={commitRename}
                onKeyDown={(e) => {
                  if (e.key === "Enter") commitRename();
                  if (e.key === "Escape") setRenamingId(null);
                }}
                className="w-full rounded-md border border-[var(--accent-text)] bg-[var(--surface-input)] px-2.5 py-2 text-sm text-[var(--text-strong)] outline-none"
              />
            );
          }
          return (
            <div
              key={course.id}
              className={`ca-nav-item group relative ${selected ? "active" : ""}`}
            >
              <button
                onClick={() => onSelect(course.id)}
                className="ca-nav-button"
              >
                <FolderOpen className="ic h-4 w-4" />
                <span className="nm">{course.name}</span>
              </button>
              <button
                aria-label="课程操作"
                onClick={(e) => {
                  e.stopPropagation();
                  setMenuFor((id) => (id === course.id ? null : course.id));
                }}
                className={`mr-1 grid h-7 w-7 flex-none place-items-center rounded text-[var(--text-muted)] transition hover:bg-[var(--surface-card)] hover:text-[var(--text-strong)] ${
                  menuFor === course.id ? "opacity-100" : "opacity-0 group-hover:opacity-100"
                }`}
              >
                <MoreHorizontal className="h-4 w-4" />
              </button>
              {menuFor === course.id && (
                <div className="absolute right-1 top-full z-20 mt-1 w-36 overflow-hidden rounded-md border border-[var(--border-subtle)] bg-[var(--surface-panel)] py-1 shadow-[var(--shadow-pop)]">
                  <button
                    onClick={() => startRename(course.id, course.name)}
                    className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm text-[var(--text-normal)] hover:bg-[var(--surface-card-hover)]"
                  >
                    <Pencil className="h-3.5 w-3.5" />
                    重命名
                  </button>
                  <button
                    onClick={() => void confirmDelete(course.id, course.name)}
                    className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm text-red-500 hover:bg-[var(--surface-card-hover)]"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                    删除
                  </button>
                </div>
              )}
            </div>
          );
        })}
        {courses.length === 0 && (
          <div className="rounded-md border border-[var(--border-faint)] bg-[var(--surface-card)] px-3 py-4 text-xs leading-relaxed text-[var(--text-muted)]">
            选择一个课程文件夹后，视频会按课程归档。
          </div>
        )}
      </div>
      {variant !== "screen" && (
        <div className="mt-4 flex flex-none flex-wrap items-center gap-2 border-t border-[var(--border-subtle)] pt-3">
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
          {onOpenRecycleBin && (
            <Button
              size="icon"
              variant="ghost"
              onClick={onOpenRecycleBin}
              title="回收站"
              aria-label="回收站"
            >
              <Trash2 className="h-4 w-4" />
            </Button>
          )}
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
      )}
    </aside>
  );
}
