import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { listen } from "@tauri-apps/api/event";
import { Laptop, Loader2, RefreshCw, Smartphone, Zap } from "lucide-react";
import { Button } from "@/ui/button";
import { ErrorNote } from "@/ui/ErrorNote";
import { Switch } from "@/ui/switch";
import { ipc, type RemoteSyncMediaState, type RemoteSyncRunState, type RemoteSyncStatus } from "@/lib/ipc";
import { formatRelativeTime } from "@/lib/time";
import { FIELD, Group, Row, SavedBadge, Select, StackRow } from "@/features/settings/primitives";

/** 常见的 WebDAV 服务。选了就把地址填好；自定义时自己填。 */
const PROVIDERS = [
  { key: "jianguoyun", url: "https://dav.jianguoyun.com/dav/" },
  { key: "nextcloud", url: "" },
  { key: "custom", url: "" },
] as const;
type ProviderKey = (typeof PROVIDERS)[number]["key"];

function providerOf(url: string): ProviderKey {
  if (url.includes("jianguoyun.com")) return "jianguoyun";
  if (url.includes("/remote.php/")) return "nextcloud";
  return "custom";
}

const MOBILE = new Set(["android", "ios"]);

/**
 * 设置 → 多设备同步：用自己的 WebDAV 网盘（坚果云、Nextcloud、群晖……）在电脑和手机之间
 * 同步进度、笔记、复习卡。连接设置保存后测一下，再打开开关；之后后台每几分钟同步一轮，
 * 应用回到前台时也会同步。
 */
export function RemoteSyncSection() {
  const { t, i18n } = useTranslation();
  const [status, setStatus] = useState<RemoteSyncStatus | null>(null);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [provider, setProvider] = useState<ProviderKey>("jianguoyun");
  const [url, setUrl] = useState("");
  const [folder, setFolder] = useState("");
  const [user, setUser] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState<"test" | "save" | "toggle" | "sync" | null>(null);
  const [actionError, setActionError] = useState<unknown>(null);
  const [testResult, setTestResult] = useState<number | null>(null);
  const [saved, setSaved] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const next = await ipc.remoteSync.status();
      setStatus(next);
      setLoadError(null);
      return next;
    } catch (error) {
      setLoadError(error);
      return null;
    }
  }, []);

  useEffect(() => {
    void refresh().then((next) => {
      if (!next) return;
      setUrl(next.url || PROVIDERS[0].url);
      setProvider(next.url ? providerOf(next.url) : "jianguoyun");
      setFolder(next.folder);
      setUser(next.user);
    });
  }, [refresh]);

  // 后台每同步一轮都会发状态：开着设置页时实时更新「上次同步」「正在同步」。
  useEffect(() => {
    const unlisten = listen<RemoteSyncRunState>("remote-sync:status", (event) => {
      setStatus((current) => (current ? { ...current, state: event.payload } : current));
      if (!event.payload.running) void refresh();
    });
    return () => {
      void unlisten.then((fn) => fn());
    };
  }, [refresh]);

  // 视频上传进度：每传完一块发一次。
  useEffect(() => {
    const unlisten = listen<RemoteSyncMediaState>("remote-sync:media", (event) => {
      setStatus((current) => (current ? { ...current, media: event.payload } : current));
    });
    return () => {
      void unlisten.then((fn) => fn());
    };
  }, []);

  if (!status) {
    return loadError ? <ErrorNote error={loadError} onRetry={() => void refresh()} /> : null;
  }

  const draft = { url: url.trim(), folder: folder.trim(), user: user.trim(), password: password || null };
  const dirty =
    draft.url !== status.url || draft.folder !== status.folder || draft.user !== status.user || Boolean(password);
  const complete = Boolean(draft.url && draft.user && (password || status.hasPassword));
  const configured = Boolean(status.url && status.user && status.hasPassword);

  async function act<T>(kind: NonNullable<typeof busy>, run: () => Promise<T>): Promise<T | undefined> {
    setBusy(kind);
    setActionError(null);
    try {
      return await run();
    } catch (error) {
      setActionError(error);
      return undefined;
    } finally {
      setBusy(null);
    }
  }

  async function test() {
    setTestResult(null);
    const count = await act("test", () => ipc.remoteSync.test(draft));
    if (count !== undefined) setTestResult(count);
  }

  async function save() {
    setSaved(false);
    const ok = await act("save", async () => {
      await ipc.remoteSync.save(draft);
      return true;
    });
    if (ok) {
      setPassword("");
      setSaved(true);
      await refresh();
    }
  }

  async function toggle(enabled: boolean) {
    await act("toggle", () => ipc.remoteSync.setEnabled(enabled));
    await refresh();
  }

  async function syncNow() {
    await act("sync", () => ipc.remoteSync.now());
    await refresh();
  }

  function changeProvider(next: ProviderKey) {
    setProvider(next);
    const preset = PROVIDERS.find((one) => one.key === next);
    if (preset?.url) setUrl(preset.url);
    else if (providerOf(url) !== next) setUrl("");
  }

  const run = status.state;
  const lastSync = run.lastSuccessAt ? formatRelativeTime(run.lastSuccessAt, Date.now(), i18n.language) : null;

  return (
    <>
      <Group header={t("settings.remoteSync.connectionGroup")} hint={t("settings.remoteSync.connectionHint")}>
        <Row label={t("settings.remoteSync.provider")} htmlFor="remote-sync-provider">
          <div className="w-full sm:w-56">
            <Select
              id="remote-sync-provider"
              value={provider}
              onChange={(event) => changeProvider(event.target.value as ProviderKey)}
            >
              {PROVIDERS.map((one) => (
                <option key={one.key} value={one.key}>
                  {t(`settings.remoteSync.providers.${one.key}`)}
                </option>
              ))}
            </Select>
          </div>
        </Row>
        <StackRow label={t("settings.remoteSync.url")} hint={t(`settings.remoteSync.urlHint.${provider}`)} htmlFor="remote-sync-url">
          <input
            id="remote-sync-url"
            className={FIELD}
            value={url}
            placeholder={provider === "nextcloud" ? "https://cloud.example.com/remote.php/dav/files/用户名/" : "https://"}
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            onChange={(event) => setUrl(event.target.value)}
          />
        </StackRow>
        <StackRow label={t("settings.remoteSync.user")} htmlFor="remote-sync-user">
          <input
            id="remote-sync-user"
            className={FIELD}
            value={user}
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            autoComplete="username"
            onChange={(event) => setUser(event.target.value)}
          />
        </StackRow>
        <StackRow
          label={t("settings.remoteSync.password")}
          hint={provider === "jianguoyun" ? t("settings.remoteSync.passwordHintJianguoyun") : undefined}
          htmlFor="remote-sync-password"
        >
          <input
            id="remote-sync-password"
            className={FIELD}
            type="password"
            value={password}
            autoComplete="current-password"
            placeholder={status.hasPassword ? t("settings.remoteSync.passwordKept") : ""}
            onChange={(event) => setPassword(event.target.value)}
          />
        </StackRow>
        <StackRow label={t("settings.remoteSync.folder")} hint={t("settings.remoteSync.folderHint")} htmlFor="remote-sync-folder">
          <input
            id="remote-sync-folder"
            className={FIELD}
            value={folder}
            placeholder="CoursePilot"
            spellCheck={false}
            onChange={(event) => setFolder(event.target.value)}
          />
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <Button size="sm" variant="primary" disabled={!complete || !dirty || busy != null} onClick={() => void save()}>
              {busy === "save" && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              {t("settings.remoteSync.save")}
            </Button>
            <Button size="sm" variant="outline" disabled={!complete || busy != null} onClick={() => void test()}>
              {busy === "test" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Zap className="h-3.5 w-3.5" />}
              {t("settings.remoteSync.test")}
            </Button>
            {saved && !dirty && <SavedBadge text={t("settings.remoteSync.saved")} />}
            {testResult !== null && <SavedBadge text={t("settings.remoteSync.testOk", { count: testResult })} />}
          </div>
        </StackRow>
        {actionError != null && <ErrorNote className="mx-4 mb-3" error={actionError} />}
      </Group>

      <Group header={t("settings.remoteSync.syncGroup")} hint={t("settings.remoteSync.syncHint")}>
        <Row
          label={t("settings.remoteSync.enable")}
          htmlFor="remote-sync-enabled"
          status={!configured ? t("settings.remoteSync.needConfig") : undefined}
        >
          <Switch
            id="remote-sync-enabled"
            checked={status.enabled}
            aria-label={t("settings.remoteSync.enable")}
            onCheckedChange={(next) => {
              if (!configured || busy != null) return;
              void toggle(next);
            }}
          />
        </Row>
        {status.enabled && (
          <Row
            label={t("settings.remoteSync.lastSync")}
            status={
              run.running || busy === "sync"
                ? t("settings.remoteSync.syncing")
                : status.pending > 0
                  ? t("settings.remoteSync.pending", { count: status.pending })
                  : undefined
            }
          >
            <div className="flex items-center gap-3">
              <span className="ca-t-sm text-[var(--text-normal)]">{lastSync ?? t("settings.remoteSync.never")}</span>
              <Button size="sm" variant="outline" disabled={busy != null || run.running} onClick={() => void syncNow()}>
                {run.running || busy === "sync" ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <RefreshCw className="h-3.5 w-3.5" />
                )}
                {t("settings.remoteSync.syncNow")}
              </Button>
            </div>
          </Row>
        )}
        {status.enabled && run.lastError && !run.running && (
          <ErrorNote className="mx-4 mb-3" error={run.lastError} onRetry={() => void syncNow()} />
        )}
        {status.enabled && (
          <Row
            label={t("settings.remoteSync.uploadMedia")}
            hint={t("settings.remoteSync.uploadMediaHint")}
            htmlFor="remote-sync-upload-media"
            status={
              status.uploadMedia
                ? status.media.uploading
                  ? t("settings.remoteSync.uploading", {
                      title: status.media.uploading.title,
                      percent:
                        status.media.uploading.total > 0
                          ? Math.floor((status.media.uploading.sent / status.media.uploading.total) * 100)
                          : 0,
                    })
                  : t("settings.remoteSync.uploadIdle")
                : undefined
            }
          >
            <Switch
              id="remote-sync-upload-media"
              checked={status.uploadMedia}
              aria-label={t("settings.remoteSync.uploadMedia")}
              onCheckedChange={(next) => void act("toggle", () => ipc.remoteSync.setUploadMedia(next)).then(refresh)}
            />
          </Row>
        )}
        {status.enabled && status.uploadMedia && status.media.lastError && !status.media.uploading && (
          <ErrorNote className="mx-4 mb-3" error={status.media.lastError} />
        )}
      </Group>

      <Group header={t("settings.remoteSync.devicesGroup")}>
        <Row label={status.deviceName} status={t("settings.remoteSync.thisDevice")}>
          <Laptop className="h-4 w-4 text-[var(--text-muted)]" aria-hidden="true" />
        </Row>
        {status.devices.length === 0 ? (
          <StackRow>
            <p className="ca-t-xs leading-relaxed text-[var(--text-muted)]">{t("settings.remoteSync.noDevices")}</p>
          </StackRow>
        ) : (
          status.devices.map((device) => (
            <Row
              key={device.deviceId}
              label={device.name ?? device.deviceId.slice(0, 8)}
              status={t("settings.remoteSync.seen", { time: formatRelativeTime(device.seenAt, Date.now(), i18n.language) })}
            >
              {MOBILE.has(device.platform ?? "") ? (
                <Smartphone className="h-4 w-4 text-[var(--text-muted)]" aria-hidden="true" />
              ) : (
                <Laptop className="h-4 w-4 text-[var(--text-muted)]" aria-hidden="true" />
              )}
            </Row>
          ))
        )}
      </Group>
    </>
  );
}
