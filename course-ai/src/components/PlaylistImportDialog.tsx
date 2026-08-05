import { open } from "@tauri-apps/plugin-dialog";
import * as Dialog from "@radix-ui/react-dialog";
import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { humanizeError } from "@/lib/errors";
import { ipc } from "@/lib/ipc";
import { formatMs } from "@/lib/time";
import type { PlaylistInfo, Video } from "@/lib/types";

type Step = "url" | "cookie" | "probing" | "confirm" | "importing" | "done";

const QUALITY_PRESETS: { labelKey?: string; label: string; value: number | undefined }[] = [
  { labelKey: "playlistImport.best", label: "最高", value: undefined },
  { label: "1080P", value: 1080 },
  { label: "720P", value: 720 },
  { label: "480P", value: 480 },
];

/** 网络播放列表/合集批量导入：枚举各集 → 勾选 + 批量默认项 → 逐集下载入库并处理。 */
export function PlaylistImportDialog({
  courseId,
  onClose,
  onStartProcessing,
}: {
  courseId: string;
  onClose: () => void;
  onStartProcessing?: (video: Video) => void;
}) {
  const { t } = useTranslation();
  const restoreFocusRef = useRef<HTMLElement | null>(
    typeof document !== "undefined" &&
      document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null,
  );
  const queryClient = useQueryClient();
  const [step, setStep] = useState<Step>("url");
  const [url, setUrl] = useState("");
  const [info, setInfo] = useState<PlaylistInfo | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [maxHeight, setMaxHeight] = useState<number | undefined>(undefined);
  const [useSub, setUseSub] = useState(true);
  const [autocorrect, setAutocorrect] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [preparing, setPreparing] = useState(false);
  const [cookieReason, setCookieReason] = useState<"missing" | "expired">("missing");
  const [progress, setProgress] = useState<{ done: number; total: number; title: string } | null>(
    null,
  );
  const [results, setResults] = useState<{ ok: number; failures: { title: string; error: string }[] } | null>(
    null,
  );

  const looksLikeCookieError = (msg: string) =>
    /412|precondition|forbidden|403|login|cookie|需要登录|风控/i.test(msg);

  const runProbe = async () => {
    setError(null);
    setStep("probing");
    try {
      const r = await ipc.tools.probePlaylist(url.trim());
      if (r.episodes.length === 0) {
        setError(t("playlistImport.noVideosFound"));
        setStep("url");
        return;
      }
      setInfo(r);
      setSelected(new Set(r.episodes.map((e) => e.url))); // 默认全选
      const globalAutocorrect = await ipc.settings.get("subtitle_autocorrect").catch(() => null);
      setAutocorrect(globalAutocorrect !== "false");
      setStep("confirm");
    } catch (e) {
      const msg = String(e);
      if (looksLikeCookieError(msg)) {
        setError(msg);
        setCookieReason("expired");
        setStep("cookie");
      } else {
        setError(msg);
        setStep("url");
      }
    }
  };

  const startUrl = async () => {
    if (preparing) return;
    setError(null);
    setPreparing(true);
    try {
      const hasCookies = await ipc.tools.hasBilibiliCookies();
      if (!hasCookies) {
        setCookieReason("missing");
        setStep("cookie");
      } else {
        await runProbe();
      }
    } catch (e) {
      setError(String(e));
      setStep("url");
    } finally {
      setPreparing(false);
    }
  };

  const pickCookie = async () => {
    if (preparing) return;
    setError(null);
    setPreparing(true);
    try {
      const file = await open({
        multiple: false,
        pickerMode: "document",
        filters: [{ name: "cookies.txt", extensions: ["txt"] }],
      });
      if (!file || Array.isArray(file)) return;
      await ipc.tools.setBilibiliCookies(file);
      await runProbe();
    } catch (e) {
      setError(String(e));
      setStep("cookie");
    } finally {
      setPreparing(false);
    }
  };

  const toggle = (epUrl: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(epUrl)) next.delete(epUrl);
      else next.add(epUrl);
      return next;
    });

  const allSelected = info != null && selected.size === info.episodes.length;
  const toggleAll = () =>
    setSelected(allSelected ? new Set() : new Set(info!.episodes.map((e) => e.url)));

  // 逐集下载入库并处理；部分失败不中断，最后汇报。
  const runImport = async () => {
    if (!info) return;
    const eps = info.episodes.filter((e) => selected.has(e.url));
    if (eps.length === 0) return;
    setStep("importing");
    const failures: { title: string; error: string }[] = [];
    let ok = 0;
    for (let i = 0; i < eps.length; i++) {
      const ep = eps[i];
      setProgress({ done: i, total: eps.length, title: ep.title });
      try {
        const video = await ipc.tools.importBilibili(
          courseId,
          ep.url,
          maxHeight,
          useSub ? "ai-zh" : undefined,
          useSub ? autocorrect : undefined,
        );
        ok += 1;
        // 批量导入一律走处理流水线（用户不会挨个手点「开始处理」）。
        if (onStartProcessing) onStartProcessing(video);
        else void ipc.pipeline.process(video.id);
      } catch (e) {
        failures.push({ title: ep.title, error: humanizeError(String(e)) });
      }
    }
    queryClient.invalidateQueries({ queryKey: ["videos", courseId] });
    setProgress({ done: eps.length, total: eps.length, title: "" });
    setResults({ ok, failures });
    setStep("done");
  };

  const closeBlocked =
    preparing || step === "probing" || step === "importing";

  return (
    <Dialog.Root
      open
      onOpenChange={(open) => {
        if (!open && !closeBlocked) onClose();
      }}
    >
      <Dialog.Overlay
        data-testid="playlist-import-overlay"
        className="ca-dialog-overlay fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      >
        <Dialog.Content
          aria-modal="true"
          aria-describedby={undefined}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            restoreFocusRef.current?.focus();
          }}
          onEscapeKeyDown={(event) => {
            if (closeBlocked) event.preventDefault();
          }}
          onInteractOutside={(event) => {
            if (closeBlocked) event.preventDefault();
          }}
          onPointerDownOutside={(event) => {
            if (closeBlocked) event.preventDefault();
          }}
          className="flex max-h-[80vh] w-[460px] flex-col rounded-2xl border border-[var(--border-subtle)] bg-[var(--surface-panel)] p-5 shadow-[var(--shadow-pop)]"
        >
        <Dialog.Title className="mb-3 flex-none text-sm font-semibold text-[var(--text-strong)]">
          {t("playlistImport.title")}
        </Dialog.Title>

        {step === "url" && (
          <div className="space-y-3">
            <input
              aria-label={t("playlistImport.linkLabel")}
              autoFocus
              className="w-full rounded-md border border-[var(--border-subtle)] bg-[var(--surface-input)] px-3 py-2 text-sm outline-none focus:border-primary/70"
              placeholder={t("playlistImport.linkPlaceholder")}
              value={url}
              onChange={(e) => setUrl(e.target.value)}
            />
            {error && <p className="text-xs text-[var(--status-err)]">{humanizeError(error)}</p>}
            <div className="flex justify-end gap-2">
              <Button
                size="sm"
                variant="outline"
                disabled={closeBlocked}
                onClick={onClose}
              >
                {t("playlistImport.cancel")}
              </Button>
              <Button size="sm" disabled={!url.trim() || preparing} onClick={startUrl}>
                {preparing ? t("playlistImport.checking") : t("playlistImport.enumerate")}
              </Button>
            </div>
          </div>
        )}

        {step === "cookie" && (
          <div className="space-y-3 text-sm text-[var(--text-muted)]">
            {cookieReason === "expired" ? (
              <p dangerouslySetInnerHTML={{ __html: t("playlistImport.cookieExpired") }} />
            ) : (
              <p>{t("playlistImport.cookieNeeded")}</p>
            )}
            <ol className="list-decimal space-y-1 pl-5 text-xs leading-relaxed">
              <li dangerouslySetInnerHTML={{ __html: t("playlistImport.chromeExtension") }} />
              <li>{t("playlistImport.cookieStep1")}</li>
              <li>{t("playlistImport.cookieStep2")}</li>
            </ol>
            {error && (
              <p className="whitespace-pre-wrap break-words text-xs text-[var(--status-err)]">
                {humanizeError(error)}
              </p>
            )}
            <div className="flex justify-end gap-2">
              <Button
                size="sm"
                variant="outline"
                disabled={closeBlocked}
                onClick={() => setStep("url")}
              >
                {t("playlistImport.back")}
              </Button>
              <Button size="sm" disabled={preparing} onClick={pickCookie}>
                {preparing ? t("playlistImport.importing") : t("playlistImport.selectCookies")}
              </Button>
            </div>
          </div>
        )}

        {step === "probing" && (
          <p className="py-6 text-center text-sm text-[var(--text-muted)]">
            {t("playlistImport.enumerating")}
          </p>
        )}

        {step === "confirm" && info && (
          <>
            <p className="mb-2 flex-none truncate text-xs text-[var(--text-faint)]">{info.title}</p>
            <div className="mb-2 flex flex-none items-center justify-between">
              <Button size="sm" variant="outline" onClick={toggleAll}>
                {allSelected ? t("playlistImport.deselectAll") : t("playlistImport.selectAll")}
              </Button>
              <span className="text-xs text-[var(--text-muted)]">
                {t("playlistImport.selected", { selected: selected.size, total: info.episodes.length })}
              </span>
            </div>
            {/* 整个清单一条细滚动条：长标题不截断，横向滑动时各行一起移动。 */}
            <div className="ca-thin-scroll mb-3 min-h-0 flex-1 overflow-auto rounded-lg border border-[var(--border-subtle)] p-1.5">
              <div className="min-w-max space-y-0.5">
                {info.episodes.map((ep) => (
                  <label
                    key={ep.url}
                    className="flex cursor-pointer items-center gap-2 whitespace-nowrap rounded px-2 py-1.5 text-sm hover:bg-[var(--surface-card-hover)]"
                  >
                    <input
                      type="checkbox"
                      checked={selected.has(ep.url)}
                      onChange={() => toggle(ep.url)}
                      className="h-3.5 w-3.5 flex-none accent-[var(--accent-text)]"
                    />
                    <span title={ep.title} className="text-[var(--text-normal)]">
                      {ep.title}
                    </span>
                    {ep.duration_ms != null && (
                      <span className="ml-auto flex-none pl-3 text-xs tabular-nums text-[var(--text-faint)]">
                        {formatMs(ep.duration_ms)}
                      </span>
                    )}
                  </label>
                ))}
              </div>
            </div>

            <div className="flex-none space-y-2">
              <div>
                <div className="mb-1 text-xs font-medium text-[var(--text-muted)]">{t("playlistImport.qualityLimit")}</div>
                <div className="flex flex-wrap gap-1.5">
                  {QUALITY_PRESETS.map((q) => (
                    <button
                      key={q.label}
                      onClick={() => setMaxHeight(q.value)}
                      className={`rounded px-2 py-1 text-xs ${maxHeight === q.value ? "bg-primary/20 text-primary" : "bg-[var(--surface-card-hover)]"}`}
                    >
                      {q.labelKey ? t(q.labelKey) : q.label}
                    </button>
                  ))}
                </div>
              </div>
              <label className="flex items-center gap-2 text-xs text-[var(--text-normal)]">
                <input
                  type="checkbox"
                  checked={useSub}
                  onChange={(e) => setUseSub(e.target.checked)}
                  className="h-3.5 w-3.5 accent-[var(--accent-text)]"
                />
                {t("playlistImport.preferSubtitle")}
              </label>
              {useSub && (
                <label className="flex items-center gap-2 pl-5 text-xs text-[var(--text-normal)]">
                  <input
                    type="checkbox"
                    checked={autocorrect}
                    onChange={(e) => setAutocorrect(e.target.checked)}
                    className="h-3.5 w-3.5 accent-[var(--accent-text)]"
                  />
                  {t("playlistImport.aiCorrection")}
                </label>
              )}
              {error && <p className="text-xs text-[var(--status-err)]">{humanizeError(error)}</p>}
              <div className="flex justify-end gap-2 pt-1">
                <Button size="sm" variant="outline" onClick={onClose}>
                  {t("playlistImport.cancel")}
                </Button>
                <Button size="sm" disabled={selected.size === 0} onClick={runImport}>
                  {t("playlistImport.importCount", { count: selected.size })}
                </Button>
              </div>
            </div>
          </>
        )}

        {step === "importing" && progress && (
          <div className="space-y-3 py-4">
            <p className="text-center text-sm text-[var(--text-muted)]">
              {t("playlistImport.progress", { done: progress.done, total: progress.total })}
            </p>
            <p className="truncate text-center text-xs text-[var(--text-faint)]">{progress.title}</p>
            <div className="h-1.5 overflow-hidden rounded-full bg-[var(--surface-card-active)]">
              <div
                className="h-full rounded-full bg-primary transition-[width] duration-300 ease-out"
                style={{ width: `${progress.total ? (progress.done / progress.total) * 100 : 0}%` }}
              />
            </div>
            <p className="text-center text-xs text-[var(--text-faint)]">
              {t("playlistImport.progressNote")}
            </p>
          </div>
        )}

        {step === "done" && results && (
          <div className="space-y-3">
            <p className="text-sm text-[var(--text-strong)]">
              {t("playlistImport.resultOk", { ok: results.ok })}
              {results.failures.length > 0 && t("playlistImport.resultFail", { fail: results.failures.length })}
            </p>
            {results.failures.length > 0 && (
              <div className="max-h-40 space-y-1 overflow-y-auto rounded-lg border border-[var(--border-subtle)] p-2 text-xs">
                {results.failures.map((f, i) => (
                  <div key={i} className="text-[var(--status-err)]">
                    <span className="text-[var(--text-normal)]">{f.title}</span>：{f.error}
                  </div>
                ))}
              </div>
            )}
            <div className="flex justify-end">
              <Button size="sm" onClick={onClose}>
                {t("playlistImport.done")}
              </Button>
            </div>
          </div>
        )}
        </Dialog.Content>
      </Dialog.Overlay>
    </Dialog.Root>
  );
}
