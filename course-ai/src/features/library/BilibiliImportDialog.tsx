import { open } from "@tauri-apps/plugin-dialog";
import { qk } from "@/lib/queryKeys";
import { useRef, useState, type RefObject } from "react";
import { useTranslation } from "react-i18next";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/ui/button";
import { ErrorNote } from "@/ui/ErrorNote";
import { ipc } from "@/lib/ipc";
import type { ProbeResult, Video } from "@/lib/types";
import { Modal } from "@/ui/dialog";
import { isBilibiliUrl } from "@/lib/sourceUrl";

type Step = "url" | "cookie" | "probing" | "confirm";
type ImportRequest = {
  useSub: boolean;
  quality?: number;
  subLang?: string;
  autocorrect: boolean;
};

export function BilibiliImportDialog({
  courseId,
  onClose,
  onStartProcessing,
  returnFocusRef,
}: {
  courseId: string;
  onClose: () => void;
  onStartProcessing?: (video: Video) => void;
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
  const [probe, setProbe] = useState<ProbeResult | null>(null);
  const [quality, setQuality] = useState<number | undefined>(undefined);
  const [subLang, setSubLang] = useState<string | undefined>(undefined);
  // 本次导入是否对字幕做 AI 纠错；探测成功后用全局设置初始化为默认值。
  const [autocorrect, setAutocorrect] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [preparing, setPreparing] = useState(false);
  // cookie 步骤是「首次缺失」还是「登录态失效需重导」，用于切换引导文案。
  const [cookieReason, setCookieReason] = useState<"missing" | "expired">(
    "missing",
  );

  // B站的 412 / 需要登录 / cookie 相关报错，多半是没导入或 cookie 过期。
  const looksLikeCookieError = (msg: string) =>
    /412|precondition|forbidden|403|login|cookie|需要登录|风控/i.test(msg);

  const runProbe = async () => {
    setError(null);
    setStep("probing");
    try {
      const r = await ipc.tools.probeBilibili(url.trim());
      setProbe(r);
      setQuality(r.qualities[0]);
      const def =
        r.tracks.find((t) => !t.auto && t.lang.startsWith("zh")) ??
        r.tracks.find((t) => t.lang === "ai-zh") ??
        r.tracks[0];
      setSubLang(def?.lang);
      // 纠错勾选默认值取全局设置（未设置视为开，与流水线一致）。
      const globalAutocorrect = await ipc.settings
        .get("subtitle_autocorrect")
        .catch(() => null);
      setAutocorrect(globalAutocorrect !== "false");
      setStep("confirm");
    } catch (e) {
      const msg = String(e);
      // cookie 过期/风控（如 HTTP 412）：回到 cookie 步骤引导重新导出导入。
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

  const startUrl = async () => {
    if (preparing) return;
    setError(null);
    setPreparing(true);
    try {
      // 只有确实导入了 cookies.txt（文件存在且非空）才放行；否则先引导导入，
      // 避免设置里残留旧路径却在下载时报 412。
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

  const importMutation = useMutation({
    mutationFn: (request: ImportRequest) =>
      ipc.tools.importBilibili(
        courseId,
        url.trim(),
        request.quality,
        request.useSub ? request.subLang : undefined,
        // 纠错偏好只对带字幕导入有意义；不带字幕不写偏好（保持 NULL）。
        request.useSub ? request.autocorrect : undefined,
      ),
    onSuccess: (video, request) => {
      queryClient.invalidateQueries({ queryKey: qk.videos.list(courseId) });
      // 选用了字幕：立即跑流水线，让字幕被消化成文稿（ASR 阶段会走字幕分支、
      // 跳过语音识别），用户无需再手动「开始处理」。
      if (request.useSub) {
        if (onStartProcessing) onStartProcessing(video);
        else void ipc.pipeline.process(video.id);
      }
      onClose();
    },
    onError: (e) => {
      const msg = String(e);
      setError(msg);
      // 下载阶段的 412 / 需要登录，同样引导重新导入 cookies。
      if (looksLikeCookieError(msg)) {
        setCookieReason("expired");
        setStep("cookie");
      }
    },
  });

  const closeBlocked =
    preparing || step === "probing" || importMutation.isPending;

  return (
    <Modal
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      locked={closeBlocked}
      title={t("bilibiliImport.title")}
      titleClassName="mb-3"
      overlayTestId="bilibili-import-overlay"
      returnFocusTo={() => returnFocusRef?.current ?? restoreFocusRef.current}
    >

      {step === "url" && (
        <div className="space-y-3">
          <input
            aria-label={t("bilibiliImport.linkLabel")}
            autoFocus
            className="w-full rounded-md border border-[var(--border-subtle)] bg-[var(--surface-input)] px-3 py-2 text-sm outline-none focus:border-[var(--focus-ring)]"
            placeholder={t("bilibiliImport.linkPlaceholder")}
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
              {t("bilibiliImport.cancel")}
            </Button>
            <Button
              variant="primary"
              size="sm"
              disabled={!url.trim() || preparing}
              onClick={startUrl}
            >
              {preparing ? t("bilibiliImport.checking") : t("bilibiliImport.next")}
            </Button>
          </div>
        </div>
      )}

      {step === "cookie" && (
        <div className="space-y-3 text-sm text-[var(--text-muted)]">
          {cookieReason === "expired" ? (
            <p dangerouslySetInnerHTML={{ __html: t("bilibiliImport.cookieExpired") }} />
          ) : (
            <p>{t("bilibiliImport.cookieNeeded")}</p>
          )}
          <ol className="list-decimal space-y-1 pl-5 text-xs leading-relaxed">
            <li>
              {t("bilibiliImport.chromeExtension")}
              <b className="text-[var(--text-strong)]">
                {" "}
                Get cookies.txt LOCALLY{" "}
              </b>
            </li>
            <li>{t("bilibiliImport.cookieStep1")}</li>
            <li>{t("bilibiliImport.cookieStep2")}</li>
          </ol>
          {error && <ErrorNote error={error} onRetry={() => void pickCookie()} />}
          <div className="flex flex-wrap justify-end gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={closeBlocked}
              onClick={() => setStep("url")}
            >
              {t("bilibiliImport.back")}
            </Button>
            <Button size="sm" disabled={preparing} onClick={pickCookie}>
              {preparing ? t("bilibiliImport.importing") : t("bilibiliImport.selectCookies")}
            </Button>
          </div>
        </div>
      )}

      {step === "probing" && (
        <p role="status" aria-live="polite" className="py-6 text-center text-sm text-[var(--text-muted)]">
          {t("bilibiliImport.probing")}
        </p>
      )}

      {step === "confirm" && probe && (
        <div className="space-y-4">
          <p className="text-xs text-[var(--text-faint)]">{probe.title}</p>

          <fieldset>
            <legend className="mb-1 text-xs font-medium text-[var(--text-muted)]">
              {t("bilibiliImport.quality")}
            </legend>
            <div className="flex flex-wrap gap-1.5">
              {probe.qualities.length === 0 && (
                <span className="text-xs text-[var(--text-faint)]">
                  {t("bilibiliImport.bestAvailable")}
                </span>
              )}
              {probe.qualities.map((q) => (
                <label
                  key={q}
                  className={`ca-touch-44 inline-flex cursor-pointer items-center rounded px-2 py-1 text-xs focus-within:outline-none focus-within:ring-2 focus-within:ring-[var(--focus-ring)] ${quality === q ? "bg-[var(--accent-weak-2)] text-[var(--accent-text)]" : "bg-[var(--surface-card-hover)]"}`}
                >
                  <input
                    type="radio"
                    name="bilibili-quality"
                    value={q}
                    checked={quality === q}
                    onChange={() => setQuality(q)}
                    className="sr-only"
                  />
                  {q}P
                </label>
              ))}
            </div>
          </fieldset>

          {probe.tracks.length > 0 ? (
            <label className="block">
              <span className="mb-1 block text-xs font-medium text-[var(--text-muted)]">
                {t("bilibiliImport.subtitleDetected")}
              </span>
              <select
                className="w-full rounded-md border border-[var(--border-subtle)] bg-[var(--surface-input)] px-2 py-1.5 text-sm"
                value={subLang}
                onChange={(e) => setSubLang(e.target.value)}
              >
                {probe.tracks.map((t) => (
                  <option key={t.lang} value={t.lang}>
                    {t.name}
                    {t.auto ? "（AI）" : ""}
                  </option>
                ))}
              </select>
            </label>
          ) : (
            <p className="text-xs text-[var(--text-faint)]">
              {t("bilibiliImport.noSubtitle")}
            </p>
          )}
          {probe.tracks.length > 0 && (
            <div>
              <label className="mt-2 flex items-center gap-2 text-xs text-[var(--text-normal)]">
                <input
                  type="checkbox"
                  checked={autocorrect}
                  onChange={(e) => setAutocorrect(e.target.checked)}
                  className="h-3.5 w-3.5 accent-[var(--accent,#888)]"
                />
                {t("bilibiliImport.aiCorrection")}
              </label>
              <p className="mt-1 text-xs text-[var(--text-faint)]">
                {t("bilibiliImport.aiCorrectionNote")}
              </p>
            </div>
          )}

          {error && <ErrorNote error={error} />}
          <div className="flex flex-wrap justify-end gap-2">
            {probe.tracks.length > 0 && (
              <Button
                size="sm"
                variant="outline"
                disabled={importMutation.isPending}
                onClick={() =>
                  importMutation.mutate({
                    useSub: false,
                    quality: quality ?? probe.qualities[0],
                    subLang,
                    autocorrect,
                  })
                }
              >
                {t("bilibiliImport.skipSubtitle")}
              </Button>
            )}
            <Button
              variant="primary"
              size="sm"
              disabled={importMutation.isPending}
              onClick={() =>
                importMutation.mutate({
                  useSub: probe.tracks.length > 0,
                  quality: quality ?? probe.qualities[0],
                  subLang,
                  autocorrect,
                })
              }
            >
              {importMutation.isPending
                ? t("bilibiliImport.downloading")
                : probe.tracks.length > 0
                  ? t("bilibiliImport.downloadWithSub")
                  : t("bilibiliImport.download")}
            </Button>
          </div>
        </div>
      )}
    </Modal>
  );
}
