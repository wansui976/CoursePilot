import { useEffect, useRef, useState } from "react";
import { qk } from "@/lib/queryKeys";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  Check,
  Download,
  FolderPlus,
  NotebookPen,
  PenLine,
  Settings2,
  Trash2,
  X,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import i18n from "@/i18n";
import { Button } from "@/components/ui/button";
import { humanizeError } from "@/lib/errors";
import { ipc } from "@/lib/ipc";
import { notesCoordinator } from "@/lib/notesCoordinator";
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

export interface AssistantActionOutcome {
  /** 已经不应再显示确认按钮的动作。 */
  resolvedActions: readonly AssistantAction[];
  /** 本次执行尝试已经结束、应从 executing checkpoint 移除的动作。 */
  finishedActions: readonly AssistantAction[];
  /** 按用户可读顺序追加到操作记录和上下文的回执。 */
  resultMessages: readonly string[];
}

type Status = "pending" | "running" | "paused" | "done" | "failed" | "stale";

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
      await queryClient.invalidateQueries({ queryKey: qk.videos.all() });
      return;
    case "propose_delete":
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: qk.videos.all() }),
        queryClient.invalidateQueries({ queryKey: qk.trash() }),
      ]);
      return;
    case "propose_create_course":
    case "propose_rename_course":
      await queryClient.invalidateQueries({ queryKey: qk.courses() });
      return;
    case "propose_setting":
      // 设置各处按需读取，没有统一的查询键可失效。
      return;
    case "propose_create_note":
      // 笔记写入走 notesCoordinator 的事件订阅，不经过 query 缓存。
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
type ImportResume = {
  importedVideoId?: string;
  onImported?: (videoId: string) => void;
};

/** 已经写给用户看的业务错误，不再交给通用错误映射二次改写。 */
class AssistantActionError extends Error {}

class StaleAssistantActionError extends AssistantActionError {}

function displayActionError(error: unknown) {
  return error instanceof AssistantActionError ? error.message : humanizeError(error);
}

async function processImportedVideo(videoId: string) {
  try {
    await ipc.pipeline.process(videoId);
  } catch (error) {
    throw new AssistantActionError(
      i18n.t("assistantActions.importSuccess", { error: humanizeError(error) }),
    );
  }
}

function isBilibiliUrl(value: string) {
  try {
    const host = new URL(value).hostname.toLowerCase();
    return host === "b23.tv" || host === "bilibili.com" || host.endsWith(".bilibili.com");
  } catch {
    return false;
  }
}

async function importWithSubtitles(courseId: string, url: string, resume: ImportResume = {}) {
  // 下载已经成功、只是后续流水线失败时，从检查点继续。重新 probe / import 会产生重复视频。
  if (resume.importedVideoId) {
    await processImportedVideo(resume.importedVideoId);
    return;
  }

  // B 站没有 cookies 会在下载阶段报 412。先说清楚，别让人对着一个原始错误码猜。
  // 检查本身出错时保留真实错误，不能伪装成「没有 cookies」。
  if (isBilibiliUrl(url)) {
    const hasCookies = await ipc.tools.hasBilibiliCookies();
    if (!hasCookies) {
      throw new AssistantActionError(
        i18n.t("assistantActions.noCookies"),
      );
    }
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
  resume.onImported?.(video.id);

  // 有字幕就立刻跑流水线：ASR 阶段会走字幕分支跳过语音识别，
  // 用户不必再手动点一次「开始处理」。
  if (track) await processImportedVideo(video.id);
}

async function execute(action: Proposal, importResume?: ImportResume) {
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
      if (!action.course_id) throw new Error(i18n.t("assistantActions.noCourseId"));
      await importWithSubtitles(action.course_id, action.url, importResume);
      return;
    case "propose_create_course":
      await ipc.courses.create(action.name, action.root_path);
      return;
    case "propose_rename_course":
      await ipc.courses.rename(action.course_id, action.new_name);
      return;
    case "propose_create_note":
      await notesCoordinator.appendAnswer(action.video_id, action.markdown);
      return;
  }
}

/**
 * 确认卡可能在界面里放很久，期间用户手工修改或云同步都可能改变目标。
 * 先把本批次涉及的对象统一读一遍，任何一项过期都不执行，避免半批成功后才发现认错对象。
 */
async function assertActionsFresh(actions: Proposal[]) {
  const needsCourses = actions.some(
    (action) =>
      action.kind === "propose_import" ||
      action.kind === "propose_create_course" ||
      action.kind === "propose_rename_course",
  );
  const courses = needsCourses ? await ipc.courses.list() : [];
  const videosByCourse = new Map<string, Awaited<ReturnType<typeof ipc.videos.list>>>();
  const settings = new Map<string, string | null>();

  const stale = (action: Proposal): never => {
    throw new StaleAssistantActionError(
      i18n.t("assistantActions.staleTarget", { target: describe(action).primary }),
    );
  };

  for (const action of actions) {
    if (action.kind === "propose_rename" || action.kind === "propose_delete") {
      // course_id 是新后端提供的稳定定位；旧后端的卡仍按原协议执行，避免热更新时全部失效。
      if (!action.course_id) continue;
      let videos = videosByCourse.get(action.course_id);
      if (!videos) {
        videos = await ipc.videos.list(action.course_id);
        videosByCourse.set(action.course_id, videos);
      }
      const current = videos.find((video) => video.id === action.video_id);
      if (!current) {
        stale(action);
        continue;
      }
      const expected =
        action.kind === "propose_rename" ? action.current_title : action.title;
      const alreadyApplied =
        action.kind === "propose_rename" && current.title === action.new_title;
      if (!alreadyApplied && current.title !== expected) stale(action);
      continue;
    }

    if (action.kind === "propose_setting") {
      let current = settings.get(action.key);
      if (!settings.has(action.key)) {
        current = await ipc.settings.get(action.key);
        settings.set(action.key, current);
      }
      const expected = action.current ?? null;
      if (current !== expected && current !== action.value) stale(action);
      continue;
    }

    if (action.kind === "propose_rename_course") {
      const current = courses.find((course) => course.id === action.course_id);
      if (!current || (current.name !== action.current_name && current.name !== action.new_name)) {
        stale(action);
      }
      continue;
    }

    if (action.kind === "propose_import") {
      const current = courses.find((course) => course.id === action.course_id);
      if (!current) stale(action);
      continue;
    }

    if (action.kind === "propose_create_course") {
      const root = await ipc.settings.get("default_storage_root");
      if (root !== action.root_path || courses.some((course) => course.name === action.name)) {
        stale(action);
      }
    }
  }
}

/** 提案怎么显示：对象、补充信息和所属课程。单张卡和批量卡共用，保持一致。 */
function describe(action: Proposal): { primary: string; secondary?: string; context?: string } {
  switch (action.kind) {
    case "propose_rename":
      return {
        primary: action.new_title,
        secondary: action.current_title,
        context: action.course_name
          ? i18n.t("assistantActions.courseContext", { course: action.course_name })
          : undefined,
      };
    case "propose_delete":
      return {
        primary: action.title,
        context: action.course_name
          ? i18n.t("assistantActions.courseContext", { course: action.course_name })
          : undefined,
      };
    case "propose_setting":
      return {
        primary: action.label,
        secondary: i18n.t("assistantActions.settingChange", { current: action.current ?? i18n.t("assistantActions.notSet"), value: action.value }),
      };
    case "propose_import":
      return {
        primary: action.title,
        secondary: action.url,
        context: action.course_name
          ? i18n.t("assistantActions.importCourseContext", { course: action.course_name })
          : undefined,
      };
    case "propose_create_course":
      return { primary: action.name, secondary: i18n.t("assistantActions.createAt", { path: action.root_path }) };
    case "propose_rename_course":
      return { primary: action.new_name, secondary: action.current_name };
    case "propose_create_note":
      return {
        primary: action.topic,
        secondary: i18n.t("assistantActions.noteIntoVideo", { title: action.video_title }),
      };
  }
}

const META: Record<
  Proposal["kind"],
  { icon: React.ReactNode; titleKey: string; confirmKey: string; danger?: boolean }
> = {
  propose_rename: { icon: <PenLine className="h-3.5 w-3.5" />, titleKey: "assistantActions.renameTitle", confirmKey: "assistantActions.renameConfirm" },
  propose_delete: {
    icon: <Trash2 className="h-3.5 w-3.5" />,
    titleKey: "assistantActions.deleteTitle",
    confirmKey: "assistantActions.deleteConfirm",
    danger: true,
  },
  propose_setting: {
    icon: <Settings2 className="h-3.5 w-3.5" />,
    titleKey: "assistantActions.settingTitle",
    confirmKey: "assistantActions.settingConfirm",
  },
  propose_import: {
    icon: <Download className="h-3.5 w-3.5" />,
    titleKey: "assistantActions.importTitle",
    confirmKey: "assistantActions.importConfirm",
  },
  propose_create_course: {
    icon: <FolderPlus className="h-3.5 w-3.5" />,
    titleKey: "assistantActions.createTitle",
    confirmKey: "assistantActions.createConfirm",
  },
  propose_rename_course: {
    icon: <PenLine className="h-3.5 w-3.5" />,
    titleKey: "assistantActions.courseRenameTitle",
    confirmKey: "assistantActions.courseRenameConfirm",
  },
  propose_create_note: {
    icon: <NotebookPen className="h-3.5 w-3.5" />,
    titleKey: "assistantActions.noteTitle",
    confirmKey: "assistantActions.noteConfirm",
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
function ProposalGroup({
  actions,
  onDone,
  onOutcome,
  executionLocked,
  onExecutionStart,
  onExecutionEnd,
  onApplied,
}: {
  actions: Proposal[];
  onDone: () => void;
  onOutcome?: (outcome: AssistantActionOutcome) => void;
  executionLocked?: boolean;
  onExecutionStart?: (actions: Proposal[]) => boolean;
  onExecutionEnd?: () => void;
  onApplied?: (action: Proposal) => void;
}) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [skipped, setSkipped] = useState<Set<number>>(new Set());
  const [completed, setCompleted] = useState<Set<number>>(new Set());
  const [status, setStatus] = useState<Status>("pending");
  const [error, setError] = useState("");
  const [warning, setWarning] = useState("");
  const importCheckpoints = useRef<Map<number, string>>(new Map());
  const completionRef = useRef<HTMLDivElement>(null);
  const stopRequestedRef = useRef(false);
  const [stopRequested, setStopRequested] = useState(false);

  const meta = META[actions[0].kind];
  const title = t(meta.titleKey);
  const confirmLabel = t(meta.confirmKey);
  const chosen = actions.map((action, i) => ({ action, i })).filter(({ i }) => !skipped.has(i));
  const remaining = chosen.filter(({ i }) => !completed.has(i));
  const batch = actions.length > 1;
  const missingImportCourse = remaining.some(
    ({ action }) => action.kind === "propose_import" && !action.course_id,
  );

  useEffect(() => {
    if (status === "done") completionRef.current?.focus();
  }, [status]);

  async function confirm() {
    if (
      status === "running" ||
      status === "stale" ||
      executionLocked ||
      remaining.length === 0 ||
      missingImportCourse
    ) {
      return;
    }
    const actionSnapshot = remaining.map(({ action }) => action);
    if (onExecutionStart && !onExecutionStart(actionSnapshot)) return;
    setStatus("running");
    setError("");
    setWarning("");
    stopRequestedRef.current = false;
    setStopRequested(false);
    try {
      await executeRemaining(actionSnapshot);
    } finally {
      onExecutionEnd?.();
    }
  }

  async function executeRemaining(actionSnapshot: Proposal[]) {
    try {
      await assertActionsFresh(remaining.map(({ action }) => action));
    } catch (e) {
      const message = displayActionError(e);
      setError(message);
      const stale = e instanceof StaleAssistantActionError;
      setStatus(stale ? "stale" : "failed");
      onOutcome?.({
        resolvedActions: stale ? remaining.map(({ action }) => action) : [],
        finishedActions: actionSnapshot,
        resultMessages: [t("assistantActions.executionError", { error: message })],
      });
      return;
    }
    const succeeded: number[] = [];
    const failures: { message: string }[] = [];
    let shouldRefresh = false;
    let interrupted = false;
    for (const { action, i } of remaining) {
      if (stopRequestedRef.current) {
        interrupted = true;
        break;
      }
      try {
        await execute(action, {
          importedVideoId: importCheckpoints.current.get(i),
          onImported: (videoId) => {
            importCheckpoints.current.set(i, videoId);
            shouldRefresh = true;
          },
        });
        // 后端动作已经成功，外层同步界面失败不能把它伪装成可重试的执行失败。
        try {
          onApplied?.(action);
        } catch {
          // 查询失效仍会尽量把界面拉回真实状态。
        }
        succeeded.push(i);
        shouldRefresh = true;
      } catch (e) {
        failures.push({
          message: `${describe(action).primary}（${displayActionError(e)}）`,
        });
      }
    }
    const resultMessages: string[] = [];
    if (succeeded.length > 0) {
      setCompleted((prev) => new Set([...prev, ...succeeded]));
      resultMessages.push(
        t("assistantActions.completeResult", {
          title,
          details: succeeded.map((index) => describe(actions[index]).primary).join("、"),
        }),
      );
    }
    const completedAfter = new Set([...completed, ...succeeded]);
    const unfinishedAfter = chosen.filter(({ i }) => !completedAfter.has(i));
    if (interrupted) {
      setWarning(t("assistantActions.stoppedResult", { count: unfinishedAfter.length }));
      resultMessages.push(
        t("assistantActions.canceledResult", {
          title,
          details: unfinishedAfter.map(({ action }) => describe(action).primary).join("、"),
        }),
      );
    } else if (failures.length > 0) {
      // 批量里失败几项时必须说清是哪几项。只报一条错，用户无从知道该重做什么。
      const failureMessage = t("assistantActions.executionError", {
        error: failures.map(({ message }) => message).join("；"),
      });
      resultMessages.push(failureMessage);
      setError(
        t("assistantActions.partialResult", {
          succeeded: succeeded.length,
          failed: failures.length,
          details: failures.map(({ message }) => message).join("；"),
        }),
      );
    }
    onOutcome?.({
      resolvedActions: succeeded.map((index) => actions[index]),
      finishedActions: actionSnapshot,
      resultMessages,
    });
    if (shouldRefresh) {
      try {
        await refreshAfter(actions[0], queryClient);
      } catch {
        // 动作已经落库，刷新失败不能把它伪装成「执行失败」再让用户重做一次。
        setWarning(t("assistantActions.refreshFailed"));
      }
    }
    if (interrupted) {
      setStatus("paused");
    } else if (failures.length === 0) {
      setStatus("done");
    } else {
      setStatus("failed");
    }
  }

  function stopRemaining() {
    stopRequestedRef.current = true;
    setStopRequested(true);
  }

  function dismiss() {
    onOutcome?.({
      resolvedActions: remaining.map(({ action }) => action),
      finishedActions: [],
      resultMessages: [
        t("assistantActions.canceledResult", {
          title,
          details: remaining.map(({ action }) => describe(action).primary).join("、"),
        }),
      ],
    });
    onDone();
  }

  function skip(index: number, action: Proposal) {
    if (completed.has(index)) return;
    setSkipped((prev) => new Set(prev).add(index));
    onOutcome?.({
      resolvedActions: [action],
      finishedActions: [],
      resultMessages: [
        t("assistantActions.canceledResult", { title, details: describe(action).primary }),
      ],
    });
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
        {title}
        {batch && <span className="text-[var(--text-muted)]">{t("assistantActions.items", { count: chosen.length })}</span>}
      </div>

      <ul className="mb-2 space-y-1">
        {chosen.map(({ action, i }) => {
          const { primary, secondary, context } = describe(action);
          const struck =
            action.kind === "propose_rename" || action.kind === "propose_rename_course";
          return (
            <li key={i} className="flex items-start gap-1.5">
              <div className="min-w-0 flex-1">
                {context && (
                  <p className="break-all text-[var(--text-muted)]">{context}</p>
                )}
                {secondary && (
                  <p
                    className={`break-all text-[var(--text-muted)] ${struck ? "line-through" : ""}`}
                  >
                    {secondary}
                  </p>
                )}
                <p className="break-all text-[var(--text-strong)]">{primary}</p>
              </div>
              {completed.has(i) && (
                <span className="flex flex-none items-center gap-1 text-[var(--status-ok)]">
                  <Check className="h-3.5 w-3.5" aria-hidden="true" />
                  {t("assistantActions.completed")}
                </span>
              )}
              {batch && !completed.has(i) && (status === "pending" || status === "paused") && (
                <button
                  type="button"
                  aria-label={t("assistantActions.skip", { name: primary })}
                  onClick={() => skip(i, action)}
                  className="ca-touch-44 flex-none rounded p-0.5 text-[var(--text-faint)] transition hover:text-[var(--text-strong)]"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              )}
            </li>
          );
        })}
      </ul>

      {actions[0].kind === "propose_create_note" && (
        <div className="mb-2 max-h-48 overflow-y-auto whitespace-pre-wrap rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-card)] p-2 text-xs leading-relaxed text-[var(--text-muted)]">
          {actions[0].markdown}
        </div>
      )}

      {actions[0].kind === "propose_delete" && (
        <p className="mb-2 text-[var(--text-muted)]">{t("assistantActions.recycleBinNote")}</p>
      )}
      {missingImportCourse && (
        <p className="mb-2 flex items-center gap-1 text-[var(--status-err)]">
          <AlertTriangle className="h-3.5 w-3.5" />
          {t("assistantActions.noCourseSelected")}
        </p>
      )}

      {status === "done" ? (
        <div
          ref={completionRef}
          tabIndex={-1}
          className="flex items-center gap-1 text-[var(--status-ok)] outline-none"
        >
          <Check className="h-3.5 w-3.5" />
          {t("assistantActions.applied")}
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            variant={meta.danger ? "destructive" : "default"}
            className="ca-touch-44"
            disabled={
              status === "running" ||
              status === "stale" ||
              executionLocked ||
              missingImportCourse
            }
            onClick={confirm}
          >
            {status === "running"
              ? t("assistantActions.executing")
              : status === "stale"
                ? t("assistantActions.staleButton")
              : status === "failed"
                ? t("assistantActions.retryFailed", { count: remaining.length })
                : status === "paused"
                  ? t("assistantActions.continueRemaining", { count: remaining.length })
                  : batch
                    ? t("assistantActions.confirmBatch", { action: confirmLabel, count: chosen.length })
                    : confirmLabel}
          </Button>
          {status === "running" && batch ? (
            <Button
              size="sm"
              variant="ghost"
              className="ca-touch-44"
              disabled={stopRequested}
              onClick={stopRemaining}
            >
              {stopRequested ? t("assistantActions.stopping") : t("assistantActions.stopRemaining")}
            </Button>
          ) : status !== "running" ? (
            <Button size="sm" variant="ghost" onClick={dismiss} className="ca-touch-44">
              {t("assistantActions.cancel")}
            </Button>
          ) : null}
        </div>
      )}
      {error && (
        <p role="alert" className="mt-1.5 text-[var(--status-err)]">
          {t("assistantActions.executionError", { error })}
        </p>
      )}
      {warning && (
        <p role="status" className="mt-1.5 text-[var(--status-warn)]">
          {warning}
        </p>
      )}
    </div>
  );
}

/** 渲染一轮里的全部动作：相邻的同类提案合并成一张卡，导航与主题各自单独一条。 */
export function AssistantActionList({
  actions,
  onNavigate,
  onOutcome,
  executionLocked,
  onExecutionStart,
  onExecutionEnd,
  onApplied,
}: {
  actions: AssistantAction[];
  onNavigate: (action: AssistantAction) => void;
  onOutcome?: (outcome: AssistantActionOutcome) => void;
  executionLocked?: boolean;
  onExecutionStart?: (actions: AssistantAction[]) => boolean;
  onExecutionEnd?: () => void;
  onApplied?: (action: AssistantAction) => void;
}) {
  const { t } = useTranslation();
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
            const themeLabel = { dark: t("assistantActions.themeDark"), light: t("assistantActions.themeLight"), auto: t("assistantActions.themeAuto") }[first.pref];
            return (
              <p
                key={group.key}
                className="rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-card)] px-2.5 py-2 text-xs text-[var(--text-muted)]"
              >
                {t("assistantActions.switchedTheme", { label: themeLabel })}
              </p>
            );
          }
          if (first.kind === "open_video" || first.kind === "seek_to") {
            const label =
              first.kind === "open_video"
                ? t("assistantActions.openVideo", { title: first.title })
                : t("assistantActions.seekTo", { time: formatMs(first.at_ms) });
            return (
              <button
                key={group.key}
                type="button"
                disabled={executionLocked}
                onClick={() => {
                  if (onExecutionStart && !onExecutionStart([first])) return;
                  try {
                    onNavigate(first);
                    onOutcome?.({
                      resolvedActions: [first],
                      finishedActions: [first],
                      resultMessages: [],
                    });
                  } catch (error) {
                    onOutcome?.({
                      resolvedActions: [],
                      finishedActions: [first],
                      resultMessages: [],
                    });
                    throw error;
                  } finally {
                    onExecutionEnd?.();
                  }
                }}
                className="ca-touch-44 block w-full rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-card)] px-2.5 py-2 text-left text-xs text-[var(--text-normal)] transition hover:bg-[var(--surface-card-hover)] disabled:cursor-not-allowed disabled:opacity-50"
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
              onOutcome={onOutcome}
              executionLocked={executionLocked}
              onExecutionStart={onExecutionStart}
              onExecutionEnd={onExecutionEnd}
              onApplied={onApplied}
            />
          );
        })}
    </>
  );
}
