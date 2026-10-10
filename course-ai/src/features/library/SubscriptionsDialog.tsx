import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { RefreshCw, Rss, Trash2 } from "lucide-react";
import { ipc } from "@/lib/ipc";
import { qk } from "@/lib/queryKeys";
import { humanizeError } from "@/lib/errors";
import { relativeDay, localDay } from "@/lib/studyStats";
import { Button } from "@/ui/button";
import { Modal } from "@/ui/dialog";
import { ErrorNote } from "@/ui/ErrorNote";

/**
 * 某课程的订阅：列出跟踪中的合集 / 播放列表，可立即检查或取消订阅。
 * 新订阅从「导入播放列表 / 合集」对话框里勾选创建。
 */
export function SubscriptionsDialog({
  courseId,
  courseName,
  onClose,
}: {
  courseId: string;
  courseName: string;
  onClose: () => void;
}) {
  const { t, i18n } = useTranslation();
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: qk.subscriptions(courseId),
    queryFn: () => ipc.subscriptions.list(courseId),
  });
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: qk.subscriptions(courseId) });
    void queryClient.invalidateQueries({ queryKey: qk.videos.list(courseId) });
  };
  const check = useMutation({
    mutationFn: (id: string) => ipc.subscriptions.check(id),
    onSettled: refresh,
  });
  const remove = useMutation({
    mutationFn: (id: string) => ipc.subscriptions.remove(id),
    onSettled: refresh,
  });
  const today = localDay(new Date());
  const subscriptions = query.data ?? [];

  return (
    <Modal
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={t("subscriptions.title", { course: courseName })}
      icon={<Rss className="h-5 w-5" />}
      description={t("subscriptions.description")}
    >
      {query.isError && <ErrorNote error={query.error} onRetry={() => void query.refetch()} />}
      {!query.isPending && !query.isError && subscriptions.length === 0 && (
        <p className="rounded-md bg-[var(--surface-card)] px-3 py-3 text-sm text-[var(--text-muted)]">
          {t("subscriptions.empty")}
        </p>
      )}
      <ul className="space-y-2">
        {subscriptions.map((sub) => {
          const checking = check.isPending && check.variables === sub.id;
          const checkedText = sub.last_checked_at
            ? t("subscriptions.lastChecked", { when: relativeDay(sub.last_checked_at, today, i18n.language) })
            : t("subscriptions.neverChecked");
          return (
            <li
              key={sub.id}
              className="rounded-md border border-[var(--border-subtle)] px-3 py-2.5"
            >
              <div className="flex items-start gap-2">
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium text-[var(--text-strong)]">{sub.title || sub.url}</div>
                  <div className="truncate text-xs text-[var(--text-faint)]" title={sub.url}>
                    {sub.url}
                  </div>
                  <div className="mt-1 text-xs text-[var(--text-muted)]">{checkedText}</div>
                  {sub.last_error && (
                    <div role="status" className="mt-1 text-xs text-[var(--status-warn)]">
                      {t("subscriptions.lastError", { error: sub.last_error })}
                    </div>
                  )}
                  {check.isSuccess && check.variables === sub.id && (
                    <div role="status" className="mt-1 text-xs text-[var(--status-ok)]">
                      {check.data > 0
                        ? t("subscriptions.imported", { count: check.data })
                        : t("subscriptions.upToDate")}
                    </div>
                  )}
                  {check.isError && check.variables === sub.id && (
                    <div role="alert" className="mt-1 text-xs text-[var(--status-err)]">
                      {humanizeError(check.error)}
                    </div>
                  )}
                </div>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={check.isPending}
                  onClick={() => check.mutate(sub.id)}
                  aria-label={t("subscriptions.checkNowLabel", { title: sub.title })}
                >
                  <RefreshCw className={`h-3.5 w-3.5 ${checking ? "animate-spin" : ""}`} />
                  {checking ? t("subscriptions.checking") : t("subscriptions.checkNow")}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={remove.isPending || checking}
                  onClick={() => remove.mutate(sub.id)}
                  aria-label={t("subscriptions.unsubscribeLabel", { title: sub.title })}
                  title={t("subscriptions.unsubscribe")}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </div>
            </li>
          );
        })}
      </ul>
    </Modal>
  );
}
