import { useMemo, type RefObject } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { useQueries, useQuery } from "@tanstack/react-query";
import { Check, LoaderCircle, PenLine, PlayCircle, Trash2 } from "lucide-react";
import { Button } from "@/ui/button";
import type {
  AssistantConversationSource,
  AssistantConversationsState,
} from "@/lib/assistantConversations";
import { queries } from "@/lib/queries";
import { displayTitle } from "@/lib/videoTitle";

/**
 * 会话历史列表：切换、重命名、删除。
 * 从 AssistantPanel 拆出的受控视图——状态与持久化都留在面板里，
 * 这里只负责把列表画出来并把操作事件抛回去。
 */

function formatConversationTime(updatedAt: number, locale: string) {
  try {
    return new Intl.DateTimeFormat(locale, {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    }).format(new Date(updatedAt));
  } catch {
    return "";
  }
}

/**
 * 把各会话的出处 id 解析成名字。只读课程和各课程视频列表的缓存（资料库页面平时就在用），
 * 不为历史列表单独开后端查询；视频被删了就退回课程名。
 */
function useSourceNames(conversations: AssistantConversationsState) {
  const courseIds = useMemo(() => {
    const ids = new Set<string>();
    for (const conversation of conversations.conversations) {
      for (const source of conversation.sources ?? []) {
        if (source.course_id) ids.add(source.course_id);
      }
    }
    return [...ids];
  }, [conversations]);
  const courses = useQuery({ ...queries.courses(), enabled: courseIds.length > 0 });
  const videoLists = useQueries({ queries: courseIds.map((id) => queries.videos(id)) });
  return useMemo(() => {
    const courseNames = new Map<string, string>();
    for (const course of courses.data ?? []) courseNames.set(course.id, course.name);
    const videoTitles = new Map<string, string>();
    for (const list of videoLists) {
      for (const video of list.data ?? []) videoTitles.set(video.id, displayTitle(video.title));
    }
    return { courseNames, videoTitles };
    // useQueries 每次渲染都返回新数组；按各列表的数据引用判断是否需要重算。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [courses.data, ...videoLists.map((list) => list.data)]);
}

/** 「出自《视频》」；多个视频时只写第一个再加「等 N 个视频」，没有视频时写课程名。 */
function sourceLabel(
  sources: AssistantConversationSource[] | undefined,
  names: ReturnType<typeof useSourceNames>,
  t: TFunction,
): string | null {
  if (!sources?.length) return null;
  const labels = sources
    .map((source) =>
      (source.video_id && names.videoTitles.get(source.video_id)) ||
      (source.course_id && names.courseNames.get(source.course_id)) ||
      null,
    )
    .filter((label): label is string => !!label);
  if (labels.length === 0) return null;
  return labels.length === 1
    ? labels[0]
    : t("assistant.conversationSourceMore", {
        first: labels[0],
        count: labels.length,
        others: labels.length - 1,
      });
}

export function ConversationHistory({
  conversations,
  error,
  statusAnnouncement,
  busy,
  actionExecutionBusy,
  conversationMutationBusy,
  renamingId,
  renameDraft,
  deletingConversationId,
  conversationButtonRefs,
  renameButtonRefs,
  deleteButtonRefs,
  onSwitch,
  onStartRename,
  onRenameDraftChange,
  onSubmitRename,
  onCancelRename,
  onRemove,
}: {
  conversations: AssistantConversationsState;
  error: string;
  statusAnnouncement: string;
  busy: boolean;
  actionExecutionBusy: boolean;
  conversationMutationBusy: boolean;
  renamingId: string | null;
  renameDraft: string;
  deletingConversationId: string | null;
  conversationButtonRefs: RefObject<Map<string, HTMLButtonElement>>;
  renameButtonRefs: RefObject<Map<string, HTMLButtonElement>>;
  deleteButtonRefs: RefObject<Map<string, HTMLButtonElement>>;
  onSwitch: (conversationId: string) => void;
  onStartRename: (conversationId: string, title: string) => void;
  onRenameDraftChange: (draft: string) => void;
  onSubmitRename: (conversationId: string) => void;
  onCancelRename: (conversationId: string) => void;
  onRemove: (conversationId: string) => void;
}) {
  const { t, i18n } = useTranslation();
  const locked = busy || actionExecutionBusy || conversationMutationBusy;
  const sourceNames = useSourceNames(conversations);

  return (
    <section
      id="assistant-conversation-history"
      aria-labelledby="assistant-conversation-history-title"
      className="flex min-h-0 flex-1 flex-col"
    >
      <div className="border-b border-[var(--border-subtle)] px-3 py-2.5">
        <h2
          id="assistant-conversation-history-title"
          className="text-sm font-medium text-[var(--text-strong)]"
        >
          {t("assistant.conversationHistory")}
        </h2>
      </div>
      {error && (
        <div
          role="alert"
          className="mx-3 mb-1 mt-2 border-l-2 border-[var(--status-err)] pl-2 text-xs text-[var(--status-err)]"
        >
          <span>{error}</span>
        </div>
      )}
      {conversations.conversations.length > 0 ? (
        <div
          role="list"
          aria-label={t("assistant.conversationList")}
          className="min-h-0 flex-1 overflow-y-auto"
        >
          {conversations.conversations.map((conversation) => {
            const current = conversation.id === conversations.activeId;
            const updatedAt = formatConversationTime(
              conversation.updatedAt,
              i18n.resolvedLanguage ?? i18n.language,
            );
            const conversationTitle =
              conversation.title || t("assistant.untitledConversation");
            const source = sourceLabel(conversation.sources, sourceNames, t);
            return (
              <div
                key={conversation.id}
                role="listitem"
                className="flex items-center border-b border-[var(--border-subtle)]"
              >
                {renamingId === conversation.id ? (
                  <div className="flex min-h-[52px] min-w-0 flex-1 items-center gap-2 px-3 py-2">
                    <input
                      autoFocus
                      value={renameDraft}
                      onChange={(event) => onRenameDraftChange(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter" && !event.nativeEvent.isComposing) {
                          event.preventDefault();
                          event.stopPropagation();
                          onSubmitRename(conversation.id);
                        } else if (event.key === "Escape") {
                          event.preventDefault();
                          event.stopPropagation();
                          onCancelRename(conversation.id);
                        }
                      }}
                      aria-label={t("assistant.renameConversationLabel")}
                      className="min-w-0 flex-1 rounded-md border border-[var(--border-subtle)] bg-[var(--surface-input)] px-2 py-1 text-sm text-[var(--text-strong)] outline-none focus-visible:border-[var(--focus-ring)]"
                    />
                    <Button
                      size="icon"
                      variant="ghost"
                      aria-label={t("assistant.renameSaveTarget", {
                        title: renameDraft.trim() || conversationTitle,
                      })}
                      disabled={conversationMutationBusy}
                      onClick={() => onSubmitRename(conversation.id)}
                      className="ca-touch-44 h-8 w-8"
                    >
                      <Check className="h-4 w-4" />
                    </Button>
                  </div>
                ) : (
                  <button
                    ref={(node) => {
                      if (node) conversationButtonRefs.current.set(conversation.id, node);
                      else conversationButtonRefs.current.delete(conversation.id);
                    }}
                    type="button"
                    aria-current={current ? "true" : undefined}
                    disabled={locked}
                    onClick={() => onSwitch(conversation.id)}
                    className="ca-touch-44 flex min-h-[52px] min-w-0 flex-1 items-center gap-3 px-3 py-2.5 text-left transition-colors hover:bg-[var(--surface-card-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--focus-ring)] disabled:cursor-not-allowed disabled:opacity-50 motion-reduce:transition-none"
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm text-[var(--text-strong)]">
                        {conversationTitle}
                      </span>
                      {source && (
                        <span
                          className="mt-0.5 flex min-w-0 items-center gap-1 ca-t-2xs text-[var(--text-muted)]"
                          title={source}
                        >
                          <PlayCircle className="h-3 w-3 flex-none" aria-hidden="true" />
                          <span className="sr-only">{t("assistant.conversationSource")}</span>
                          <span className="truncate">{source}</span>
                        </span>
                      )}
                      {updatedAt && (
                        <time
                          dateTime={new Date(conversation.updatedAt).toISOString()}
                          className="mt-0.5 block ca-t-2xs text-[var(--text-faint)]"
                        >
                          {updatedAt}
                        </time>
                      )}
                    </span>
                    {current && (
                      <span className="flex flex-none items-center gap-1 ca-t-2xs text-[var(--accent-text)]">
                        <Check className="h-3.5 w-3.5" aria-hidden="true" />
                        {t("assistant.currentConversation")}
                      </span>
                    )}
                  </button>
                )}
                {renamingId !== conversation.id && (
                  <button
                    ref={(node) => {
                      if (node) renameButtonRefs.current.set(conversation.id, node);
                      else renameButtonRefs.current.delete(conversation.id);
                    }}
                    type="button"
                    aria-label={t("assistant.renameConversationTarget", {
                      title: conversationTitle,
                    })}
                    title={t("assistant.renameConversationTarget", {
                      title: conversationTitle,
                    })}
                    disabled={locked}
                    onClick={() => onStartRename(conversation.id, conversation.title)}
                    className="ca-touch-44 grid h-8 w-8 flex-none place-items-center rounded-md text-[var(--text-faint)] transition-colors hover:bg-[var(--surface-card-hover)] hover:text-[var(--text-strong)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--focus-ring)]"
                  >
                    <PenLine className="h-3.5 w-3.5" />
                  </button>
                )}
                <button
                  ref={(node) => {
                    if (node) deleteButtonRefs.current.set(conversation.id, node);
                    else deleteButtonRefs.current.delete(conversation.id);
                  }}
                  type="button"
                  aria-label={t("assistant.deleteConversationTarget", {
                    title: conversationTitle,
                  })}
                  title={t("assistant.deleteConversationTarget", {
                    title: conversationTitle,
                  })}
                  disabled={locked}
                  onClick={() => onRemove(conversation.id)}
                  className="ca-touch-44 grid h-8 w-8 flex-none place-items-center rounded-md text-[var(--text-faint)] transition-colors hover:bg-[var(--surface-card-hover)] hover:text-[var(--status-err)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--focus-ring)] disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {deletingConversationId === conversation.id ? (
                    <LoaderCircle className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                  ) : (
                    <Trash2 className="h-3.5 w-3.5" />
                  )}
                </button>
              </div>
            );
          })}
        </div>
      ) : (
        <p className="px-3 py-6 text-center text-xs text-[var(--text-faint)]">
          {t("assistant.emptyConversationHistory")}
        </p>
      )}
      <div role="status" aria-live="polite" aria-atomic="true" className="sr-only">
        {statusAnnouncement}
      </div>
    </section>
  );
}
