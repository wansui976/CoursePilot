import { confirm as confirmDialog, open } from "@tauri-apps/plugin-dialog";
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
} from "lucide-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
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
  onOpenRecycleBin,
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
  onOpenRecycleBin?: () => void;
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
      <div className="mt-6 mb-2 px-1 text-xs font-medium text-[var(--text-faint)]">
        我的课程
      </div>
      <div className="min-h-0 flex-1 space-y-1 overflow-y-auto">
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
              className={`group relative flex items-center rounded-md transition ${
                selected
                  ? "bg-[var(--surface-card-active)] text-[var(--text-strong)] shadow-sm"
                  : "text-[var(--text-normal)] hover:bg-[var(--surface-card-hover)] hover:text-[var(--text-strong)]"
              }`}
            >
              <button
                onClick={() => onSelect(course.id)}
                className="flex min-w-0 flex-1 items-center gap-2 px-2.5 py-2.5 text-left text-sm"
              >
                <FolderOpen className="h-4 w-4 flex-none text-[var(--text-faint)]" />
                <span className="min-w-0 flex-1 truncate">{course.name}</span>
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
    </aside>
  );
}
