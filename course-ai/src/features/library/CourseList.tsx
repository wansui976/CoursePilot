import { confirm as confirmDialog, message as messageDialog } from "@tauri-apps/plugin-dialog";
import { queries } from "@/lib/queries";
import { qk } from "@/lib/queryKeys";
import { FolderOpen, MoreHorizontal, Pencil, Trash2 } from "lucide-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Fragment,
  useCallback,
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { ipc } from "@/lib/ipc";
import type { Course } from "@/lib/types";
import { ErrorNote } from "@/ui/ErrorNote";
import { Skeleton } from "@/ui/skeleton";
import { isIOS, pickDirectoryPath } from "@/lib/mobileFiles";

function nextCourseName(courses: { name: string }[], t: (key: string, opts?: Record<string, unknown>) => string) {
  const names = new Set(courses.map((course) => course.name));
  const baseName = t("courseList.newCourse");
  if (!names.has(baseName)) return baseName;
  let index = 2;
  while (names.has(t("courseList.newCourseN", { index }))) index += 1;
  return t("courseList.newCourseN", { index });
}

/** 「添加课程文件夹」逻辑:目录选择 → 创建 → 刷新;供各个课程入口复用。 */
export function useCreateCourse() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { data: courses = [] } = useQuery(queries.courses());
  const [creatingCourse, setCreatingCourse] = useState(false);
  const [createError, setCreateError] = useState<Error | null>(null);

  async function createCourse() {
    if (creatingCourse) return;
    const name = nextCourseName(courses, t);
    try {
      setCreateError(null);
      setCreatingCourse(true);
      const dir = await pickDirectoryPath(["courses", name]);
      if (!dir) return;
      await ipc.courses.create(name, dir);
      await queryClient.invalidateQueries({ queryKey: qk.courses() });
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
  selectedCourseWatchedRatio,
  onSelect,
  onClearSelection,
  queueOpen = false,
  selectedCourseExtra,
  onTransientCloseChange,
}: {
  selectedCourseId: string | null;
  /** 选中课程已看完比例（0-1）；null = 没有数据（仅显示集数）。 */
  selectedCourseWatchedRatio?: number | null;
  onSelect: (id: string) => void;
  onClearSelection?: () => void;
  queueOpen?: boolean;
  /** 渲染在「选中课程」条目正下方(工作台内联视频列表插槽)。 */
  selectedCourseExtra?: ReactNode;
  /** 窄屏根页把临时菜单纳入系统返回层级；打开时注册关闭函数，收起时注销。 */
  onTransientCloseChange?: (close: (() => void) | null) => void;
}) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const {
    data: courses = [],
    isPending: coursesPending,
    isError: coursesError,
    error: coursesErrorObj,
    refetch: refetchCourses,
  } = useQuery(queries.courses());

  const [menuFor, setMenuFor] = useState<string | null>(null);
  // 打开时记录触发按钮的屏幕坐标：菜单 portal 到 body 用 fixed 定位，
  // 不再被 `.ca-nav`（overflow-y:auto）滚动容器裁掉。
  const [menuAnchor, setMenuAnchor] = useState<DOMRect | null>(null);
  const menuButtonRefs = useRef(new Map<string, HTMLButtonElement | null>());
  const menuRef = useRef<HTMLDivElement | null>(null);
  const renameOriginRef = useRef<HTMLButtonElement | null>(null);
  const skipRenameBlurRef = useRef(false);
  const renamePendingRef = useRef(false);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const [swipedCourseId, setSwipedCourseId] = useState<string | null>(null);
  const swipeStart = useRef<{ id: string; x: number; y: number } | null>(null);

  function openMenuFor(courseId: string, button?: HTMLButtonElement | null) {
    const el = button ?? menuButtonRefs.current.get(courseId);
    if (el) setMenuAnchor(el.getBoundingClientRect());
    setMenuFor(courseId);
  }

  /** 课程条目的集数/进度：非选中课程只显示集数；选中课程有观看记录时追加百分比，
   *  全部看完只显示 ✓。 */
  function renderCourseMeta(course: Course) {
    if (course.video_count <= 0) return null;
    const isSelected = course.id === selectedCourseId;
    if (isSelected && selectedCourseWatchedRatio != null) {
      if (selectedCourseWatchedRatio >= 1) {
        return (
          <span className="course-meta" aria-label={t("courseList.allWatched")}>
            <span className="pct">✓</span>
          </span>
        );
      }
      if (selectedCourseWatchedRatio > 0) {
        return (
          <span className="course-meta">
            {t("courseList.videoCountShort", { count: course.video_count })}
            <span className="pct">·{Math.round(selectedCourseWatchedRatio * 100)}%</span>
          </span>
        );
      }
    }
    return (
      <span className="course-meta">
        {t("courseList.videoCountShort", { count: course.video_count })}
      </span>
    );
  }

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

  const closeMenu = useCallback(() => {
    setMenuFor(null);
    setMenuAnchor(null);
    setSwipedCourseId(null);
  }, []);

  const closeMenuAndRestoreFocus = useCallback(() => {
    const courseId = menuFor;
    closeMenu();
    if (courseId) {
      queueMicrotask(() => menuButtonRefs.current.get(courseId)?.focus());
    }
  }, [closeMenu, menuFor]);

  const cancelRenameAndRestoreFocus = useCallback(() => {
    if (renamePendingRef.current) return;
    const courseId = renamingId;
    skipRenameBlurRef.current = true;
    setRenamingId(null);
    setRenameDraft("");
    if (courseId) {
      queueMicrotask(() => {
        const origin = renameOriginRef.current;
        const target = origin?.isConnected
          ? origin
          : menuButtonRefs.current.get(courseId);
        target?.focus();
      });
    }
  }, [renamingId]);

  useEffect(() => {
    if (!menuFor || !menuAnchor) return;
    menuRef.current
      ?.querySelector<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')
      ?.focus();
  }, [menuAnchor, menuFor]);

  useEffect(() => {
    if (!onTransientCloseChange) return;
    onTransientCloseChange(
      menuFor
        ? closeMenuAndRestoreFocus
        : renamingId
          ? cancelRenameAndRestoreFocus
          : null,
    );
    return () => onTransientCloseChange(null);
  }, [
    cancelRenameAndRestoreFocus,
    closeMenuAndRestoreFocus,
    menuFor,
    onTransientCloseChange,
    renamingId,
  ]);

  const rename = useMutation({
    mutationFn: ({ id, name }: { id: string; name: string }) =>
      ipc.courses.rename(id, name),
    onSuccess: async (_data, { id }) => {
      await queryClient.invalidateQueries({ queryKey: qk.courses() });
      setRenamingId(null);
      setRenameDraft("");
      queueMicrotask(() => menuButtonRefs.current.get(id)?.focus());
    },
  });
  renamePendingRef.current = rename.isPending;
  const remove = useMutation({
    mutationFn: (id: string) => ipc.courses.delete(id),
    onSuccess: (_data, id) => {
      queryClient.invalidateQueries({ queryKey: qk.courses() });
      if (id === selectedCourseId) {
        const next = courses.find((course) => course.id !== id);
        if (next) onSelect(next.id);
        else onClearSelection?.();
      }
    },
  });
  const relink = useMutation({
    mutationFn: ({ id, root }: { id: string; root: string }) =>
      ipc.courses.relinkRoot(id, root),
    onSuccess: async (res, { id }) => {
      await queryClient.invalidateQueries({ queryKey: qk.courses() });
      await queryClient.invalidateQueries({ queryKey: qk.videos.list(id) });
      await queryClient.invalidateQueries({ queryKey: qk.mediaUrl.all() });
      const lines = [t("courseList.relinkResult", { relinked: res.relinked, total: res.total })];
      if (res.missing.length)
        lines.push(t("courseList.relinkMissing", { count: res.missing.length, names: res.missing.join("、") }));
      if (res.ambiguous.length)
        lines.push(t("courseList.relinkAmbiguous", { count: res.ambiguous.length, names: res.ambiguous.join("、") }));
      await messageDialog(lines.join("\n"), { title: t("courseList.relinkRoot") });
    },
  });

  function startRename(id: string, name: string) {
    renameOriginRef.current = menuButtonRefs.current.get(id) ?? null;
    skipRenameBlurRef.current = false;
    closeMenu();
    rename.reset();
    setRenamingId(id);
    setRenameDraft(name);
  }
  function commitRename() {
    if (skipRenameBlurRef.current) {
      skipRenameBlurRef.current = false;
      return;
    }
    if (rename.isPending) return;
    const name = renameDraft.trim();
    if (renamingId && name) rename.mutate({ id: renamingId, name });
  }
  async function confirmDelete(course: Course) {
    closeMenu();
    const ok = await confirmDialog(
      t("courseList.deleteCourseConfirm", {
        name: course.name,
        path: course.root_path,
        count: course.video_count,
      }),
      { title: t("courseList.deleteCourseTitle"), kind: "warning", okLabel: t("courseList.delete"), cancelLabel: t("courseList.cancel") },
    );
    if (ok) remove.mutate(course.id);
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
      openMenuFor(courseId);
    }
  }

  function endSwipe() {
    swipeStart.current = null;
  }

  const openCourse = courses.find((course) => course.id === menuFor) ?? null;

  return (
    <>
      {courses.map((course) => {
        // 队列是当前视图时，课程不再算「选中」，避免与队列项同时高亮。
        const selected = course.id === selectedCourseId && !queueOpen;
        if (renamingId === course.id) {
          return (
            <Fragment key={course.id}>
              <input
                aria-label={t("courseList.renameCourse")}
                autoFocus
                value={renameDraft}
                onChange={(e) => setRenameDraft(e.target.value)}
                onBlur={commitRename}
                disabled={rename.isPending}
                onKeyDown={(e) => {
                  if (e.key === "Enter") commitRename();
                  if (e.key === "Escape") {
                    e.preventDefault();
                    e.stopPropagation();
                    cancelRenameAndRestoreFocus();
                  }
                }}
                className="w-full rounded-md border border-[var(--accent-text)] bg-[var(--surface-input)] px-2.5 py-2 text-sm text-[var(--text-strong)] outline-none"
              />
              {rename.isError && rename.variables?.id === course.id && (
                <ErrorNote className="mx-1 mt-1" error={rename.error} />
              )}
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
                aria-current={selected ? "page" : undefined}
                className="ca-nav-button"
              >
                <FolderOpen className="ic h-4 w-4" />
                <span className="nm">{course.name}</span>
                {renderCourseMeta(course)}
              </button>
              <button
                aria-label={t("courseList.courseActions")}
                aria-haspopup="menu"
                aria-expanded={menuFor === course.id}
                aria-controls={menuFor === course.id ? `course-actions-${course.id}` : undefined}
                data-course-menu
                // 常显（iOS）时按钮仍占位；否则悬停时叠在集数上方，不挤占课程名的宽度。
                data-persistent={isIOS() || undefined}
                ref={(el) => {
                  if (el) menuButtonRefs.current.set(course.id, el);
                  else menuButtonRefs.current.delete(course.id);
                }}
                onPointerDown={(event) => event.stopPropagation()}
                onClick={(e) => {
                  e.stopPropagation();
                  if (menuFor === course.id) closeMenu();
                  else openMenuFor(course.id, e.currentTarget);
                }}
                className={`ca-touch-44 mr-1 grid h-9 w-9 flex-none place-items-center rounded text-[var(--text-muted)] transition hover:bg-[var(--surface-card)] hover:text-[var(--text-strong)] ${
                  isIOS() || menuFor === course.id || swipedCourseId === course.id
                    ? "opacity-100"
                    : // 键盘聚焦本行时也显现（group-focus-within），否则 Tab 到的是不可见控件。
                      "opacity-0 group-focus-within:opacity-100 group-hover:opacity-100"
                }`}
              >
                <MoreHorizontal className="h-5 w-5" />
              </button>
            </div>
            {selected && selectedCourseExtra}
          </Fragment>
        );
      })}
      {courses.length === 0 &&
        (coursesError ? (
          // 课程加载失败：显示错误 + 重试，而不是伪装成「还没有课程」。
          <ErrorNote error={coursesErrorObj} onRetry={() => refetchCourses()} />
        ) : coursesPending ? (
          // 首次加载（尚无课程）时摆骨架行，贴合 44px 行高，避免「暂无课程」闪跳。
          <div className="space-y-1 px-3 py-2" aria-label={t("common.loading")}>
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} className="h-11 w-full rounded-md" />
            ))}
          </div>
        ) : (
          <div className="px-3 py-4 text-xs text-[var(--text-faint)]">
            {t("courseList.noCourses")}
          </div>
        ))}
      {(remove.isError || relink.isError) && (
        <ErrorNote className="mx-2 my-1" error={remove.error ?? relink.error} />
      )}
      {openCourse &&
        menuAnchor &&
        createPortal(
          <>
            {/* 透明背板：点菜单外区域即关闭。z-[60]/[61] 明确高于侧栏(40)/底栏(45)/
                全屏(50) 等所有 z token，避免 portal 到 body 后被它们盖住。 */}
            <div
              data-course-menu-backdrop
              className="fixed inset-0 z-[60]"
              onClick={closeMenu}
            />
            <div
              ref={menuRef}
              id={`course-actions-${openCourse.id}`}
              role="menu"
              aria-label={t("courseList.courseActions")}
              data-course-menu
              className="fixed z-[61] w-40 overflow-hidden rounded-md border border-[var(--border-subtle)] bg-[var(--surface-panel)] py-1 shadow-[var(--shadow-pop)]"
              style={menuPosition(menuAnchor)}
              onKeyDown={(event) => {
                const items = Array.from(
                  event.currentTarget.querySelectorAll<HTMLButtonElement>(
                    '[role="menuitem"]:not(:disabled)',
                  ),
                );
                const currentIndex = items.indexOf(document.activeElement as HTMLButtonElement);
                let nextIndex: number | null = null;

                if (event.key === "Tab") {
                  closeMenu();
                  return;
                } else if (event.key === "ArrowDown") {
                  nextIndex = currentIndex < 0 ? 0 : (currentIndex + 1) % items.length;
                } else if (event.key === "ArrowUp") {
                  nextIndex = currentIndex < 0
                    ? items.length - 1
                    : (currentIndex - 1 + items.length) % items.length;
                } else if (event.key === "Home") {
                  nextIndex = 0;
                } else if (event.key === "End") {
                  nextIndex = items.length - 1;
                } else if (event.key === "Escape") {
                  event.preventDefault();
                  event.stopPropagation();
                  closeMenuAndRestoreFocus();
                  return;
                }

                if (nextIndex != null && items[nextIndex]) {
                  event.preventDefault();
                  items[nextIndex].focus();
                }
              }}
            >
              <button
                role="menuitem"
                tabIndex={-1}
                onClick={() => startRename(openCourse.id, openCourse.name)}
                className="ca-touch-44 flex min-h-11 w-full items-center gap-2 px-3 py-2 text-left text-sm text-[var(--text-normal)] hover:bg-[var(--surface-card-hover)]"
              >
                <Pencil className="h-4 w-4" />
                {t("courseList.rename")}
              </button>
              <button
                role="menuitem"
                tabIndex={-1}
                onClick={() => void handleRelinkRoot(openCourse.id, openCourse.name)}
                className="ca-touch-44 flex min-h-11 w-full items-center gap-2 px-3 py-2 text-left text-sm text-[var(--text-normal)] hover:bg-[var(--surface-card-hover)]"
              >
                <FolderOpen className="h-4 w-4" />
                {t("courseList.relinkRoot")}
              </button>
              <button
                role="menuitem"
                tabIndex={-1}
                onClick={() => void confirmDelete(openCourse)}
                className="ca-touch-44 flex min-h-11 w-full items-center gap-2 px-3 py-2 text-left text-sm text-[var(--status-err)] hover:bg-[var(--surface-card-hover)]"
              >
                <Trash2 className="h-4 w-4" />
                {t("courseList.delete")}
              </button>
            </div>
          </>,
          document.body,
        )}
    </>
  );
}

// 菜单 fixed 定位：贴触发按钮右下角展开；下方空间不足则向上翻，并夹在视口内。
const MENU_WIDTH = 160;
const MENU_HEIGHT_EST = 148;
function menuPosition(anchor: DOMRect): { left: number; top: number } {
  const viewportH = typeof window !== "undefined" ? window.innerHeight : 768;
  const left = Math.max(8, anchor.right - MENU_WIDTH);
  const openUp = anchor.bottom + MENU_HEIGHT_EST > viewportH;
  const top = openUp
    ? Math.max(8, anchor.top - MENU_HEIGHT_EST)
    : anchor.bottom + 4;
  return { left, top };
}
