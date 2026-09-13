import type { RefObject } from "react";
import { useTranslation } from "react-i18next";
import { Check, LoaderCircle, PenLine, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { AssistantConversationsState } from "@/lib/assistantConversations";

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
