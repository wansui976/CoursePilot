import { confirm as confirmDialog, message as messageDialog } from "@tauri-apps/plugin-dialog";
import { FolderOpen, MoreHorizontal, Pencil, Trash2 } from "lucide-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Fragment,
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { ipc } from "@/lib/ipc";
import { ErrorNote } from "@/components/ui/ErrorNote";
import { isIOS, pickDirectoryPath } from "@/lib/mobileFiles";

function nextCourseName(courses: { name: string }[]) {
  const names = new Set(courses.map((course) => course.name));
  if (!names.has("新课程")) return "新课程";
  let index = 2;
  while (names.has(`新课程 ${index}`)) index += 1;
  return `新课程 ${index}`;
}

/** 「新建课程」逻辑:目录选择 → 创建 → 刷新;供宽侧栏与窄屏课程页复用。 */
export function useCreateCourse() {
  const queryClient = useQueryClient();
  const { data: courses = [] } = useQuery({
    queryKey: ["courses"],
    queryFn: ipc.courses.list,
  });
  const [creatingCourse, setCreatingCourse] = useState(false);
  const [createError, setCreateError] = useState<Error | null>(null);

  async function createCourse() {
    if (creatingCourse) return;
    const name = nextCourseName(courses);
    try {
      setCreateError(null);
      setCreatingCourse(true);
      const dir = await pickDirectoryPath(["courses", name]);
      if (!dir) return;
      await ipc.courses.create(name, dir);
      await queryClient.invalidateQueries({ queryKey: ["courses"] });
    } catch (error) {
      setCreateError(error instanceof Error ? error : new Error(String(error)));
    } finally {
      setCreatingCourse(false);
    }
  }

  return { createCourse, creatingCourse, createError };
}

/** 课程列表:条目 + `…` 菜单(重命名/重选根目录/删除)+ iOS 左滑出菜单 + 空态。 */
export function CourseList({
  selectedCourseId,
  onSelect,
  queueOpen = false,
  selectedCourseExtra,
}: {
  selectedCourseId: string | null;
  onSelect: (id: string) => void;
  queueOpen?: boolean;
  /** 渲染在「选中课程」条目正下方(工作台内联视频列表插槽)。 */
  selectedCourseExtra?: ReactNode;
}) {
  const queryClient = useQueryClient();
  const {
    data: courses = [],
    isError: coursesError,
    error: coursesErrorObj,
    refetch: refetchCourses,
  } = useQuery({
    queryKey: ["courses"],
    queryFn: ipc.courses.list,
  });

  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const [swipedCourseId, setSwipedCourseId] = useState<string | null>(null);
  const swipeStart = useRef<{ id: string; x: number; y: number } | null>(null);

  useEffect(() => {
    if (menuFor && menuFor !== swipedCourseId) {
      setSwipedCourseId(menuFor);
    }
  }, [menuFor, swipedCourseId]);

  useEffect(() => {
    if (!isIOS()) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest("[data-course-menu]")) return;
      setSwipedCourseId(null);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, []);

  function closeMenu() {
    setMenuFor(null);
    setSwipedCourseId(null);
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
  const relink = useMutation({
    mutationFn: ({ id, root }: { id: string; root: string }) =>
      ipc.courses.relinkRoot(id, root),
    onSuccess: async (res, { id }) => {
      await queryClient.invalidateQueries({ queryKey: ["courses"] });
      await queryClient.invalidateQueries({ queryKey: ["videos", id] });
      await queryClient.invalidateQueries({ queryKey: ["media-url"] });
      const lines = [`已重连 ${res.relinked}/${res.total} 个视频`];
      if (res.missing.length)
        lines.push(`缺失 ${res.missing.length} 个：${res.missing.join("、")}`);
      if (res.ambiguous.length)
        lines.push(`重名跳过 ${res.ambiguous.length} 个：${res.ambiguous.join("、")}`);
      await messageDialog(lines.join("\n"), { title: "重新选择根目录" });
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

  async function handleRelinkRoot(id: string, name: string) {
    closeMenu();
    const dir = await pickDirectoryPath(["courses", name]);
    if (!dir) return;
    relink.mutate({ id, root: dir });
  }

  function startSwipe(courseId: string, event: ReactPointerEvent<HTMLDivElement>) {
    if (!isIOS()) return;
    if (event.pointerType === "mouse") return;
    swipeStart.current = { id: courseId, x: event.clientX, y: event.clientY };
  }

  function trackSwipe(courseId: string, event: ReactPointerEvent<HTMLDivElement>) {
    const start = swipeStart.current;
    if (!start || start.id !== courseId) return;
    if (event.pointerType === "mouse") return;
    const dx = start.x - event.clientX;
    const dy = Math.abs(start.y - event.clientY);
    if (dx > 30 && dy < 18) {
      setSwipedCourseId(courseId);
      setMenuFor(courseId);
    }
  }

  function endSwipe() {
    swipeStart.current = null;
  }

  return (
    <>
      {menuFor && (
        // 透明背板：点菜单外区域即关闭。
        <div className="fixed inset-0 z-10" onClick={closeMenu} />
      )}
      {courses.map((course) => {
        // 队列是当前视图时，课程不再算「选中」，避免与队列项同时高亮。
        const selected = course.id === selectedCourseId && !queueOpen;
        if (renamingId === course.id) {
          return (
            <Fragment key={course.id}>
              <input
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
              {selected && selectedCourseExtra}
            </Fragment>
          );
        }
        return (
          <Fragment key={course.id}>
            <div
              className={`ca-nav-item group relative ${selected ? "active" : ""}`}
              style={{ touchAction: "pan-y" }}
              onPointerDown={(event) => startSwipe(course.id, event)}
              onPointerMove={(event) => trackSwipe(course.id, event)}
              onPointerUp={endSwipe}
              onPointerCancel={endSwipe}
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
                data-course-menu
                onPointerDown={(event) => event.stopPropagation()}
                onClick={(e) => {
                  e.stopPropagation();
                  setMenuFor((id) => (id === course.id ? null : course.id));
                }}
                className={`ca-touch-44 mr-1 grid h-9 w-9 flex-none place-items-center rounded text-[var(--text-muted)] transition hover:bg-[var(--surface-card)] hover:text-[var(--text-strong)] ${
                  isIOS() || menuFor === course.id || swipedCourseId === course.id
                    ? "opacity-100"
                    : "opacity-0 group-hover:opacity-100"
                }`}
              >
                <MoreHorizontal className="h-5 w-5" />
              </button>
              {(menuFor === course.id || swipedCourseId === course.id) && (
                <div
                  data-course-menu
                  className="absolute right-1 top-full z-20 mt-1 w-40 overflow-hidden rounded-md border border-[var(--border-subtle)] bg-[var(--surface-panel)] py-1 shadow-[var(--shadow-pop)]"
                >
                  <button
                    onClick={() => startRename(course.id, course.name)}
                    className="ca-touch-44 flex min-h-11 w-full items-center gap-2 px-3 py-2 text-left text-sm text-[var(--text-normal)] hover:bg-[var(--surface-card-hover)]"
                  >
                    <Pencil className="h-4 w-4" />
                    重命名
                  </button>
                  <button
                    onClick={() => void handleRelinkRoot(course.id, course.name)}
                    className="ca-touch-44 flex min-h-11 w-full items-center gap-2 px-3 py-2 text-left text-sm text-[var(--text-normal)] hover:bg-[var(--surface-card-hover)]"
                  >
                    <FolderOpen className="h-4 w-4" />
                    重新选择根目录
                  </button>
                  <button
                    onClick={() => void confirmDelete(course.id, course.name)}
                    className="ca-touch-44 flex min-h-11 w-full items-center gap-2 px-3 py-2 text-left text-sm text-[var(--status-err)] hover:bg-[var(--surface-card-hover)]"
                  >
                    <Trash2 className="h-4 w-4" />
                    删除
                  </button>
                </div>
              )}
            </div>
            {selected && selectedCourseExtra}
          </Fragment>
        );
      })}
      {courses.length === 0 &&
        (coursesError ? (
          // 课程加载失败：显示错误 + 重试，而不是伪装成「还没有课程」。
          <ErrorNote error={coursesErrorObj} onRetry={() => refetchCourses()} />
        ) : (
          <div className="rounded-md border border-[var(--border-faint)] bg-[var(--surface-card)] px-3 py-4 text-xs leading-relaxed text-[var(--text-muted)]">
            选择一个课程文件夹后，视频会按课程归档。
          </div>
        ))}
    </>
  );
}
