import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { openUrl } from "@tauri-apps/plugin-opener";
import { listen } from "@tauri-apps/api/event";
import { confirm as confirmDialog } from "@tauri-apps/plugin-dialog";
import { Button } from "@/ui/button";
import { ipc } from "@/lib/ipc";
import { humanizeError } from "@/lib/errors";
import { useJobs } from "@/stores/jobs";
import {
  autoCheckForUpdate,
  pendingUpdate,
  useRunningVersion,
  useUpdate,
} from "@/lib/updateCheck";

/**
 * 课程库首页上的一行新版本提示。启动后问一次 GitHub，没有更新就什么都不显示。
 *
 * 电脑上再问一次自动更新（latest.json）：这个版本有签过名的更新包，就给「立即更新」——
 * 下载、校验签名、安装、重启，不用再去发布页下载、也不用再处理 macOS 的「已损坏」。
 * 查不到（旧版本发布时还没有更新包、网络不通、手机）就只留「查看更新」。
 */
export function UpdateNotice({ className = "" }: { className?: string }) {
  const { t } = useTranslation();
  const running = useRunningVersion();
  const result = useUpdate((s) => s.result);
  const ignored = useUpdate((s) => s.ignored);
  const ignore = useUpdate((s) => s.ignore);
  const [installable, setInstallable] = useState(false);
  const [progress, setProgress] = useState<number | "unknown" | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (running) void autoCheckForUpdate(running);
  }, [running]);

  const update = pendingUpdate(result, ignored, running);
  const latest = update?.latest ?? null;
  useEffect(() => {
    if (!latest) return;
    let alive = true;
    void ipc.app
      .updaterCheck()
      .then((found) => alive && setInstallable(found?.version === latest))
      .catch(() => alive && setInstallable(false));
    return () => {
      alive = false;
    };
  }, [latest]);

  async function install() {
    // 正在处理的视频会被重启打断（重启后标成失败、要手动重试），先问一句。
    const busy = Object.values(useJobs.getState().byVideo).some((stages) =>
      Object.values(stages).some((job) => job.status === "running"),
    );
    if (
      busy &&
      !(await confirmDialog(t("update.busyConfirm"), {
        title: t("update.busyTitle"),
        kind: "warning",
        okLabel: t("update.install"),
        cancelLabel: t("common.cancel"),
      }))
    ) {
      return;
    }
    setError(null);
    setProgress("unknown");
    const unlisten = await listen<{ downloaded: number; total: number | null }>("updater:progress", (event) => {
      const { downloaded, total } = event.payload;
      setProgress(total ? Math.min(1, downloaded / total) : "unknown");
    });
    try {
      // 成功的话装完就重启，这里不会再往下走。
      await ipc.app.updaterInstall();
    } catch (err) {
      setError(humanizeError(err));
      setProgress(null);
    } finally {
      unlisten();
    }
  }

  if (!update) return null;
  const busy = progress !== null;
  return (
    <div
      role="status"
      className={`flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-card)] px-3 py-2 text-sm text-[var(--text-strong)] ${className}`}
    >
      <span className="min-w-0 flex-1">
        {busy
          ? progress === "unknown"
            ? t("update.installingUnknown")
            : t("update.installing", { percent: Math.floor(progress * 100) })
          : t("update.available", { version: update.latest })}
        {error && (
          <span className="mt-1 block text-xs text-[var(--status-err)]">{t("update.failed", { error })}</span>
        )}
      </span>
      <div className="flex flex-none gap-2">
        {installable && (
          <Button size="sm" disabled={busy} onClick={() => void install()}>
            {t("update.install")}
          </Button>
        )}
        <Button variant="outline" size="sm" disabled={busy} onClick={() => void openUrl(update.url)}>
          {t("update.view")}
        </Button>
        {!busy && (
          <Button variant="ghost" size="sm" onClick={() => ignore(update.latest)}>
            {t("update.ignore")}
          </Button>
        )}
      </div>
    </div>
  );
}
