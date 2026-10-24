import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Button } from "@/ui/button";
import {
  autoCheckForUpdate,
  pendingUpdate,
  useRunningVersion,
  useUpdate,
} from "@/lib/updateCheck";

/** 课程库首页上的一行新版本提示。启动后问一次 GitHub，没有更新就什么都不显示。 */
export function UpdateNotice({ className = "" }: { className?: string }) {
  const { t } = useTranslation();
  const running = useRunningVersion();
  const result = useUpdate((s) => s.result);
  const ignored = useUpdate((s) => s.ignored);
  const ignore = useUpdate((s) => s.ignore);

  useEffect(() => {
    if (running) void autoCheckForUpdate(running);
  }, [running]);

  const update = pendingUpdate(result, ignored, running);
  if (!update) return null;
  return (
    <div
      role="status"
      className={`flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-card)] px-3 py-2 text-sm text-[var(--text-strong)] ${className}`}
    >
      <span className="min-w-0 flex-1">
        {t("update.available", { version: update.latest })}
      </span>
      <div className="flex flex-none gap-2">
        <Button variant="outline" size="sm" onClick={() => void openUrl(update.url)}>
          {t("update.view")}
        </Button>
        <Button variant="ghost" size="sm" onClick={() => ignore(update.latest)}>
          {t("update.ignore")}
        </Button>
      </div>
    </div>
  );
}
