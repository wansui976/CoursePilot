import { open } from "@tauri-apps/plugin-dialog";
import { qk } from "@/lib/queryKeys";
import { useRef, useState, type RefObject } from "react";
import { useTranslation } from "react-i18next";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/ui/button";
import { ErrorNote } from "@/ui/ErrorNote";
import { humanizeError } from "@/lib/errors";
import { ipc } from "@/lib/ipc";
import { formatMs } from "@/lib/time";
import type { PlaylistInfo } from "@/lib/types";
import { Modal } from "@/ui/dialog";
import { isBilibiliUrl } from "@/lib/sourceUrl";
import { useDownloads } from "@/stores/downloads";
import { looksLikeCookieError } from "@/lib/bilibiliCookies";

type Step = "url" | "cookie" | "probing" | "confirm";

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
  returnFocusRef,
}: {
  courseId: string;
  onClose: () => void;
  returnFocusRef?: RefObject<HTMLElement | null>;
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
  // 订阅：把当前各集记为见过，以后合集里出现新视频时后台自动导入。
  const [subscribe, setSubscribe] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [preparing, setPreparing] = useState(false);
  const [enqueueing, setEnqueueing] = useState(false);
  const [cookieReason, setCookieReason] = useState<"missing" | "expired">("missing");


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
      // 只有 B 站需要登录态；YouTube、播客等其他站点直接探测。
      const needsCookies =
        isBilibiliUrl(url) && !(await ipc.tools.hasBilibiliCookies());
      if (needsCookies) {
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

  // 勾选各集交给后台下载队列：并发与断点都在后端，全部下完再统一开始处理。
  // 订阅先建好再入队，避免只订不导时白排队。
  const runImport = async () => {
    if (!info || enqueueing) return;
    const eps = info.episodes.filter((e) => selected.has(e.url));
    if (eps.length === 0 && !subscribe) return;
    setError(null);
    setEnqueueing(true);
    try {
      if (subscribe) {
        await ipc.subscriptions.create(
          courseId,
          url.trim(),
          info.title,
          info.episodes.map((e) => e.url),
        );
        void queryClient.invalidateQueries({ queryKey: qk.subscriptions(courseId) });
        // 只订阅、不导入存量：订好就关。
        if (eps.length === 0) {
          onClose();
          return;
        }
      }
      const jobs = await ipc.downloads.enqueue(
        courseId,
        eps.map((ep) => ({
          url: ep.url,
          title: ep.title,
          maxHeight,
          subLang: useSub ? "ai-zh" : undefined,
          subtitleAutocorrect: useSub ? autocorrect : undefined,
          // 批量导入：整批下完后再统一跑流水线（见后端 finish_batch）。
          autoProcess: true,
        })),
      );
      useDownloads.getState().addMany(jobs);
      queryClient.invalidateQueries({ queryKey: qk.videos.list(courseId) });
      onClose();
    } catch (e) {
      setError(humanizeError(String(e)));
    } finally {
      setEnqueueing(false);
    }
  };

  const closeBlocked = preparing || step === "probing" || enqueueing;

  return (
    <Modal
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      locked={closeBlocked}
      title={t("playlistImport.title")}
      titleClassName="mb-3 flex-none"
      size="lg"
      className="flex flex-col"
      overlayTestId="playlist-import-overlay"
      returnFocusTo={() => returnFocusRef?.current ?? restoreFocusRef.current}
    >

      {step === "url" && (
        <div className="space-y-3">
          <input
            aria-label={t("playlistImport.linkLabel")}
            autoFocus
            className="w-full rounded-md border border-[var(--border-subtle)] bg-[var(--surface-input)] px-3 py-2 text-sm outline-none focus:border-[var(--focus-ring)]"
            placeholder={t("playlistImport.linkPlaceholder")}
            value={url}
            onChange={(e) => setUrl(e.target.value)}
          />
          {error && <ErrorNote error={error} onRetry={() => void startUrl()} />}
          <div className="flex flex-wrap justify-end gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={closeBlocked}
              onClick={onClose}
            >
              {t("playlistImport.cancel")}
            </Button>
            <Button variant="primary" size="sm" disabled={!url.trim() || preparing} onClick={startUrl}>
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
          {error && <ErrorNote error={error} onRetry={() => void pickCookie()} />}
          <div className="flex flex-wrap justify-end gap-2">
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
        <p role="status" aria-live="polite" className="py-6 text-center text-sm text-[var(--text-muted)]">
          {t("playlistImport.enumerating")}
        </p>
      )}

      {step === "confirm" && info && (
        <>
          <p className="mb-2 flex-none truncate text-xs text-[var(--text-faint)]">{info.title}</p>
          <div className="mb-2 flex flex-none flex-wrap items-center justify-between gap-2">
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
            <fieldset>
              <legend className="mb-1 text-xs font-medium text-[var(--text-muted)]">{t("playlistImport.qualityLimit")}</legend>
              <div className="flex flex-wrap gap-1.5">
                {QUALITY_PRESETS.map((q) => (
                  <label
                    key={q.label}
                    className={`ca-touch-44 inline-flex cursor-pointer items-center rounded px-2 py-1 text-xs focus-within:outline-none focus-within:ring-2 focus-within:ring-[var(--focus-ring)] ${maxHeight === q.value ? "bg-[var(--accent-weak-2)] text-[var(--accent-text)]" : "bg-[var(--surface-card-hover)]"}`}
                  >
                    <input
                      type="radio"
                      name="playlist-quality"
                      value={q.value ?? "best"}
                      checked={maxHeight === q.value}
                      onChange={() => setMaxHeight(q.value)}
                      className="sr-only"
                    />
                    {q.labelKey ? t(q.labelKey) : q.label}
                  </label>
                ))}
              </div>
            </fieldset>
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
            <label className="flex items-center gap-2 text-xs text-[var(--text-normal)]">
              <input
                type="checkbox"
                checked={subscribe}
                onChange={(e) => setSubscribe(e.target.checked)}
                className="h-3.5 w-3.5 accent-[var(--accent-text)]"
              />
              {t("subscriptions.subscribeOption")}
            </label>
            {error && <ErrorNote error={error} />}
            <div className="flex flex-wrap justify-end gap-2 pt-1">
              <Button size="sm" variant="outline" onClick={onClose}>
                {t("playlistImport.cancel")}
              </Button>
              <Button
                variant="primary"
                size="sm"
                disabled={(selected.size === 0 && !subscribe) || enqueueing}
                onClick={runImport}
              >
                {enqueueing
                  ? t("playlistImport.queuing")
                  : selected.size === 0 && subscribe
                    ? t("playlistImport.subscribeOnly")
                    : t("playlistImport.importCount", { count: selected.size })}
              </Button>
            </div>
          </div>
        </>
      )}
    </Modal>
  );
}
