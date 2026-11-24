import type { TFunction } from "i18next";
import type {
  AssistantCheckpoint,
  AssistantCheckpointActionKind,
  AssistantTurnRecord,
} from "@/lib/assistantSession";
import type { AssistantContext, AssistantUsage, ToolExecutionStatus } from "@/lib/types";
import { formatPosition } from "./assistantPanelModel";

/**
 * 助手轮次的纯模型层：类型、用量计算、状态文案与建议问题。
 * 不含任何组件——react-refresh 只允许组件文件混出类型，纯函数放这里。
 */

/** 面板内部的轮次记录：在持久化字段之外叠加只属于当前流式请求的临场状态。 */
export type Turn = AssistantTurnRecord & {
  /** 只存在于当前流式请求中；完成后不落入会话存储。 */
  activeTool?: { callId: string; name: string };
  /** 最近一次工具结束状态；只用于当前请求的阶段反馈。 */
  toolExecutionStatus?: ToolExecutionStatus;
  toolExecutionName?: string;
  /** 工具链已撞上限、正在强制总结；只用于当前请求的阶段反馈。 */
  turnLimitNoticed?: boolean;
};

/** 一次完整回答实际消耗的 token 数：输入 + 正式输出 + 推理模型的思考输出。 */
export function usageTokens(usage: AssistantUsage): number {
  return usage.prompt_tokens + usage.completion_tokens + usage.reasoning_tokens;
}

/** 1,550 → 1.6k，12,345 → 12k：回答底下只要个量级，完整数字放悬停提示里。 */
export function compactTokens(tokens: number): string {
  if (tokens < 1000) return String(tokens);
  if (tokens < 10_000) return `${(tokens / 1000).toFixed(1).replace(/\.0$/, "")}k`;
  return `${Math.round(tokens / 1000)}k`;
}

const CHECKPOINT_ACTION_LABEL_KEYS: Record<AssistantCheckpointActionKind, string> = {
  open_video: "assistantTools.open_video",
  seek_to: "assistantTools.seek_to",
  propose_rename: "assistantActions.renameTitle",
  propose_delete: "assistantActions.deleteTitle",
  propose_setting: "assistantActions.settingTitle",
  propose_import: "assistantActions.importTitle",
  propose_create_course: "assistantActions.createTitle",
  propose_rename_course: "assistantActions.courseRenameTitle",
};

export function checkpointSummary(checkpoint: AssistantCheckpoint, t: TFunction) {
  const visible = checkpoint.targets.slice(0, 3).map((target) => {
    const action = t(CHECKPOINT_ACTION_LABEL_KEYS[target.action], {
      defaultValue: target.action,
    });
    const subject =
      target.label && target.courseLabel
        ? t("assistant.checkpointTargetCourse", {
            target: target.label,
            course: target.courseLabel,
          })
        : target.label ?? target.courseLabel;
    return subject ? t("assistant.checkpointTarget", { action, target: subject }) : action;
  });
  const hidden = checkpoint.targets.length - visible.length;
  return t("assistant.checkpointSummary", {
    targets: visible.join(t("assistant.checkpointSeparator")),
    more: hidden > 0 ? t("assistant.checkpointMore", { count: hidden }) : "",
  });
}

/** 「现在在干什么」跟着流走：工具执行优先于此前已经吐出的思考或过场正文。 */
export function streamingLabelFor(turn: Turn, t: TFunction) {
  const activeToolLabel = turn.activeTool
    ? t(`assistantTools.${turn.activeTool.name}`, { defaultValue: turn.activeTool.name })
    : null;
  const finishedToolLabel = turn.toolExecutionName
    ? t(`assistantTools.${turn.toolExecutionName}`, { defaultValue: turn.toolExecutionName })
    : null;
  return activeToolLabel
    ? t("assistant.usingTool", { tool: activeToolLabel })
    : turn.turnLimitNoticed
      ? t("assistant.turnLimitSummarizing")
      : turn.toolExecutionStatus === "failed"
        ? t("assistant.toolFailedContinuing", { tool: finishedToolLabel })
        : turn.toolExecutionStatus === "canceled"
          ? t("assistant.toolCanceled", { tool: finishedToolLabel })
          : turn.answer
            ? t("assistant.answering")
            : (turn.toolRuns?.length ?? 0) > 0 || turn.tools.length
              ? t("assistant.organizing")
              : t("assistant.thinkingStatus");
}

const JUST_NOW_MIN_MS = 30_000;

export function suggestionsFor(context: AssistantContext, t: TFunction) {
  if (context.video_id) {
    // 看到一半打开助手，最想问的往往就是「刚才那段在讲什么」。开头半分钟内没有「刚才」。
    const position = context.position_ms ?? 0;
    if (position >= JUST_NOW_MIN_MS) {
      const time = formatPosition(position);
      return [
        {
          label: t("assistant.suggestJustNow", { time }),
          prompt: t("assistant.suggestJustNowPrompt", { time }),
        },
        {
          label: t("assistant.suggestSummarizeVideo"),
          prompt: t("assistant.suggestSummarizeVideoPrompt"),
        },
        {
          label: t("assistant.suggestKeyPoints"),
          prompt: t("assistant.suggestKeyPointsPrompt"),
        },
      ];
    }
    return [
      {
        label: t("assistant.suggestSummarizeVideo"),
        prompt: t("assistant.suggestSummarizeVideoPrompt"),
      },
      {
        label: t("assistant.suggestFindExamples"),
        prompt: t("assistant.suggestFindExamplesPrompt"),
      },
      {
        label: t("assistant.suggestKeyPoints"),
        prompt: t("assistant.suggestKeyPointsPrompt"),
      },
    ];
  }
  if (context.course_id) {
    return [
      {
        label: t("assistant.suggestOverviewCourse"),
        prompt: t("assistant.suggestOverviewCoursePrompt"),
      },
      {
        label: t("assistant.suggestVideoList"),
        prompt: t("assistant.suggestVideoListPrompt"),
      },
      {
        label: t("assistant.suggestCourseKeyPoints"),
        prompt: t("assistant.suggestCourseKeyPointsPrompt"),
      },
    ];
  }
  return [
    { label: t("assistant.suggestMyCourses"), prompt: t("assistant.suggestMyCoursesPrompt") },
    {
      label: t("assistant.suggestPlanStudy"),
      prompt: t("assistant.suggestPlanStudyPrompt"),
    },
    { label: t("assistant.suggestDarkMode"), prompt: t("assistant.suggestDarkModePrompt") },
  ];
}

/**
 * 把回答里裸写的时间点（12:34、1:02:03）补成方括号形式，交给时间戳渲染变成可点的跳转。
 *
 * 系统提示已要求模型写成 [12:34]，但模型并不总照做；裸写的时间点用户看得见却点不了，
 * 比全都点不了还别扭。秒位必须是两位（排除 3:2 这种比分/比例），已在方括号里的不动。
 * 只在这一轮有视频上下文时调用：没有视频，时间点无处可跳。
 */
export function bracketBareTimestamps(text: string): string {
  return text.replace(
    /(^|[^[\d:])(\d{1,2}:[0-5]\d(?::[0-5]\d)?)(?![\]\d:])/g,
    (_match, before: string, clock: string) => `${before}[${clock}]`,
  );
}

/** 「用时 4.2 秒」「用时 1 分 05 秒」：十秒内带一位小数，再长就到秒。 */
export function formatElapsed(ms: number, t: TFunction): string {
  const seconds = ms / 1000;
  if (seconds < 10) return t("assistant.elapsedSeconds", { seconds: seconds.toFixed(1) });
  if (seconds < 60) return t("assistant.elapsedSeconds", { seconds: Math.round(seconds) });
  const total = Math.round(seconds);
  return t("assistant.elapsedMinutes", {
    minutes: Math.floor(total / 60),
    seconds: String(total % 60).padStart(2, "0"),
  });
}

/** 回答正文里出现过的时间点（秒）。只认方括号形式：裸写的先经 bracketBareTimestamps 补上。 */
export function answerTimestampSeconds(text: string): Set<number> {
  const seconds = new Set<number>();
  for (const match of text.matchAll(/\[(\d{1,2}(?::[0-5]\d){1,2})\]/g)) {
    const parts = match[1].split(":").map(Number);
    seconds.add(parts.reduce((total, part) => total * 60 + part, 0));
  }
  return seconds;
}

/**
 * 去掉和正文时间戳重复的「跳到 xx:xx」按钮。
 *
 * 正文里已经有一个可点的 ▶ 07:10，下面再挂一个全宽的「跳到 07:10」，同一件事说两遍，
 * 那个白框还长得像输入框，让人犹豫点哪个。只收 seek_to：打开视频、确认卡这些正文里没有对应物。
 * 差一秒以内算同一处（模型写时间戳时会把毫秒舍掉）。`answer` 要传界面实际渲染的那段文字，
 * 裸写时间点只在补成方括号后才可点。
 */
export function withoutInlineSeeks<T extends { kind: string; at_ms?: number | null }>(
  actions: T[],
  answer: string,
): T[] {
  if (!actions.some((action) => action.kind === "seek_to")) return actions;
  const inline = answerTimestampSeconds(answer);
  if (inline.size === 0) return actions;
  return actions.filter((action) => {
    if (action.kind !== "seek_to" || action.at_ms == null) return true;
    const second = Math.floor(action.at_ms / 1000);
    return !(inline.has(second) || inline.has(second - 1) || inline.has(second + 1));
  });
}
