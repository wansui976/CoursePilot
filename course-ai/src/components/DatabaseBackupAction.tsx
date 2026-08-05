import { useState } from "react";
import { useTranslation } from "react-i18next";
import { save } from "@tauri-apps/plugin-dialog";
import { Download, Share2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { humanizeError } from "@/lib/errors";
import { ipc } from "@/lib/ipc";
import { shareFile } from "@/lib/mobileFiles";
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
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<
    { kind: "success" | "error"; text: string } | undefined
  >();

  async function backup() {
    if (busy) return;
    setBusy(true);
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
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col items-start gap-2 sm:items-end">
      <Button size="sm" variant="outline" disabled={busy} onClick={() => void backup()}>
        {mobile ? <Share2 className="h-3.5 w-3.5" /> : <Download className="h-3.5 w-3.5" />}
        {busy ? t("backup.busy") : mobile ? t("backup.shareButton") : t("backup.saveButton")}
      </Button>
      {status && (
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
