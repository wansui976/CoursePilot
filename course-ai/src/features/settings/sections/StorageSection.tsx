import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { confirm as confirmDialog } from "@tauri-apps/plugin-dialog";
import { Button } from "@/ui/button";
import { DatabaseBackupAction } from "@/features/settings/DatabaseBackupAction";
import { FIELD, Group, Row, StackRow } from "@/features/settings/primitives";
import type { SettingsForm } from "@/features/settings/useSettingsForm";
import { ipc } from "@/lib/ipc";
import { isMobile } from "@/lib/platform";
import type { StorageUsage } from "@/lib/types";

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const digits = unit === 0 ? 0 : value >= 100 ? 0 : 1;
  return `${value.toFixed(digits)} ${units[unit]}`;
}

/**
 * 手机端的存储页。
 *
 * 手机上视频是导入时复制进应用私有目录的，系统文件管理器访问不到；原先这里显示一个
 * 「默认数据根目录」选择器，选出来的路径后端并不会用（移动端固定放 app data），
 * 用户既打不开也不知道空间去哪了。现在改成：说明位置 + 占用明细 + 清空回收站。
 */
function MobileStorage() {
  const { t } = useTranslation();
  const [usage, setUsage] = useState<StorageUsage | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [loading, setLoading] = useState(true);
  const [clearing, setClearing] = useState(false);
  const [cleaning, setCleaning] = useState(false);
  const [reloadToken, setReloadToken] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void ipc.app
      .storageUsage()
      .then((next) => {
        if (cancelled) return;
        setUsage(next);
        setError("");
      })
      .catch((cause) => {
        if (!cancelled) setError(String(cause));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [reloadToken]);

  const trashBytes = usage
    ? usage.trash_video_bytes + usage.trash_derived_bytes
    : 0;
  const size = (bytes?: number) =>
    loading ? "…" : bytes == null ? "—" : formatBytes(bytes);

  async function clearTrash() {
    if (!usage || usage.trashed_count === 0 || clearing) return;
    const ok = await confirmDialog(
      t("settings.storage.clearTrashConfirm", {
        count: usage.trashed_count,
        size: formatBytes(trashBytes),
      }),
      {
        title: t("settings.storage.clearTrashTitle"),
        kind: "warning",
        okLabel: t("settings.storage.clearTrash"),
        cancelLabel: t("common.cancel"),
      },
    );
    if (!ok) return;
    setClearing(true);
    try {
      await ipc.trash.purgeAll();
      setError("");
      setNotice(
        t("settings.storage.trashCleared", { size: formatBytes(trashBytes) }),
      );
      // 重新统计；列表/课程查询在回到对应页面时会按正常失效逻辑重取。
      setReloadToken((value) => value + 1);
    } catch (cause) {
      setError(String(cause));
    } finally {
      setClearing(false);
    }
  }

  async function cleanupOrphans() {
    if (cleaning || loading) return;
    const ok = await confirmDialog(t("settings.storage.cleanupConfirm"), {
      title: t("settings.storage.cleanupTitle"),
      kind: "warning",
      okLabel: t("settings.storage.cleanup"),
      cancelLabel: t("common.cancel"),
    });
    if (!ok) return;
    setCleaning(true);
    try {
      const result = await ipc.app.cleanupOrphanMedia();
      setError("");
      setNotice(
        t("settings.storage.cleanupDone", {
          size: formatBytes(result.freed_bytes),
          count: result.deleted_files + result.deleted_dirs,
        }),
      );
      setReloadToken((value) => value + 1);
    } catch (cause) {
      setError(String(cause));
    } finally {
      setCleaning(false);
    }
  }

  return (
    <Group
      header={t("settings.storage.mobileTitle")}
      footnote={t("settings.storage.mobileHint")}
    >
      <Row label={t("settings.storage.total")}>
        <span className="tabular-nums ca-t-sm text-[var(--text-normal)]">
          {size(usage?.total_bytes)}
        </span>
      </Row>
      <Row label={t("settings.storage.videoFiles")}>
        <span className="tabular-nums ca-t-sm text-[var(--text-normal)]">
          {size(usage?.video_bytes)}
        </span>
      </Row>
      <Row label={t("settings.storage.derivedFiles")}>
        <span className="tabular-nums ca-t-sm text-[var(--text-normal)]">
          {size(usage?.derived_bytes)}
        </span>
      </Row>
      <Row
        label={t("settings.storage.trash")}
        status={
          usage
            ? t("settings.storage.trashCount", { count: usage.trashed_count })
            : undefined
        }
      >
        <div className="flex items-center gap-2">
          <span className="tabular-nums ca-t-sm text-[var(--text-normal)]">
            {size(trashBytes)}
          </span>
          <Button
            size="sm"
            variant="outline"
            onClick={() => void clearTrash()}
            disabled={
              clearing || loading || !usage || usage.trashed_count === 0
            }
          >
            {clearing
              ? t("settings.storage.clearing")
              : t("settings.storage.clearTrash")}
          </Button>
        </div>
      </Row>
      <Row label={t("settings.storage.other")}>
        <span className="tabular-nums ca-t-sm text-[var(--text-normal)]">
          {size(usage?.other_bytes)}
        </span>
      </Row>
      <Row
        label={t("settings.storage.orphanTitle")}
        hint={t("settings.storage.orphanHint")}
      >
        <Button
          size="sm"
          variant="outline"
          onClick={() => void cleanupOrphans()}
          disabled={cleaning || clearing || loading}
        >
          {cleaning
            ? t("settings.storage.cleaning")
            : t("settings.storage.cleanup")}
        </Button>
      </Row>
      {notice && (
        <p
          role="status"
          className="px-4 py-3 text-xs leading-relaxed text-[var(--status-ok)]"
        >
          {notice}
        </p>
      )}
      {error && (
        <p
          role="alert"
          className="px-4 py-3 text-xs leading-relaxed text-[var(--status-err)]"
        >
          {t("settings.storage.usageError", { error })}
        </p>
      )}
    </Group>
  );
}

/** 存储位置与数据备份。 */
export function StorageSection({ form }: { form: SettingsForm }) {
  const { t } = useTranslation();
  const {
    root,
    pickRoot,
    clearRoot,
  } = form;

  return (
    <>
      {isMobile() ? (
        <MobileStorage />
      ) : (
        <Group
          header={t("settings.storage.title")}
          hint={t("settings.storage.footnote")}
        >
          <StackRow label={t("settings.storage.defaultRoot")}>
            <div className="flex items-center gap-2">
              <input className={FIELD} value={root} readOnly placeholder={t("settings.storage.notSet")} />
              <Button size="sm" variant="outline" onClick={pickRoot}>
                {t("settings.storage.select")}
              </Button>
              {root && (
                <Button size="sm" variant="ghost" onClick={() => void clearRoot()}>
                  {t("settings.storage.clear")}
                </Button>
              )}
            </div>
          </StackRow>
        </Group>
      )}
      <Group
        header={t("settings.storage.security")}
        hint={t("settings.storage.securityFootnote")}
      >
        <Row
          label={t("backup.label")}
          hint={t("backup.hint")}
        >
          <DatabaseBackupAction />
        </Row>
      </Group>
    </>
  );
}
