import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Loader2 } from "lucide-react";
import { ErrorNote } from "@/ui/ErrorNote";
import { Switch } from "@/ui/switch";
import { ipc, type LanShareStatus } from "@/lib/ipc";
import { Group, Row, StackRow } from "@/features/settings/primitives";

/**
 * 多设备同步 → 局域网直连播放。电脑上是开关；手机上只说明怎么用（手机当不了服务器）。
 * 配对借网盘完成：两台设备连着同一个网盘，电脑把地址写上去，手机自己找，不用扫码。
 */
export function LanShareGroup() {
  const { t } = useTranslation();
  const [status, setStatus] = useState<LanShareStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    let alive = true;
    ipc.lanShare
      .status()
      .then((next) => alive && setStatus(next))
      .catch((err: unknown) => alive && setError(err));
    return () => {
      alive = false;
    };
  }, []);

  async function toggle(enabled: boolean) {
    setBusy(true);
    setError(null);
    try {
      setStatus(await ipc.lanShare.setEnabled(enabled));
    } catch (err) {
      setError(err);
      setStatus(await ipc.lanShare.status().catch(() => status));
    } finally {
      setBusy(false);
    }
  }

  if (!status) {
    return error != null ? <ErrorNote className="mx-4 mb-3" error={error} /> : null;
  }

  if (!status.supported) {
    return (
      <Group header={t("settings.lanShare.group")}>
        <StackRow>
          <p className="ca-t-xs leading-relaxed text-[var(--text-muted)]">{t("settings.lanShare.mobileHint")}</p>
        </StackRow>
      </Group>
    );
  }

  const where = status.running && status.addresses.length > 0 ? status.addresses.join(" / ") : null;
  return (
    <Group header={t("settings.lanShare.group")} hint={t("settings.lanShare.hint")}>
      <Row
        label={t("settings.lanShare.toggle")}
        htmlFor="lan-share-enabled"
        layout="inline"
        status={
          busy
            ? undefined
            : status.running
              ? where
                ? t("settings.lanShare.runningAt", { address: where })
                : t("settings.lanShare.noNetwork")
              : undefined
        }
      >
        <div className="flex items-center gap-2">
          {busy && <Loader2 className="h-3.5 w-3.5 animate-spin text-[var(--text-muted)]" aria-hidden="true" />}
          <Switch
            id="lan-share-enabled"
            checked={status.enabled}
            aria-label={t("settings.lanShare.toggle")}
            onCheckedChange={(next) => {
              if (!busy) void toggle(next);
            }}
          />
        </div>
      </Row>
      {(error != null || (status.enabled && status.error)) && (
        <ErrorNote className="mx-4 mb-3" error={error ?? status.error} />
      )}
    </Group>
  );
}
