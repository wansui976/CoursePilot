import { useState } from "react";
import {
  AlertTriangle,
  Check,
  Download,
  FolderPlus,
  PenLine,
  Settings2,
  Trash2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { ipc } from "@/lib/ipc";
import type { AssistantAction } from "@/lib/types";

/**
 * 提案确认卡。
 *
 * 后端那些 `propose_*` 的工具**一个字节都没改**，只是把「打算做什么」记了下来。
 * 真正动手的是这张卡上的按钮。
 *
 * 为什么值得这么绕：风险的大头不是「AI 决定删东西」，而是**它认错了对象**——
 * 你说「删掉刚才那个」，它删了另一个。所以卡上必须把它解析出来的目标原样摆出来
 * （哪个视频、原名是什么、要改成什么），让人一眼能看出对不对。
 */

type Status = "pending" | "running" | "done" | "failed";

function useConfirm(run: () => Promise<unknown>) {
  const [status, setStatus] = useState<Status>("pending");
  const [error, setError] = useState("");
  const confirm = async () => {
    setStatus("running");
    try {
      await run();
      setStatus("done");
    } catch (e) {
      // 失败必须说出来。默默回到「待确认」的话，用户会以为自己没点上，
      // 再点一次——而第一次可能已经生效了。
      setError(String(e));
      setStatus("failed");
    }
  };
  return { status, error, confirm };
}

function Shell({
  icon,
  title,
  danger,
  children,
  status,
  error,
  onConfirm,
  onDismiss,
  confirmLabel,
}: {
  icon: React.ReactNode;
  title: string;
  danger?: boolean;
  children: React.ReactNode;
  status: Status;
  error: string;
  onConfirm: () => void;
  onDismiss: () => void;
  confirmLabel: string;
}) {
  return (
    <div
      className={`rounded-xl border p-2.5 text-xs ${
        danger
          ? "border-[var(--status-err)] bg-[var(--status-err-bg)]"
          : "border-[var(--border-subtle)] bg-[var(--surface-card)]"
      }`}
    >
      <div className="mb-1.5 flex items-center gap-1.5 font-medium text-[var(--text-strong)]">
        {icon}
        {title}
      </div>
      <div className="mb-2 space-y-0.5 text-[var(--text-normal)]">{children}</div>

      {status === "done" ? (
        <div className="flex items-center gap-1 text-[var(--status-ok)]">
          <Check className="h-3.5 w-3.5" />
          已生效
        </div>
      ) : (
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            variant={danger ? "destructive" : "default"}
            disabled={status === "running"}
            onClick={onConfirm}
          >
            {status === "running" ? "执行中…" : confirmLabel}
          </Button>
          <Button size="sm" variant="ghost" onClick={onDismiss}>
            取消
          </Button>
        </div>
      )}
      {status === "failed" && (
        <p role="alert" className="mt-1.5 text-[var(--status-err)]">
          没能执行：{error}
        </p>
      )}
    </div>
  );
}

export function AssistantActionCard({
  action,
  onDismiss,
  onNavigate,
}: {
  action: AssistantAction;
  onDismiss: () => void;
  /** 导航类动作交给外层执行（打开视频 / 跳转）。 */
  onNavigate: (action: AssistantAction) => void;
}) {
  // 主题已经在外层直接应用了，这里只留一条说明，不再要求点击。
  if (action.kind === "set_theme") {
    const label = { dark: "夜间", light: "日间", auto: "跟随系统" }[action.pref];
    return (
      <p className="rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-card)] px-2.5 py-2 text-xs text-[var(--text-muted)]">
        已切换到{label}主题
      </p>
    );
  }

  // 导航没有破坏性，不需要确认——但也不该悄悄发生，给一个能点的条目。
  if (action.kind === "open_video" || action.kind === "seek_to") {
    const label =
      action.kind === "open_video"
        ? `打开《${action.title}》`
        : `跳到 ${formatMs(action.at_ms)}`;
    return (
      <button
        type="button"
        onClick={() => onNavigate(action)}
        className="ca-touch-44 block w-full rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-card)] px-2.5 py-2 text-left text-xs text-[var(--text-normal)] transition hover:bg-[var(--surface-card-hover)]"
      >
        {label}
      </button>
    );
  }

  return <ProposalCard action={action} onDismiss={onDismiss} />;
}

function formatMs(ms: number | null | undefined) {
  const total = Math.max(0, Math.floor((ms ?? 0) / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function ProposalCard({
  action,
  onDismiss,
}: {
  action: Exclude<
    AssistantAction,
    { kind: "open_video" } | { kind: "seek_to" } | { kind: "set_theme" }
  >;
  onDismiss: () => void;
}) {
  const run = async () => {
    switch (action.kind) {
      case "propose_rename":
        await ipc.videos.updateTitle(action.video_id, action.new_title);
        return;
      case "propose_delete":
        await ipc.videos.delete(action.video_id);
        return;
      case "propose_setting":
        await ipc.settings.set(action.key, action.value);
        return;
      case "propose_import":
        if (!action.course_id) throw new Error("没有指定要导入到哪门课程");
        await ipc.tools.importBilibili(action.course_id, action.url);
        return;
      case "propose_create_course":
        await ipc.courses.create(action.name, action.root_path);
        return;
      case "propose_rename_course":
        await ipc.courses.rename(action.course_id, action.new_name);
    }
  };
  const { status, error, confirm } = useConfirm(run);

  const common = { status, error, onConfirm: confirm, onDismiss };

  switch (action.kind) {
    case "propose_rename":
      return (
        <Shell
          {...common}
          icon={<PenLine className="h-3.5 w-3.5" />}
          title="改名"
          confirmLabel="确认改名"
        >
          {/* 原名和新名都摆出来：认错对象是这里最大的风险。 */}
          <p className="text-[var(--text-muted)] line-through">{action.current_title}</p>
          <p className="text-[var(--text-strong)]">{action.new_title}</p>
        </Shell>
      );
    case "propose_delete":
      return (
        <Shell
          {...common}
          danger
          icon={<Trash2 className="h-3.5 w-3.5" />}
          title="删除视频"
          confirmLabel="确认删除"
        >
          <p className="text-[var(--text-strong)]">{action.title}</p>
          <p className="text-[var(--text-muted)]">进回收站，30 天内可还原。</p>
        </Shell>
      );
    case "propose_setting":
      return (
        <Shell
          {...common}
          icon={<Settings2 className="h-3.5 w-3.5" />}
          title="修改设置"
          confirmLabel="确认修改"
        >
          <p className="text-[var(--text-strong)]">{action.label}</p>
          <p className="text-[var(--text-muted)]">
            {action.current ?? "未设置"} → {action.value}
          </p>
        </Shell>
      );
    case "propose_create_course":
      return (
        <Shell
          {...common}
          icon={<FolderPlus className="h-3.5 w-3.5" />}
          title="新建课程"
          confirmLabel="确认创建"
        >
          <p className="text-[var(--text-strong)]">{action.name}</p>
          {/* 目录要显示：多数人记不清默认存放位置在哪，建错地方后面很难收拾。 */}
          <p className="break-all text-[var(--text-muted)]">建在 {action.root_path}</p>
        </Shell>
      );
    case "propose_rename_course":
      return (
        <Shell
          {...common}
          icon={<PenLine className="h-3.5 w-3.5" />}
          title="课程改名"
          confirmLabel="确认改名"
        >
          <p className="text-[var(--text-muted)] line-through">{action.current_name}</p>
          <p className="text-[var(--text-strong)]">{action.new_name}</p>
        </Shell>
      );
    case "propose_import":
      return (
        <Shell
          {...common}
          icon={<Download className="h-3.5 w-3.5" />}
          title="导入视频"
          confirmLabel="确认导入"
        >
          <p className="text-[var(--text-strong)]">{action.title}</p>
          <p className="break-all text-[var(--text-muted)]">{action.url}</p>
          {!action.course_id && (
            <p className="flex items-center gap-1 text-[var(--status-err)]">
              <AlertTriangle className="h-3.5 w-3.5" />
              还没选课程，先打开一门课程再导入
            </p>
          )}
        </Shell>
      );
  }
}
