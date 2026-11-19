import { useMemo, useRef, useState, type RefObject } from "react";
import { useTranslation } from "react-i18next";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronRight, ExternalLink, Folder, FileVideo, Loader2, Pencil, Plus, Trash2 } from "lucide-react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Button } from "@/ui/button";
import { ErrorNote } from "@/ui/ErrorNote";
import { Modal } from "@/ui/dialog";
import { ipc, type WebDavEntry, type WebDavSource } from "@/lib/ipc";
import { qk } from "@/lib/queryKeys";
import { isMobile } from "@/lib/platform";
import { useDownloads } from "@/stores/downloads";

type Mode = "download" | "stream";
type PresetKey = "openlist" | "quark" | "jianguoyun" | "nextcloud" | "synology" | "other";

const PRESETS: { key: PresetKey; url: string }[] = [
  { key: "openlist", url: "" },
  { key: "quark", url: "" },
  { key: "jianguoyun", url: "https://dav.jianguoyun.com/dav/" },
  { key: "nextcloud", url: "" },
  { key: "synology", url: "" },
  { key: "other", url: "" },
];

const FIELD =
  "w-full rounded-md border border-[var(--border-subtle)] bg-[var(--surface-input)] px-3 py-2 text-sm outline-none focus:border-[var(--focus-ring)]";

const MB = 1024 * 1024;
const formatSize = (bytes: number | null) =>
  bytes == null ? "" : bytes >= 1024 * MB ? `${(bytes / 1024 / MB).toFixed(1)} GB` : `${Math.max(1, Math.round(bytes / MB))} MB`;

const titleOf = (name: string) => name.replace(/\.[^.]+$/, "");

type Draft = { id: string | null; preset: PresetKey; name: string; url: string; user: string; password: string };

const emptyDraft = (): Draft => ({ id: null, preset: "openlist", name: "", url: "", user: "", password: "" });

const OPENLIST_STEPS = ["install", "storage", "policy", "permission", "connect"] as const;
const OPENLIST_LINKS: Partial<Record<(typeof OPENLIST_STEPS)[number], string>> = {
  install: "https://github.com/OpenListTeam/OpenList-Desktop/releases",
  storage: "https://api.oplist.org/",
};

/** 用 OpenList 把百度网盘 / 阿里云盘挂成 WebDAV 的步骤（选了 OpenList 才显示）。 */
function OpenListGuide() {
  const { t } = useTranslation();
  return (
    <details className="rounded-lg border border-[var(--border-faint)] px-3 py-2">
      <summary className="ca-t-sm cursor-pointer font-medium text-[var(--text-strong)]">{t("webdavImport.openlistGuide.title")}</summary>
      <ol className="ca-t-xs mt-2 list-decimal space-y-1.5 pl-5 leading-relaxed text-[var(--text-muted)]">
        {OPENLIST_STEPS.map((step) => {
          const link = OPENLIST_LINKS[step];
          return (
            <li key={step}>
              {t(`webdavImport.openlistGuide.${step}`)}
              {link && (
                <button
                  type="button"
                  className="ml-1 inline-flex items-center gap-0.5 text-primary hover:underline"
                  onClick={() => void openUrl(link)}
                >
                  {link.replace(/^https:\/\//, "").replace(/\/$/, "")}
                  <ExternalLink className="h-3 w-3" aria-hidden="true" />
                </button>
              )}
            </li>
          );
        })}
      </ol>
      <p className="ca-t-xs mt-2 leading-relaxed text-[var(--text-muted)]">{t("webdavImport.openlistGuide.others")}</p>
    </details>
  );
}

/** 添加 / 编辑一个网盘来源。 */
function SourceForm({
  initial,
  hasSavedPassword,
  onSaved,
  onCancel,
}: {
  initial: Draft;
  hasSavedPassword: boolean;
  onSaved: (source: WebDavSource) => void;
  onCancel?: () => void;
}) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState<Draft>(initial);
  const [tested, setTested] = useState<number | null>(null);
  const set = (patch: Partial<Draft>) => {
    setTested(null);
    setDraft((current) => ({ ...current, ...patch }));
  };
  const quark = draft.preset === "quark";
  const complete = quark
    ? Boolean(draft.password.trim() || hasSavedPassword)
    : Boolean(draft.url.trim() && draft.user.trim() && (draft.password || hasSavedPassword));
  const payload = () => ({
    id: draft.id,
    kind: quark ? ("quark" as const) : ("webdav" as const),
    url: quark ? "" : draft.url.trim(),
    user: quark ? "" : draft.user.trim(),
    password: draft.password.trim() || null,
  });

  const test = useMutation({
    mutationFn: () => ipc.webdavImport.testSource(payload()),
    onSuccess: (count) => setTested(count),
  });
  const save = useMutation({
    mutationFn: () =>
      ipc.webdavImport.saveSource({
        ...payload(),
        name: draft.name.trim() || t(`webdavImport.presets.${draft.preset}`),
      }),
    onSuccess: onSaved,
  });

  return (
    <div className="space-y-3 rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-card)] p-3">
      <label className="block space-y-1">
        <span className="ca-t-xs text-[var(--text-muted)]">{t("webdavImport.kind")}</span>
        <select
          aria-label={t("webdavImport.kind")}
          className={FIELD}
          value={draft.preset}
          onChange={(event) => {
            const preset = event.target.value as PresetKey;
            const url = PRESETS.find((one) => one.key === preset)?.url ?? "";
            set({ preset, url: url || (draft.url && !PRESETS.some((one) => one.url === draft.url) ? draft.url : "") });
          }}
        >
          {PRESETS.map((one) => (
            <option key={one.key} value={one.key}>
              {t(`webdavImport.presets.${one.key}`)}
            </option>
          ))}
        </select>
        <span className="ca-t-xs block leading-relaxed text-[var(--text-muted)]">{t(`webdavImport.presetHints.${draft.preset}`)}</span>
      </label>
      {draft.preset === "openlist" && <OpenListGuide />}
      {quark ? (
        <textarea
          aria-label={t("webdavImport.cookie")}
          className={`${FIELD} h-24 font-mono text-xs`}
          placeholder={hasSavedPassword ? t("webdavImport.cookieKeep") : t("webdavImport.cookiePlaceholder")}
          value={draft.password}
          onChange={(event) => set({ password: event.target.value })}
        />
      ) : (
        <>
      <input
        aria-label={t("webdavImport.url")}
        className={FIELD}
        placeholder={t(`webdavImport.urlPlaceholders.${draft.preset}`)}
        value={draft.url}
        onChange={(event) => set({ url: event.target.value })}
      />
      <div className="grid gap-2 sm:grid-cols-2">
        <input
          aria-label={t("webdavImport.user")}
          className={FIELD}
          placeholder={t("webdavImport.user")}
          autoComplete="username"
          value={draft.user}
          onChange={(event) => set({ user: event.target.value })}
        />
        <input
          aria-label={t("webdavImport.password")}
          className={FIELD}
          type="password"
          autoComplete="current-password"
          placeholder={hasSavedPassword ? t("webdavImport.passwordKeep") : t("webdavImport.password")}
          value={draft.password}
          onChange={(event) => set({ password: event.target.value })}
        />
      </div>
        </>
      )}
      <input
        aria-label={t("webdavImport.name")}
        className={FIELD}
        placeholder={t("webdavImport.namePlaceholder")}
        value={draft.name}
        onChange={(event) => set({ name: event.target.value })}
      />
      {(test.error || save.error) && <ErrorNote error={test.error ?? save.error} />}
      {tested != null && <p className="ca-t-xs text-[var(--status-ok)]">{t("webdavImport.testOk", { count: tested })}</p>}
      <div className="flex flex-wrap justify-end gap-2">
        {onCancel && (
          <Button size="sm" variant="ghost" onClick={onCancel}>
            {t("common.cancel")}
          </Button>
        )}
        <Button size="sm" variant="outline" disabled={!complete || test.isPending} onClick={() => test.mutate()}>
          {test.isPending && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
          {t("webdavImport.test")}
        </Button>
        <Button size="sm" variant="primary" disabled={!complete || save.isPending} onClick={() => save.mutate()}>
          {save.isPending && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
          {t("webdavImport.save")}
        </Button>
      </div>
    </div>
  );
}

/** 从网盘导入：选来源 → 浏览文件夹 → 勾选视频 → 下载到本机 / 在线看。 */
export function WebDavImportDialog({
  courseId,
  onClose,
  returnFocusRef,
}: {
  courseId: string;
  onClose: () => void;
  returnFocusRef?: RefObject<HTMLElement | null>;
}) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const restoreFocusRef = useRef<HTMLElement | null>(
    typeof document !== "undefined" && document.activeElement instanceof HTMLElement ? document.activeElement : null,
  );
  const [sourceId, setSourceId] = useState<string | null>(null);
  // 走过的文件夹（面包屑）：WebDAV 的 path 是相对路径，夸克的是文件夹 id，所以不从 path 拆名字。
  const [trail, setTrail] = useState<{ name: string; path: string }[]>([]);
  const path = trail.length > 0 ? trail[trail.length - 1].path : "";
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [mode, setMode] = useState<Mode>(isMobile() ? "stream" : "download");
  const [editing, setEditing] = useState<{ draft: Draft; hasSavedPassword: boolean } | null>(null);

  const sources = useQuery({ queryKey: ["webdav-sources"], queryFn: () => ipc.webdavImport.sources() });
  const activeId = sourceId ?? sources.data?.[0]?.id ?? null;
  const active = sources.data?.find((source) => source.id === activeId) ?? null;
  const listing = useQuery({
    queryKey: ["webdav-browse", activeId, path],
    queryFn: () => ipc.webdavImport.browse(activeId as string, path),
    enabled: activeId != null && editing == null,
    retry: false,
  });
  const entries = useMemo(() => (listing.data ?? []).filter((entry) => entry.isDir || entry.isVideo), [listing.data]);
  const videos = entries.filter((entry) => entry.isVideo);
  const chosen = videos.filter((entry) => selected.has(entry.url));
  const allChosen = videos.length > 0 && chosen.length === videos.length;

  function open(entry: WebDavEntry) {
    setTrail((current) => [...current, { name: entry.name, path: entry.path }]);
    setSelected(new Set());
  }

  /** 回到第 depth 层（0 = 根目录）。 */
  function goTo(depth: number) {
    setTrail((current) => current.slice(0, depth));
    setSelected(new Set());
  }

  function switchSource(id: string) {
    setSourceId(id);
    setTrail([]);
    setSelected(new Set());
  }

  const remove = useMutation({
    mutationFn: (id: string) => ipc.webdavImport.deleteSource(id),
    onSuccess: async () => {
      setSourceId(null);
      setTrail([]);
      await queryClient.invalidateQueries({ queryKey: ["webdav-sources"] });
    },
  });

  const importing = useMutation({
    mutationFn: async () => {
      const items = chosen.map((entry) => ({ url: entry.url, title: titleOf(entry.name) }));
      if (mode === "stream") {
        await ipc.webdavImport.importStream(courseId, items);
      } else {
        const jobs = await ipc.downloads.enqueue(
          courseId,
          items.map((item) => ({ url: item.url, title: item.title, autoProcess: false })),
        );
        useDownloads.getState().addMany(jobs);
      }
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: qk.videos.list(courseId) });
      onClose();
    },
  });


  const noSources = sources.isSuccess && sources.data.length === 0;

  return (
    <Modal
      open
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      locked={importing.isPending}
      title={t("webdavImport.title")}
      titleClassName="mb-3 flex-none"
      size="lg"
      className="flex max-h-[85vh] flex-col"
      returnFocusTo={() => returnFocusRef?.current ?? restoreFocusRef.current}
    >
      {sources.isPending && <Loader2 className="mx-auto h-5 w-5 animate-spin text-[var(--text-muted)]" />}
      {sources.error && <ErrorNote error={sources.error} onRetry={() => void sources.refetch()} />}

      {(noSources || editing) && (
        <div className="space-y-2">
          {noSources && !editing && (
            <p className="ca-t-sm leading-relaxed text-[var(--text-muted)]">{t("webdavImport.intro")}</p>
          )}
          <SourceForm
            initial={editing?.draft ?? emptyDraft()}
            hasSavedPassword={editing?.hasSavedPassword ?? false}
            onCancel={noSources && !editing ? undefined : () => setEditing(null)}
            onSaved={async (source) => {
              setEditing(null);
              await queryClient.invalidateQueries({ queryKey: ["webdav-sources"] });
              await queryClient.invalidateQueries({ queryKey: ["webdav-browse", source.id] });
              switchSource(source.id);
            }}
          />
        </div>
      )}

      {!noSources && !editing && active && (
        <div className="flex min-h-0 flex-1 flex-col gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <select
              aria-label={t("webdavImport.source")}
              className={`${FIELD} w-auto min-w-0 flex-1`}
              value={active.id}
              onChange={(event) => switchSource(event.target.value)}
            >
              {sources.data?.map((source) => (
                <option key={source.id} value={source.id}>
                  {source.isSync
                    ? t("webdavImport.syncSource")
                    : source.name || (source.kind === "quark" ? t("webdavImport.presets.quark") : source.url)}
                </option>
              ))}
            </select>
            {!active.isSync && (
              <>
                <Button
                  size="sm"
                  variant="ghost"
                  aria-label={t("webdavImport.edit")}
                  onClick={() =>
                    setEditing({
                      draft: {
                        id: active.id,
                        preset: active.kind === "quark" ? "quark" : "other",
                        name: active.name,
                        url: active.url,
                        user: active.user,
                        password: "",
                      },
                      hasSavedPassword: active.hasPassword,
                    })
                  }
                >
                  <Pencil className="h-3.5 w-3.5" />
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  aria-label={t("webdavImport.delete")}
                  disabled={remove.isPending}
                  onClick={() => remove.mutate(active.id)}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </>
            )}
            <Button size="sm" variant="outline" onClick={() => setEditing({ draft: emptyDraft(), hasSavedPassword: false })}>
              <Plus className="h-3.5 w-3.5" />
              {t("webdavImport.addSource")}
            </Button>
          </div>

          <nav aria-label={t("webdavImport.location")} className="ca-t-sm flex flex-wrap items-center gap-1 text-[var(--text-muted)]">
            <button type="button" className="rounded px-1 hover:text-[var(--text-strong)]" onClick={() => goTo(0)}>
              {t("webdavImport.root")}
            </button>
            {trail.map((crumb, index) => (
              <span key={`${index}-${crumb.path}`} className="flex items-center gap-1">
                <ChevronRight className="h-3.5 w-3.5" aria-hidden="true" />
                <button type="button" className="rounded px-1 hover:text-[var(--text-strong)]" onClick={() => goTo(index + 1)}>
                  {crumb.name}
                </button>
              </span>
            ))}
          </nav>

          <div className="min-h-[12rem] flex-1 overflow-y-auto rounded-xl border border-[var(--border-subtle)]">
            {listing.isPending && <Loader2 className="mx-auto my-8 h-5 w-5 animate-spin text-[var(--text-muted)]" />}
            {listing.error && (
              <div className="p-3">
                <ErrorNote error={listing.error} onRetry={() => void listing.refetch()} />
              </div>
            )}
            {listing.isSuccess && entries.length === 0 && (
              <p className="ca-t-sm p-6 text-center text-[var(--text-muted)]">{t("webdavImport.empty")}</p>
            )}
            {videos.length > 0 && (
              <label className="ca-t-xs flex items-center gap-2 border-b border-[var(--border-faint)] px-3 py-2 text-[var(--text-muted)]">
                <input
                  type="checkbox"
                  checked={allChosen}
                  onChange={() => setSelected(allChosen ? new Set() : new Set(videos.map((entry) => entry.url)))}
                />
                {t("webdavImport.selectAll", { count: videos.length })}
              </label>
            )}
            <ul>
              {entries.map((entry) =>
                entry.isDir ? (
                  <li key={`dir-${entry.path}`}>
                    <button
                      type="button"
                      className="ca-touch-44 flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-[var(--surface-card-hover)]"
                      onClick={() => open(entry)}
                    >
                      <Folder className="h-4 w-4 flex-none text-primary" aria-hidden="true" />
                      <span className="min-w-0 flex-1 truncate">{entry.name}</span>
                      <ChevronRight className="h-4 w-4 flex-none text-[var(--text-muted)]" aria-hidden="true" />
                    </button>
                  </li>
                ) : (
                  <li key={entry.url}>
                    <label className="ca-touch-44 flex cursor-pointer items-center gap-2 px-3 py-2 text-sm hover:bg-[var(--surface-card-hover)]">
                      <input
                        type="checkbox"
                        checked={selected.has(entry.url)}
                        onChange={() =>
                          setSelected((current) => {
                            const next = new Set(current);
                            if (next.has(entry.url)) next.delete(entry.url);
                            else next.add(entry.url);
                            return next;
                          })
                        }
                      />
                      <FileVideo className="h-4 w-4 flex-none text-[var(--text-muted)]" aria-hidden="true" />
                      <span className="min-w-0 flex-1 truncate">{entry.name}</span>
                      <span className="ca-t-xs flex-none tabular-nums text-[var(--text-muted)]">{formatSize(entry.size)}</span>
                    </label>
                  </li>
                ),
              )}
            </ul>
          </div>

          <fieldset className="grid gap-2 sm:grid-cols-2">
            <legend className="sr-only">{t("webdavImport.mode")}</legend>
            {(["download", "stream"] as const).map((value) => (
              <label
                key={value}
                className={`flex cursor-pointer items-start gap-2 rounded-lg border px-3 py-2 ${
                  mode === value ? "border-[var(--focus-ring)] bg-[var(--surface-card-hover)]" : "border-[var(--border-subtle)]"
                }`}
              >
                <input type="radio" name="webdav-mode" className="mt-1" checked={mode === value} onChange={() => setMode(value)} />
                <span className="min-w-0">
                  <span className="block text-sm font-medium text-[var(--text-strong)]">{t(`webdavImport.modes.${value}`)}</span>
                  <span className="ca-t-xs block leading-relaxed text-[var(--text-muted)]">{t(`webdavImport.modeHints.${value}`)}</span>
                </span>
              </label>
            ))}
          </fieldset>

          {importing.error && <ErrorNote error={importing.error} />}
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={onClose} disabled={importing.isPending}>
              {t("common.cancel")}
            </Button>
            <Button variant="primary" disabled={chosen.length === 0 || importing.isPending} onClick={() => importing.mutate()}>
              {importing.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
              {t("webdavImport.import", { count: chosen.length })}
            </Button>
          </div>
        </div>
      )}
    </Modal>
  );
}
