import type { TFunction } from "i18next";
import type { AssistantSession } from "@/lib/assistantSession";
import {
  createAssistantConversation,
  readAssistantConversation,
  readAssistantConversations,
} from "@/lib/assistantConversations";
import type { AgentStopReason, AssistantContext, AssistantReply } from "@/lib/types";
import type { ScopeChoice, ScopeOption } from "./AssistantComposer";

/** 助手面板的纯函数：会话初始化、提问范围、滚动与焦点判断。 */

const SCROLL_FOLLOW_THRESHOLD = 32;
const FOCUSABLE_SELECTOR =
  'button:not([disabled]), textarea:not([disabled]), input:not([disabled]), summary, [href], [tabindex]:not([tabindex="-1"])';

/** 呼出快捷键的显示写法。Mac 用 ⌘，其余平台用 Ctrl。 */
export function toggleShortcutLabel() {
  if (typeof navigator === "undefined") return "Ctrl+J";
  return /Mac|iPhone|iPad|iPod/i.test(navigator.userAgent) ? "⌘J" : "Ctrl+J";
}


export const EMPTY_ASSISTANT_SESSION: AssistantSession = { turns: [], history: [], draft: "" };

export function initialAssistantConversation() {
  let conversations = readAssistantConversations();
  if (!conversations.activeId) conversations = createAssistantConversation();
  const activeId = conversations.activeId;
  const session = activeId
    ? (readAssistantConversation(activeId)?.session ?? EMPTY_ASSISTANT_SESSION)
    : EMPTY_ASSISTANT_SESSION;
  return { conversations, session };
}

export function normalizedStopReason(reply: AssistantReply): AgentStopReason {
  if (reply.stop_reason) return reply.stop_reason;
  if (reply.canceled) return "canceled";
  if (reply.hit_turn_limit) return "limit_reached";
  return "completed";
}

function formatPosition(ms: number) {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(seconds / 60);
  return `${String(minutes).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}

export function isNearScrollEnd(box: HTMLElement) {
  return box.scrollHeight - box.scrollTop - box.clientHeight <= SCROLL_FOLLOW_THRESHOLD;
}

export function focusableElements(container: HTMLElement) {
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
    (element) => !element.hasAttribute("hidden") && element.getAttribute("aria-hidden") !== "true",
  );
}

export function contextLabel(context: AssistantContext, t: TFunction) {
  if (context.video_id) {
    return context.position_ms != null && context.position_ms > 0
      ? t("assistant.scopeCurrentVideoAt", { position: formatPosition(context.position_ms) })
      : t("assistant.scopeCurrentVideo");
  }
  if (context.course_id) return t("assistant.scopeCurrentCourse");
  return t("assistant.scopeAllCourses");
}

export type ResolvedScope = "video" | "course" | "all";

/** 范围选择：auto 跟随界面当前选中项；显式三档在对应上下文存在时才生效。 */
export function resolveScope(choice: ScopeChoice, context: AssistantContext): ResolvedScope {
  if (choice === "video" && context.video_id) return "video";
  if (choice === "course" && context.course_id) return "course";
  if (choice === "all") return "all";
  return context.video_id ? "video" : context.course_id ? "course" : "all";
}

export function scopedContext(context: AssistantContext, scope: ResolvedScope): AssistantContext {
  if (scope === "video") return context;
  if (scope === "course") return { course_id: context.course_id, video_id: null, position_ms: null };
  return { course_id: null, video_id: null, position_ms: null };
}

export function scopeOptionsFor(context: AssistantContext, t: TFunction): ScopeOption[] {
  return [
    { value: "auto", label: t("assistant.scopeAuto"), enabled: true },
    { value: "video", label: t("assistant.scopeCurrentVideo"), enabled: Boolean(context.video_id) },
    { value: "course", label: t("assistant.scopeCurrentCourse"), enabled: Boolean(context.course_id) },
    { value: "all", label: t("assistant.scopeAllCourses"), enabled: true },
  ];
}
