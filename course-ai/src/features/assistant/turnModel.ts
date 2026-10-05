import type { TFunction } from "i18next";
import type {
  AssistantCheckpoint,
  AssistantCheckpointActionKind,
  AssistantTurnRecord,
} from "@/lib/assistantSession";
import type { AssistantContext, AssistantUsage, ToolExecutionStatus } from "@/lib/types";

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

export function suggestionsFor(context: AssistantContext, t: TFunction) {
  if (context.video_id) {
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
