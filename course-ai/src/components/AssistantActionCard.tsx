import { useState } from "react";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  Check,
  Download,
  FolderPlus,
  PenLine,
  Settings2,
  Trash2,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { ipc } from "@/lib/ipc";
import type { AssistantAction } from "@/lib/types";

/**
 * 助手动作的渲染。
 *
 * 后端那些 `propose_*` 的工具**一个字节都没改**，只是把「打算做什么」记了下来。
 * 真正动手的是这里的按钮。
 *
 * 为什么值得这么绕：风险的大头不是「AI 决定删东西」，而是**它认错了对象**——
 * 你说「删掉刚才那个」，它删了另一个。所以必须把它解析出来的目标原样摆出来。
 */

type Proposal = Exclude<
  AssistantAction,
  { kind: "open_video" } | { kind: "seek_to" } | { kind: "set_theme" }
>;

type Status = "pending" | "running" | "done" | "failed";

/**
 * 动作执行完必须让相关列表失效。
 *
 * 少了这一步，就是「确认了但名字没变」——库里其实已经改好了，是界面还在拿缓存。
 * 应用里别处的改动都顺带做了失效，而这些卡片直接调 IPC，得自己补上。
 * 按前缀失效：卡片不知道视频属于哪门课，`["videos"]` 能盖住所有 `["videos", *]`。
 */
async function refreshAfter(action: Proposal, queryClient: QueryClient) {
  switch (action.kind) {
    case "propose_rename":
    case "propose_import":
      await queryClient.invalidateQueries({ queryKey: ["videos"] });
      return;
    case "propose_delete":
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["videos"] }),
        queryClient.invalidateQueries({ queryKey: ["trash"] }),
      ]);
      return;
    case "propose_create_course":
    case "propose_rename_course":
      await queryClient.invalidateQueries({ queryKey: ["courses"] });
      return;
    case "propose_setting":
      // 设置各处按需读取，没有统一的查询键可失效。
      return;
  }
}

/**
 * 按正常导入的完整流程走一遍，而不是只调一次裸的下载。
 *
 * 上一版这里只有 `importBilibili(courseId, url)`，结果是：没有字幕、没有清晰度选择、
 * 导入完也不跑流水线——视频进来了却什么都没分析。三件事其实是同一个原因：
 * 那几个参数不给，后端就按「不要字幕」处理；而流水线本来就靠调用方在拿到字幕后主动发起。
 *
 * 字幕轨的优先级与导入对话框保持一致：手打中文 > AI 中文 > 第一条。
 * 两处规则必须一样，否则同一个视频从不同入口导进来会得到不同的字幕。
 */
async function importWithSubtitles(courseId: string, url: string) {
  // B 站没有 cookies 会在下载阶段报 412。先说清楚，别让人对着一个原始错误码猜。
  const hasCookies = await ipc.tools.hasBilibiliCookies().catch(() => false);
  if (!hasCookies) {
    throw new Error("还没有导入 B 站 cookies，下载会被拦截。请先在导入对话框里导入一次 cookies.txt");
  }
  const probe = await ipc.tools.probeBilibili(url);
  const track =
    probe.tracks.find((t) => !t.auto && t.lang.startsWith("zh")) ??
    probe.tracks.find((t) => t.lang === "ai-zh") ??
    probe.tracks[0];
  // 纠错偏好取全局设置（未设置视为开，与流水线一致）；不带字幕时不写偏好。
  const autocorrect = track
    ? (await ipc.settings.get("subtitle_autocorrect").catch(() => null)) !== "false"
    : undefined;

  const video = await ipc.tools.importBilibili(
    courseId,
    url,
    probe.qualities[0],
    track?.lang,
    autocorrect,
  );

  // 有字幕就立刻跑流水线：ASR 阶段会走字幕分支跳过语音识别，
  // 用户不必再手动点一次「开始处理」。
  if (track) await ipc.pipeline.process(video.id);
}

async function execute(action: Proposal) {
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
      await importWithSubtitles(action.course_id, action.url);
      return;
    case "propose_create_course":
      await ipc.courses.create(action.name, action.root_path);
      return;
    case "propose_rename_course":
      await ipc.courses.rename(action.course_id, action.new_name);
  }
}

/** 提案怎么显示：一行主标题、一行副标题。单张卡和批量卡共用，保持一致。 */
function describe(action: Proposal): { primary: string; secondary?: string } {
  switch (action.kind) {
    case "propose_rename":
      return { primary: action.new_title, secondary: action.current_title };
    case "propose_delete":
      return { primary: action.title };
    case "propose_setting":
      return {
        primary: action.label,
        secondary: `${action.current ?? "未设置"} → ${action.value}`,
      };
    case "propose_import":
      return { primary: action.title, secondary: action.url };
    case "propose_create_course":
      return { primary: action.name, secondary: `建在 ${action.root_path}` };
    case "propose_rename_course":
      return { primary: action.new_name, secondary: action.current_name };
  }
}

const META: Record<
  Proposal["kind"],
  { icon: React.ReactNode; title: string; confirm: string; danger?: boolean }
> = {
  propose_rename: { icon: <PenLine className="h-3.5 w-3.5" />, title: "改名", confirm: "确认改名" },
  propose_delete: {
    icon: <Trash2 className="h-3.5 w-3.5" />,
    title: "删除视频",
    confirm: "确认删除",
    danger: true,
  },
  propose_setting: {
    icon: <Settings2 className="h-3.5 w-3.5" />,
    title: "修改设置",
    confirm: "确认修改",
  },
  propose_import: {
    icon: <Download className="h-3.5 w-3.5" />,
    title: "导入视频",
    confirm: "确认导入",
  },
  propose_create_course: {
    icon: <FolderPlus className="h-3.5 w-3.5" />,
    title: "新建课程",
    confirm: "确认创建",
  },
  propose_rename_course: {
    icon: <PenLine className="h-3.5 w-3.5" />,
    title: "课程改名",
    confirm: "确认改名",
  },
};

function formatMs(ms: number | null | undefined) {
  const total = Math.max(0, Math.floor((ms ?? 0) / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

/**
 * 一组同类提案的确认卡。一项时就是普通一张，多项时合成一张。
 *
 * 为什么必须合并：让人为一次「批量改名」点十下确认，等于把确认训练成一件要赶紧跳过的事，
 * 那就再也拦不住真正该拦的那一次了。
 *
 * 但每一项仍能单独剔除——批量里错一两个是常态，不该逼着人要么全接受要么全放弃。
 */
function ProposalGroup({ actions, onDone }: { actions: Proposal[]; onDone: () => void }) {
  const queryClient = useQueryClient();
  const [skipped, setSkipped] = useState<Set<number>>(new Set());
  const [status, setStatus] = useState<Status>("pending");
  const [error, setError] = useState("");

  const meta = META[actions[0].kind];
  const chosen = actions.map((action, i) => ({ action, i })).filter(({ i }) => !skipped.has(i));
  const batch = actions.length > 1;

  async function confirm() {
    setStatus("running");
    const failures: string[] = [];
    for (const { action } of chosen) {
      try {
        await execute(action);
      } catch (e) {
        failures.push(`${describe(action).primary}（${e}）`);
      }
    }
    await refreshAfter(actions[0], queryClient);
    if (failures.length === 0) {
      setStatus("done");
      return;
    }
    // 批量里失败几项时必须说清是哪几项。只报一条错，用户无从知道该重做什么。
    setError(
      `${chosen.length - failures.length} 项完成，${failures.length} 项失败：${failures.join("；")}`,
    );
    setStatus("failed");
  }

  if (chosen.length === 0) return null;

  return (
    <div
      className={`rounded-xl border p-2.5 text-xs ${
        meta.danger
          ? "border-[var(--status-err)] bg-[var(--status-err-bg)]"
          : "border-[var(--border-subtle)] bg-[var(--surface-card)]"
      }`}
    >
      <div className="mb-1.5 flex items-center gap-1.5 font-medium text-[var(--text-strong)]">
        {meta.icon}
        {meta.title}
        {batch && <span className="text-[var(--text-muted)]">{chosen.length} 项</span>}
      </div>

      <ul className="mb-2 space-y-1">
        {chosen.map(({ action, i }) => {
          const { primary, secondary } = describe(action);
          const struck =
            action.kind === "propose_rename" || action.kind === "propose_rename_course";
          return (
            <li key={i} className="flex items-start gap-1.5">
              <div className="min-w-0 flex-1">
                {secondary && (
                  <p
                    className={`break-all text-[var(--text-muted)] ${struck ? "line-through" : ""}`}
                  >
                    {secondary}
                  </p>
                )}
                <p className="break-all text-[var(--text-strong)]">{primary}</p>
              </div>
              {batch && status === "pending" && (
                <button
                  type="button"
                  aria-label={`跳过 ${primary}`}
                  onClick={() => setSkipped((prev) => new Set(prev).add(i))}
                  className="ca-touch-44 flex-none rounded p-0.5 text-[var(--text-faint)] transition hover:text-[var(--text-strong)]"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              )}
            </li>
          );
        })}
      </ul>

      {actions[0].kind === "propose_delete" && (
        <p className="mb-2 text-[var(--text-muted)]">进回收站，30 天内可还原。</p>
      )}
      {actions[0].kind === "propose_import" && !actions[0].course_id && (
        <p className="mb-2 flex items-center gap-1 text-[var(--status-err)]">
          <AlertTriangle className="h-3.5 w-3.5" />
          还没选课程，先打开一门课程再导入
        </p>
      )}

      {status === "done" ? (
        <div className="flex items-center gap-1 text-[var(--status-ok)]">
          <Check className="h-3.5 w-3.5" />
          已生效
        </div>
      ) : (
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            variant={meta.danger ? "destructive" : "default"}
            disabled={status === "running"}
            onClick={confirm}
          >
            {status === "running"
              ? "执行中…"
              : batch
                ? `${meta.confirm} ${chosen.length} 项`
                : meta.confirm}
          </Button>
          <Button size="sm" variant="ghost" onClick={onDone}>
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

/** 渲染一轮里的全部动作：相邻的同类提案合并成一张卡，导航与主题各自单独一条。 */
export function AssistantActionList({
  actions,
  onNavigate,
}: {
  actions: AssistantAction[];
  onNavigate: (action: AssistantAction) => void;
}) {
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());

  // 按出现顺序分组，相邻同类合并。不重排：助手交代事情是有先后的。
  const groups: { key: string; kind: string; items: AssistantAction[] }[] = [];
  actions.forEach((action, i) => {
    const last = groups[groups.length - 1];
    if (last && action.kind.startsWith("propose_") && last.kind === action.kind) {
      last.items.push(action);
    } else {
      groups.push({ key: `${i}-${action.kind}`, kind: action.kind, items: [action] });
    }
  });

  return (
    <>
      {groups
        .filter((group) => !dismissed.has(group.key))
        .map((group) => {
          const first = group.items[0];
          if (first.kind === "set_theme") {
            const label = { dark: "夜间", light: "日间", auto: "跟随系统" }[first.pref];
            return (
              <p
                key={group.key}
                className="rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-card)] px-2.5 py-2 text-xs text-[var(--text-muted)]"
              >
                已切换到{label}主题
              </p>
            );
          }
          if (first.kind === "open_video" || first.kind === "seek_to") {
            const label =
              first.kind === "open_video"
                ? `打开《${first.title}》`
                : `跳到 ${formatMs(first.at_ms)}`;
            return (
              <button
                key={group.key}
                type="button"
                onClick={() => onNavigate(first)}
                className="ca-touch-44 block w-full rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-card)] px-2.5 py-2 text-left text-xs text-[var(--text-normal)] transition hover:bg-[var(--surface-card-hover)]"
              >
                {label}
              </button>
            );
          }
          return (
            <ProposalGroup
              key={group.key}
              actions={group.items as Proposal[]}
              onDone={() => setDismissed((prev) => new Set(prev).add(group.key))}
            />
          );
        })}
    </>
  );
}
