import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { CircleCheck, CircleX, LoaderCircle, X } from "lucide-react";
import {
  useBackgroundTasks,
  useCachedVideoTitle,
  useNow,
  useTaskCompletion,
  type BackgroundTask,
  type TaskMeta,
  type TaskNotice,
} from "@/lib/backgroundTasks";
import { NOTICE_MS, useTaskNotices } from "@/lib/taskNotices";
import { formatMs } from "@/lib/time";
import { displayTitle } from "@/lib/videoTitle";
import { Menu, MenuItem } from "@/ui/menu";

/**
 * 全局「后台任务」入口：有任务在跑时才出现，点开列出「哪个视频 · 在做什么 · 已用时」，
 * 点一项直达结果所在的页签。三种外形对应三种外壳：展开侧栏的一行、收起后 rail 的图标、
 * 手机上浮在底栏上方的小胶囊。
 */
export function BackgroundTasksButton({
  variant,
  onOpenTask,
}: {
  variant: "sidebar" | "rail" | "floating";
  onOpenTask: (task: TaskMeta) => void;
}) {
  const { t } = useTranslation();
  const tasks = useBackgroundTasks();
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const now = useNow(open && tasks.length > 0);
  // 点在入口与列表之外就收起。手机上的列表挂在 body 上、自己截住了 pointerdown，
  // 点它不会走到这里；点遮罩由 Menu 调 onClose。
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (wrapperRef.current?.contains(event.target as Node)) return;
      setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);
  // 任务全跑完了，列表跟着收起。
  useEffect(() => {
    if (tasks.length === 0) setOpen(false);
  }, [tasks.length]);
  if (tasks.length === 0) return null;

  const label = t("backgroundTasks.running", { count: tasks.length });
  const close = () => {
    setOpen(false);
    requestAnimationFrame(() => triggerRef.current?.focus());
  };

  const trigger =
    variant === "rail" ? (
      <button
        ref={triggerRef}
        type="button"
        className="rail-btn"
        data-tip={label}
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <LoaderCircle className="h-[18px] w-[18px] animate-spin text-[var(--accent-text)]" />
        <span className="rail-badge">{tasks.length}</span>
      </button>
    ) : variant === "sidebar" ? (
      <button
        ref={triggerRef}
        type="button"
        className="ca-side-item w-full"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <LoaderCircle className="ic h-4 w-4 animate-spin text-[var(--accent-text)]" />
        <span className="nm">{t("backgroundTasks.title")}</span>
        <span className="ca-side-count" aria-hidden="true">
          {tasks.length}
        </span>
      </button>
    ) : (
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className="ca-touch-44 inline-flex items-center gap-1.5 rounded-full border border-[var(--border-subtle)] bg-[var(--surface-panel)]/90 px-3 py-1.5 text-xs font-medium text-[var(--text-normal)] shadow-[var(--shadow-raise)] backdrop-blur"
      >
        <LoaderCircle className="h-3.5 w-3.5 animate-spin text-[var(--accent-text)]" />
        {label}
      </button>
    );

  return (
    <div
      ref={wrapperRef}
      className={variant === "floating" ? "ca-tasks-floating" : "relative"}
    >
      {trigger}
      {open && (
        <Menu
          aria-label={t("backgroundTasks.title")}
          onClose={close}
          triggerRef={triggerRef}
          // 展开侧栏里就地展开在入口下方：侧栏裁掉横向溢出，往上弹又会盖住上面几行导航。
          className={
            variant === "rail"
              ? "absolute left-full top-0 z-50 ml-2 w-72"
              : variant === "sidebar"
                ? "mt-1 shadow-none"
                : "absolute bottom-full left-0 z-50 mb-1 w-72"
          }
        >
          {tasks.map((task) => (
            <TaskRow
              key={task.id}
              task={task}
              now={now}
              onClick={() => {
                setOpen(false);
                onOpenTask(task);
              }}
            />
          ))}
        </Menu>
      )}
    </div>
  );
}

function TaskRow({ task, now, onClick }: { task: BackgroundTask; now: number; onClick: () => void }) {
  const { t } = useTranslation();
  const title = useCachedVideoTitle(task.videoId);
  return (
    <MenuItem className="ca-touch-44 flex items-center gap-2.5" onClick={onClick}>
      <LoaderCircle className="h-3.5 w-3.5 flex-none animate-spin text-[var(--accent-text)]" />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[var(--text-strong)]">{t(`backgroundTasks.kind.${task.kind}`)}</span>
        {title && <span className="block truncate text-xs text-[var(--text-muted)]">{displayTitle(title)}</span>}
      </span>
      <span className="flex-none tabular-nums text-xs text-[var(--text-faint)]">
        {formatMs(Math.max(0, now - task.submittedAt))}
      </span>
    </MenuItem>
  );
}


/**
 * 任务跑完的提示。用户正看着结果（就在那个视频 / 知识点页）时不打扰，
 * 否则在底部弹一条「摘要已生成 · 查看」，6 秒后自己消失。
 */
export function TaskCompletionNotices({
  isWatching,
  onOpenTask,
  bottomOffset,
}: {
  /** 用户此刻是否已经看着这项任务的结果。 */
  isWatching: (task: TaskMeta) => boolean;
  onOpenTask: (task: TaskMeta) => void;
  /** 底部被底栏占掉的高度（px）。 */
  bottomOffset: number;
}) {
  const notices = useTaskNotices((state) => state.notices);
  const dismiss = useTaskNotices((state) => state.dismiss);
  const push = useTaskNotices((state) => state.push);

  useTaskCompletion((notice) => {
    if (notice.ok && isWatching(notice)) return;
    push(notice);
    window.setTimeout(() => dismiss(notice.id), NOTICE_MS);
  });

  if (notices.length === 0) return null;
  return (
    <div
      role="status"
      aria-live="polite"
      className="pointer-events-none fixed inset-x-0 z-[60] flex flex-col items-center gap-2 px-4"
      style={{ bottom: `calc(var(--safe-bottom) + ${bottomOffset + 16}px)` }}
    >
      {notices.map((notice) => (
        <NoticeCard
          key={notice.id}
          notice={notice}
          onOpen={() => {
            dismiss(notice.id);
            onOpenTask(notice);
          }}
          onDismiss={() => dismiss(notice.id)}
        />
      ))}
    </div>
  );
}

function NoticeCard({
  notice,
  onOpen,
  onDismiss,
}: {
  notice: TaskNotice;
  onOpen: () => void;
  onDismiss: () => void;
}) {
  const { t } = useTranslation();
  const title = useCachedVideoTitle(notice.videoId);
  const what = t(`backgroundTasks.kind.${notice.kind}`);
  return (
    <div className="ca-task-notice pointer-events-auto flex w-full max-w-sm items-center gap-2.5 rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-panel)] px-3 py-2 text-sm shadow-[var(--shadow-pop)]">
      {notice.ok ? (
        <CircleCheck className="h-4 w-4 flex-none text-[var(--status-ok)]" />
      ) : (
        <CircleX className="h-4 w-4 flex-none text-[var(--status-err)]" />
      )}
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[var(--text-strong)]">
          {t(notice.ok ? "backgroundTasks.done" : "backgroundTasks.failed", { what })}
        </span>
        {title && <span className="block truncate text-xs text-[var(--text-muted)]">{displayTitle(title)}</span>}
      </span>
      <button
        type="button"
        onClick={onOpen}
        className="ca-touch-44 flex-none rounded-md px-2 py-1 text-xs font-medium text-[var(--accent-text)] hover:bg-[var(--surface-card-hover)]"
      >
        {t("backgroundTasks.view")}
      </button>
      <button
        type="button"
        aria-label={t("common.close")}
        onClick={onDismiss}
        className="ca-touch-44 grid h-6 w-6 flex-none place-items-center rounded text-[var(--text-faint)] hover:text-[var(--text-normal)]"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}
