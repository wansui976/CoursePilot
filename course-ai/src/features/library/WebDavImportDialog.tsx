import { useId, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import { useTranslation } from "react-i18next";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Check,
  ChevronRight,
  Cloud,
  CloudCog,
  ExternalLink,
  FileVideo,
  Folder,
  Globe,
  HardDrive,
  HardDriveDownload,
  Home,
  Info,
  Loader2,
  Plus,
  Server,
  Settings2,
  Zap,
  type LucideIcon,
} from "lucide-react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Button } from "@/ui/button";
import { ErrorNote } from "@/ui/ErrorNote";
import { Modal } from "@/ui/dialog";
import { Select } from "@/ui/select";
import { ipc, type WebDavEntry, type WebDavSource } from "@/lib/ipc";
import { qk } from "@/lib/queryKeys";
import { isMobile } from "@/lib/platform";
import { cn } from "@/lib/utils";
import { useDownloads } from "@/stores/downloads";

type Mode = "download" | "stream";
type PresetKey = "openlist" | "quark" | "jianguoyun" | "nextcloud" | "synology" | "other";

const PRESETS: { key: PresetKey; url: string; icon: LucideIcon }[] = [
  { key: "openlist", url: "", icon: Server },
  { key: "quark", url: "", icon: Zap },
  { key: "jianguoyun", url: "https://dav.jianguoyun.com/dav/", icon: Cloud },
  { key: "nextcloud", url: "", icon: CloudCog },
  { key: "synology", url: "", icon: HardDrive },
  { key: "other", url: "", icon: Globe },
];

const FIELD =
  "w-full rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-input)] px-3 py-2 text-sm text-[var(--text-strong)] outline-none transition placeholder:text-[var(--text-muted)] focus-visible:border-[var(--accent-text)]";

const MB = 1024 * 1024;
const formatSize = (bytes: number | null) =>
  bytes == null ? "" : bytes >= 1024 * MB ? `${(bytes / 1024 / MB).toFixed(1)} GB` : `${Math.max(1, Math.round(bytes / MB))} MB`;

const titleOf = (name: string) => name.replace(/\.[^.]+$/, "");
const extensionOf = (name: string) => name.match(/\.[^.]+$/)?.[0] ?? "";

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
    <details className="group rounded-xl border border-[var(--border-faint)] px-3.5 py-3">
      <summary className="ca-t-sm flex cursor-pointer list-none items-center gap-1.5 font-medium text-[var(--text-strong)] [&::-webkit-details-marker]:hidden">
        <ChevronRight
          className="h-4 w-4 flex-none text-[var(--text-muted)] transition-transform group-open:rotate-90"
          aria-hidden="true"
        />
        {t("webdavImport.openlistGuide.title")}
      </summary>
      <ol className="mt-3 space-y-2.5">
        {OPENLIST_STEPS.map((step, index) => {
          const link = OPENLIST_LINKS[step];
          return (
            <li key={step} className="flex gap-2.5">
              <span className="ca-t-xs mt-px flex h-5 w-5 flex-none items-center justify-center rounded-full bg-[var(--accent-weak)] font-semibold tabular-nums text-[var(--accent-text)]">
                {index + 1}
              </span>
              <p className="ca-t-xs min-w-0 leading-relaxed text-[var(--text-normal)]">
                {t(`webdavImport.openlistGuide.${step}`)}
                {link && (
                  <button
                    type="button"
                    className="ml-1 inline-flex items-center gap-0.5 font-medium text-[var(--accent-text)] hover:underline"
                    onClick={() => void openUrl(link)}
                  >
                    {link.replace(/^https:\/\//, "").replace(/\/$/, "")}
                    <ExternalLink className="h-3 w-3" aria-hidden="true" />
                  </button>
                )}
              </p>
            </li>
          );
        })}
      </ol>
      <p className="ca-t-xs mt-3 border-t border-[var(--border-faint)] pt-2.5 leading-relaxed text-[var(--text-muted)]">
        {t("webdavImport.openlistGuide.others")}
      </p>
    </details>
  );
}

/** 表单里的一项：小标签在上，输入框在下。 */
function Field({ label, children, htmlFor }: { label: string; htmlFor: string; children: ReactNode }) {
  return (
    <div className="min-w-0 space-y-1.5">
      <label htmlFor={htmlFor} className="ca-t-xs block font-medium text-[var(--text-muted)]">
        {label}
      </label>
      {children}
    </div>
  );
}

/** 添加 / 编辑一个网盘来源。 */
function SourceForm({
  initial,
  hasSavedPassword,
  onSaved,
  onCancel,
  onDelete,
}: {
  initial: Draft;
  hasSavedPassword: boolean;
  onSaved: (source: WebDavSource) => void;
  onCancel?: () => void;
  /** 编辑已保存的来源时才有。 */
  onDelete?: () => void;
}) {
  const { t } = useTranslation();
  const id = useId();
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
        name: draft.name.trim() || t(`webdavImport.tiles.${draft.preset}.title`),
      }),
    onSuccess: onSaved,
  });

  function choose(preset: PresetKey) {
    const url = PRESETS.find((one) => one.key === preset)?.url ?? "";
    set({ preset, url: url || (draft.url && !PRESETS.some((one) => one.url === draft.url) ? draft.url : "") });
  }

  return (
    <div className="space-y-5">
      <div role="radiogroup" aria-label={t("webdavImport.kind")} className="grid grid-cols-2 gap-2">
        {PRESETS.map(({ key, icon: Icon }) => {
          const active = draft.preset === key;
          return (
            <button
              key={key}
              type="button"
              role="radio"
              aria-checked={active}
              onClick={() => choose(key)}
              className={cn(
                "flex items-center gap-2.5 rounded-xl border px-3 py-2.5 text-left transition-colors",
                active
                  ? "border-[var(--accent-text)] bg-[var(--accent-weak)]"
                  : "border-[var(--border-subtle)] hover:bg-[var(--surface-card-hover)]",
              )}
            >
              <span
                className={cn(
                  "flex h-8 w-8 flex-none items-center justify-center rounded-lg",
                  active ? "bg-[var(--surface-panel)] text-[var(--accent-text)]" : "bg-[var(--surface-input)] text-[var(--text-muted)]",
                )}
              >
                <Icon className="h-4 w-4" aria-hidden="true" />
              </span>
              <span className="min-w-0">
                <span className="block truncate text-sm font-medium text-[var(--text-strong)]">
                  {t(`webdavImport.tiles.${key}.title`)}
                </span>
                <span className="ca-t-xs block truncate text-[var(--text-muted)]">{t(`webdavImport.tiles.${key}.sub`)}</span>
              </span>
            </button>
          );
        })}
      </div>

      <p className="ca-t-xs flex gap-2 rounded-lg bg-[var(--surface-input)] px-3 py-2.5 leading-relaxed text-[var(--text-muted)]">
        <Info className="mt-0.5 h-3.5 w-3.5 flex-none" aria-hidden="true" />
        <span>{t(`webdavImport.presetHints.${draft.preset}`)}</span>
      </p>

      {quark ? (
        <Field label={t("webdavImport.cookie")} htmlFor={`${id}-cookie`}>
          <textarea
            id={`${id}-cookie`}
            className={`${FIELD} h-24 resize-none font-mono text-xs`}
            placeholder={hasSavedPassword ? t("webdavImport.cookieKeep") : t("webdavImport.cookiePlaceholder")}
            value={draft.password}
            onChange={(event) => set({ password: event.target.value })}
          />
        </Field>
      ) : (
        <div className="space-y-3">
          <Field label={t("webdavImport.url")} htmlFor={`${id}-url`}>
            <input
              id={`${id}-url`}
              className={FIELD}
              placeholder={t(`webdavImport.urlPlaceholders.${draft.preset}`)}
              value={draft.url}
              onChange={(event) => set({ url: event.target.value })}
            />
          </Field>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label={t("webdavImport.user")} htmlFor={`${id}-user`}>
              <input
                id={`${id}-user`}
                className={FIELD}
                autoComplete="username"
                value={draft.user}
                onChange={(event) => set({ user: event.target.value })}
              />
            </Field>
            <Field label={t("webdavImport.password")} htmlFor={`${id}-password`}>
              <input
                id={`${id}-password`}
                className={FIELD}
                type="password"
                autoComplete="current-password"
                placeholder={hasSavedPassword ? t("webdavImport.passwordKeep") : undefined}
                value={draft.password}
                onChange={(event) => set({ password: event.target.value })}
              />
            </Field>
          </div>
        </div>
      )}
      <Field label={t("webdavImport.name")} htmlFor={`${id}-name`}>
        <input
          id={`${id}-name`}
          className={FIELD}
          placeholder={t(`webdavImport.tiles.${draft.preset}.title`)}
          value={draft.name}
          onChange={(event) => set({ name: event.target.value })}
        />
      </Field>

      {(test.error || save.error) && <ErrorNote error={test.error ?? save.error} />}
      <div className="flex flex-wrap items-center gap-2">
        {onDelete ? (
          <Button size="sm" variant="ghost" className="text-[var(--text-muted)] hover:text-[var(--status-err)]" onClick={onDelete}>
            {t("webdavImport.delete")}
          </Button>
        ) : null}
        {tested != null && (
          <span className="ca-t-xs inline-flex items-center gap-1 font-medium text-[var(--status-ok)]">
            <Check className="h-3.5 w-3.5" aria-hidden="true" />
            {t("webdavImport.testOk", { count: tested })}
          </span>
        )}
        <div className="ml-auto flex gap-2">
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
      {/* 教程放在表单后面：展开以后要填的框不会被挤到看不见的地方。 */}
      {draft.preset === "openlist" && <OpenListGuide />}
    </div>
  );
}

/** 面包屑：太深时只留根、「…」和最后两层，始终一行。 */
function Breadcrumb({
  trail,
  onGo,
}: {
  trail: { name: string; path: string }[];
  onGo: (depth: number) => void;
}) {
  const { t } = useTranslation();
  const collapsed = trail.length > 3;
  const shown = collapsed ? trail.slice(-2).map((crumb, i) => ({ crumb, depth: trail.length - 1 + i })) : trail.map((crumb, i) => ({ crumb, depth: i + 1 }));
  const crumbClass = "min-w-0 max-w-[14rem] truncate rounded-md px-1.5 py-0.5 hover:bg-[var(--surface-card-hover)] hover:text-[var(--text-strong)]";
  return (
    <nav
      aria-label={t("webdavImport.location")}
      className="ca-t-sm flex min-w-0 flex-nowrap items-center gap-0.5 overflow-hidden text-[var(--text-muted)]"
    >
      <button type="button" className={cn(crumbClass, "inline-flex flex-none items-center gap-1")} onClick={() => onGo(0)}>
        <Home className="h-3.5 w-3.5" aria-hidden="true" />
        {t("webdavImport.root")}
      </button>
      {collapsed && (
        <>
          <ChevronRight className="h-3.5 w-3.5 flex-none" aria-hidden="true" />
          <button type="button" className={cn(crumbClass, "flex-none")} aria-label={t("webdavImport.up")} onClick={() => onGo(trail.length - 2)}>
            …
          </button>
        </>
      )}
      {shown.map(({ crumb, depth }) => (
        <span key={`${depth}-${crumb.path}`} className="flex min-w-0 items-center gap-0.5">
          <ChevronRight className="h-3.5 w-3.5 flex-none" aria-hidden="true" />
          <button
            type="button"
            className={cn(crumbClass, depth === trail.length && "font-medium text-[var(--text-strong)]")}
            onClick={() => onGo(depth)}
          >
            {crumb.name}
          </button>
        </span>
      ))}
    </nav>
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
  const chosenBytes = chosen.reduce((sum, entry) => sum + (entry.size ?? 0), 0);

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

  function toggle(url: string) {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(url)) next.delete(url);
      else next.add(url);
      return next;
    });
  }

  const remove = useMutation({
    mutationFn: (id: string) => ipc.webdavImport.deleteSource(id),
    onSuccess: async () => {
      setEditing(null);
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
          // 下完要不要立刻处理，按设置「导入后立刻处理」。
          items.map((item) => ({ url: item.url, title: item.title })),
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
  const sourceLabel = (source: WebDavSource) =>
    source.isSync
      ? t("webdavImport.syncSource")
      : source.name || (source.kind === "quark" ? t("webdavImport.tiles.quark.title") : source.url);

  return (
    <Modal
      open
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      locked={importing.isPending}
      title={editing ? t(editing.draft.id ? "webdavImport.editTitle" : "webdavImport.addTitle") : t("webdavImport.title")}
      description={noSources && !editing ? t("webdavImport.intro") : undefined}
      titleClassName="flex-none"
      size="lg"
      className="flex max-h-[85vh] flex-col"
      returnFocusTo={() => returnFocusRef?.current ?? restoreFocusRef.current}
    >
      {sources.isPending && <Loader2 className="mx-auto my-6 h-5 w-5 animate-spin text-[var(--text-muted)]" />}
      {sources.error && <ErrorNote error={sources.error} onRetry={() => void sources.refetch()} />}

      {(noSources || editing) && (
        // 表单（尤其展开 OpenList 教程时）可能比对话框高：在这里滚动，保存按钮总够得着。
        <div className="-mx-1 mt-4 min-h-0 flex-1 overflow-y-auto px-1 pb-1">
          <SourceForm
            key={editing?.draft.id ?? "new"}
            initial={editing?.draft ?? emptyDraft()}
            hasSavedPassword={editing?.hasSavedPassword ?? false}
            onCancel={noSources && !editing ? undefined : () => setEditing(null)}
            onDelete={editing?.draft.id ? () => remove.mutate(editing.draft.id as string) : undefined}
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
        <div className="mt-4 flex min-h-0 flex-1 flex-col gap-3">
          <div className="flex items-center gap-2">
            <Select
              aria-label={t("webdavImport.source")}
              className="min-w-0 flex-1"
              value={active.id}
              onChange={(event) => switchSource(event.target.value)}
            >
              {sources.data?.map((source) => (
                <option key={source.id} value={source.id}>
                  {sourceLabel(source)}
                </option>
              ))}
            </Select>
            {!active.isSync && (
              <Button
                size="sm"
                variant="ghost"
                className="h-9 w-9 flex-none px-0 text-[var(--text-muted)]"
                aria-label={t("webdavImport.edit")}
                title={t("webdavImport.edit")}
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
                <Settings2 className="h-4 w-4" />
              </Button>
            )}
            <Button
              size="sm"
              variant="outline"
              className="flex-none"
              onClick={() => setEditing({ draft: emptyDraft(), hasSavedPassword: false })}
            >
              <Plus className="h-3.5 w-3.5" />
              {t("webdavImport.addSource")}
            </Button>
          </div>

          <div className="overflow-hidden rounded-xl border border-[var(--border-subtle)]">
            <div className="flex items-center gap-2 border-b border-[var(--border-faint)] bg-[var(--surface-input)] px-2 py-1.5">
              <Breadcrumb trail={trail} onGo={goTo} />
            </div>
            <div className="h-[min(20rem,42vh)] overflow-y-auto">
              {listing.isPending && <Loader2 className="mx-auto my-10 h-5 w-5 animate-spin text-[var(--text-muted)]" />}
              {listing.error && (
                <div className="p-3">
                  <ErrorNote error={listing.error} onRetry={() => void listing.refetch()} />
                </div>
              )}
              {listing.isSuccess && entries.length === 0 && (
                <div className="flex h-full flex-col items-center justify-center gap-2 text-[var(--text-muted)]">
                  <Folder className="h-6 w-6 opacity-60" aria-hidden="true" />
                  <p className="ca-t-sm">{t("webdavImport.empty")}</p>
                </div>
              )}
              {videos.length > 0 && (
                <label className="ca-t-xs sticky top-0 z-10 flex cursor-pointer items-center gap-3 border-b border-[var(--border-faint)] bg-[var(--surface-panel)] px-3 py-2 text-[var(--text-muted)]">
                  <input
                    type="checkbox"
                    className="h-4 w-4 flex-none accent-[var(--accent-text)]"
                    checked={allChosen}
                    ref={(node) => {
                      if (node) node.indeterminate = chosen.length > 0 && !allChosen;
                    }}
                    onChange={() => setSelected(allChosen ? new Set() : new Set(videos.map((entry) => entry.url)))}
                  />
                  {chosen.length > 0 && !allChosen
                    ? t("webdavImport.selectedOf", { count: chosen.length, total: videos.length })
                    : t("webdavImport.selectAll", { count: videos.length })}
                </label>
              )}
              <ul className="py-1">
                {entries.map((entry) =>
                  entry.isDir ? (
                    <li key={`dir-${entry.path}`} className="px-1">
                      <button
                        type="button"
                        className="flex h-10 w-full items-center gap-3 rounded-lg px-2 text-left text-sm text-[var(--text-strong)] hover:bg-[var(--surface-card-hover)]"
                        onClick={() => open(entry)}
                      >
                        {/* 有视频可勾选时留出勾选框的位置，文件夹和文件的图标上下对齐。 */}
                        {videos.length > 0 && <span className="w-4 flex-none" aria-hidden="true" />}
                        <Folder className="h-4 w-4 flex-none fill-[var(--accent-weak)] text-[var(--accent-text)]" aria-hidden="true" />
                        <span className="min-w-0 flex-1 truncate">{entry.name}</span>
                        <ChevronRight className="h-4 w-4 flex-none text-[var(--text-muted)]" aria-hidden="true" />
                      </button>
                    </li>
                  ) : (
                    <li key={entry.url} className="px-1">
                      <label className="flex h-10 cursor-pointer items-center gap-3 rounded-lg px-2 text-sm hover:bg-[var(--surface-card-hover)]">
                        <input
                          type="checkbox"
                          className="h-4 w-4 flex-none accent-[var(--accent-text)]"
                          checked={selected.has(entry.url)}
                          onChange={() => toggle(entry.url)}
                          aria-label={entry.name}
                        />
                        <FileVideo className="h-4 w-4 flex-none text-[var(--text-muted)]" aria-hidden="true" />
                        <span className="min-w-0 flex-1 truncate text-[var(--text-strong)]">
                          {titleOf(entry.name)}
                          <span className="text-[var(--text-muted)]">{extensionOf(entry.name)}</span>
                        </span>
                        <span className="ca-t-xs flex-none tabular-nums text-[var(--text-muted)]">{formatSize(entry.size)}</span>
                      </label>
                    </li>
                  ),
                )}
              </ul>
            </div>
          </div>

          <div className="space-y-1.5">
            <div
              role="radiogroup"
              aria-label={t("webdavImport.mode")}
              className="grid grid-cols-2 gap-1 rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-input)] p-1"
            >
              {(["download", "stream"] as const).map((value) => {
                const Icon = value === "download" ? HardDriveDownload : Cloud;
                const activeMode = mode === value;
                return (
                  <label
                    key={value}
                    className={cn(
                      "flex cursor-pointer items-center justify-center gap-2 rounded-lg px-3 py-2 text-sm transition-colors",
                      activeMode
                        ? "bg-[var(--surface-panel)] font-medium text-[var(--text-strong)] shadow-[0_1px_2px_rgb(0_0_0/0.08)]"
                        : "text-[var(--text-muted)] hover:text-[var(--text-strong)]",
                    )}
                  >
                    <input type="radio" name="webdav-mode" className="sr-only" checked={activeMode} onChange={() => setMode(value)} />
                    <Icon className={cn("h-4 w-4", activeMode && "text-[var(--accent-text)]")} aria-hidden="true" />
                    {t(`webdavImport.modes.${value}`)}
                  </label>
                );
              })}
            </div>
            <p className="ca-t-xs px-1 leading-relaxed text-[var(--text-muted)]">{t(`webdavImport.modeHints.${mode}`)}</p>
          </div>

          {importing.error && <ErrorNote error={importing.error} />}
          <div className="flex items-center gap-2 pt-1">
            <p className="ca-t-xs min-w-0 flex-1 truncate text-[var(--text-muted)]">
              {chosen.length > 0
                ? t("webdavImport.summary", { count: chosen.length, size: formatSize(chosenBytes) })
                : t("webdavImport.pickFirst")}
            </p>
            <Button variant="ghost" onClick={onClose} disabled={importing.isPending}>
              {t("common.cancel")}
            </Button>
            <Button variant="primary" disabled={chosen.length === 0 || importing.isPending} onClick={() => importing.mutate()}>
              {importing.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
              {chosen.length > 0 ? t("webdavImport.import", { count: chosen.length }) : t("webdavImport.importShort")}
            </Button>
          </div>
        </div>
      )}
    </Modal>
  );
}
