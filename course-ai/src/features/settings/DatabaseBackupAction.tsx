import { Modal } from "@/ui/dialog";
import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { save } from "@tauri-apps/plugin-dialog";
import { Download, RotateCcw, Share2 } from "lucide-react";
import { Button } from "@/ui/button";
import { humanizeError } from "@/lib/errors";
import { ipc } from "@/lib/ipc";
import { pickPersistedFile, shareFile } from "@/lib/mobileFiles";
import { isMobile } from "@/lib/platform";

const SQLITE_MIME = "application/vnd.sqlite3";

function suggestedBackupName(now = new Date()): string {
  const part = (value: number) => String(value).padStart(2, "0");
  return [
    "CoursePilot-backup-",
    now.getFullYear(),
    part(now.getMonth() + 1),
    part(now.getDate()),
    "-",
    part(now.getHours()),
    part(now.getMinutes()),
    part(now.getSeconds()),
    ".db",
  ].join("");
}

function fileName(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

export function DatabaseBackupAction() {
  const { t } = useTranslation();
  const mobile = isMobile();
  const restoreTriggerRef = useRef<HTMLButtonElement>(null);
  const cancelRestoreRef = useRef<HTMLButtonElement>(null);
  const [busy, setBusy] = useState<"backup" | "restore" | null>(null);
  const [pendingRestore, setPendingRestore] = useState<{
    path: string;
    name: string;
  }>();
  const [status, setStatus] = useState<
    { kind: "success" | "error"; text: string } | undefined
  >();

  function closeRestoreConfirmation() {
    setPendingRestore(undefined);
  }

  async function backup() {
    if (busy) return;
    setBusy("backup");
    setStatus(undefined);
    try {
      let destinationPath: string | null = null;
      if (!mobile) {
        destinationPath = await save({
          defaultPath: suggestedBackupName(),
          filters: [{ name: t("backup.sqliteFilter"), extensions: ["db"] }],
        });
        if (!destinationPath) return;
      }

      const path = await ipc.backup.create(destinationPath);
      if (mobile) {
        await shareFile(path, SQLITE_MIME);
      }
      setStatus({
        kind: "success",
        text: mobile ? t("backup.backupShared") : t("backup.backupDone", { fileName: fileName(path) }),
      });
    } catch (error) {
      setStatus({ kind: "error", text: t("backup.backupFailed", { error: humanizeError(error) }) });
    } finally {
      setBusy(null);
    }
  }

  async function chooseRestore() {
    if (busy) return;
    setStatus(undefined);
    try {
      const picked = await pickPersistedFile({
        category: "database-restore-imports",
        fallbackName: `CoursePilot-restore-${Date.now()}.db`,
        filters: [{ name: t("backup.sqliteFilter"), extensions: ["db", "sqlite", "sqlite3"] }],
        prompt: t("backup.restore.pickerPrompt"),
      });
      if (!picked) return;
      setPendingRestore({ path: picked.path, name: fileName(picked.path) });
    } catch (error) {
      setStatus({
        kind: "error",
        text: t("backup.restore.failed", { error: humanizeError(error) }),
      });
    }
  }

  async function restore() {
    if (busy || !pendingRestore) return;
    setBusy("restore");
    setStatus(undefined);
    try {
      const result = await ipc.backup.restore(pendingRestore.path);
      closeRestoreConfirmation();
      setStatus({
        kind: "success",
        text: result.restartRequested
          ? t("backup.restore.restarting")
          : result.requiresRestart
            ? t("backup.restore.restartRequired")
            : t("backup.restore.ready"),
      });
    } catch (error) {
      setStatus({
        kind: "error",
        text: t("backup.restore.failed", { error: humanizeError(error) }),
      });
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="flex w-full flex-col items-start gap-2 sm:min-w-72 sm:items-end">
      <div className="flex w-full flex-wrap items-center gap-2 sm:justify-end">
        <Button
          size="sm"
          variant="outline"
          disabled={busy !== null}
          onClick={() => void backup()}
        >
          {mobile ? (
            <Share2 className="h-3.5 w-3.5" />
          ) : (
            <Download className="h-3.5 w-3.5" />
          )}
          {busy === "backup"
            ? t("backup.busy")
            : mobile
              ? t("backup.shareButton")
              : t("backup.saveButton")}
        </Button>
        <Button
          ref={restoreTriggerRef}
          size="sm"
          variant="outline"
          disabled={busy !== null}
          onClick={() => void chooseRestore()}
        >
          <RotateCcw className="h-3.5 w-3.5" />
          {busy === "restore" ? t("backup.restore.busy") : t("backup.restore.button")}
        </Button>
      </div>
      <Modal
        open={pendingRestore != null}
        onOpenChange={(open) => {
          if (!open) closeRestoreConfirmation();
        }}
        locked={busy === "restore"}
        role="alertdialog"
        tone="warning"
        size="sm"
        className="text-left"
        title={t("backup.restore.confirmTitle")}
        description={t(
          mobile ? "backup.restore.confirmBodyMobile" : "backup.restore.confirmBodyDesktop",
          { fileName: pendingRestore?.name ?? "" },
        )}
        descriptionClassName="mt-2"
        overlayTestId="database-restore-overlay"
        initialFocusRef={cancelRestoreRef}
        returnFocusTo={() => restoreTriggerRef.current}
      >
        {status?.kind === "error" && (
          <p
            role="alert"
            className="mt-3 rounded-lg bg-[var(--status-err-bg)] px-3 py-2 text-xs leading-relaxed text-[var(--status-err)]"
          >
            {status.text}
          </p>
        )}
        <div className="mt-4 flex flex-wrap justify-end gap-2">
          <Button
            ref={cancelRestoreRef}
            size="sm"
            variant="ghost"
            disabled={busy !== null}
            onClick={closeRestoreConfirmation}
          >
            {t("common.cancel")}
          </Button>
          <Button
            size="sm"
            variant="destructive"
            disabled={busy !== null}
            onClick={() => void restore()}
          >
            <RotateCcw className="h-3.5 w-3.5" />
            {busy === "restore"
              ? t("backup.restore.busy")
              : t("backup.restore.confirmButton")}
          </Button>
        </div>
      </Modal>
      {status && !pendingRestore && (
        <p
          role={status.kind === "error" ? "alert" : "status"}
          className={`max-w-full text-xs ${
            status.kind === "error"
              ? "text-[var(--status-err)]"
              : "text-[var(--status-ok)]"
          }`}
          title={status.text}
        >
          {status.text}
        </p>
      )}
    </div>
  );
}
