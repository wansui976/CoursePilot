import { open } from "@tauri-apps/plugin-dialog";
import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { humanizeError } from "@/lib/errors";
import { ipc } from "@/lib/ipc";
import { formatMs } from "@/lib/time";
import type { PlaylistInfo, Video } from "@/lib/types";

type Step = "url" | "cookie" | "probing" | "confirm" | "importing" | "done";

const QUALITY_PRESETS: { label: string; value: number | undefined }[] = [
  { label: "最高", value: undefined },
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
        setError("这个链接里没有找到可导入的视频");
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

  // Esc 关闭（导入进行中不关，避免误触中断）。
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && step !== "importing") onClose();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [step, onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      onClick={() => step !== "importing" && onClose()}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="playlist-import-title"
        className="flex max-h-[80vh] w-[460px] flex-col rounded-2xl border border-[var(--border-subtle)] bg-[var(--surface-panel)] p-5 shadow-[var(--shadow-pop)]"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 id="playlist-import-title" className="mb-3 flex-none text-sm font-semibold text-[var(--text-strong)]">
          导入播放列表 / 合集
        </h2>

        {step === "url" && (
          <div className="space-y-3">
            <input
              aria-label="播放列表链接"
              autoFocus
              className="w-full rounded-md border border-[var(--border-subtle)] bg-[var(--surface-input)] px-3 py-2 text-sm outline-none focus:border-primary/70"
              placeholder="B 站合集 / 多 P / 播放列表链接…"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
            />
            {error && <p className="text-xs text-[var(--status-err)]">{humanizeError(error)}</p>}
            <div className="flex justify-end gap-2">
              <Button size="sm" variant="outline" onClick={onClose}>
                取消
              </Button>
              <Button size="sm" disabled={!url.trim() || preparing} onClick={startUrl}>
                {preparing ? "检查中…" : "枚举各集"}
              </Button>
            </div>
          </div>
        )}

        {step === "cookie" && (
          <div className="space-y-3 text-sm text-[var(--text-muted)]">
            {cookieReason === "expired" ? (
              <p>
                B站登录态可能已失效（<b>HTTP 412</b> 等），需要重新导出 cookies.txt 再导入。
              </p>
            ) : (
              <p>合集枚举与高清晰度通常需要登录态，请先导入 cookies.txt。</p>
            )}
            <ol className="list-decimal space-y-1 pl-5 text-xs leading-relaxed">
              <li>
                Chrome 安装扩展 <b className="text-[var(--text-strong)]">Get cookies.txt LOCALLY</b>
              </li>
              <li>登录 bilibili.com，点扩展图标导出 cookies.txt</li>
              <li>回到这里选择刚导出的 cookies.txt</li>
            </ol>
            {error && (
              <p className="whitespace-pre-wrap break-words text-xs text-[var(--status-err)]">
                {humanizeError(error)}
              </p>
            )}
            <div className="flex justify-end gap-2">
              <Button size="sm" variant="outline" onClick={() => setStep("url")}>
                返回
              </Button>
              <Button size="sm" disabled={preparing} onClick={pickCookie}>
                {preparing ? "导入中…" : "选择 cookies.txt"}
              </Button>
            </div>
          </div>
        )}

        {step === "probing" && (
          <p className="py-6 text-center text-sm text-[var(--text-muted)]">正在枚举各集…</p>
        )}

        {step === "confirm" && info && (
          <>
            <p className="mb-2 flex-none truncate text-xs text-[var(--text-faint)]">{info.title}</p>
            <div className="mb-2 flex flex-none items-center justify-between">
              <button
                onClick={toggleAll}
                className="text-xs font-medium text-primary hover:underline"
              >
                {allSelected ? "全不选" : "全选"}
              </button>
              <span className="text-xs text-[var(--text-muted)]">
                已选 {selected.size} / {info.episodes.length}
              </span>
            </div>
            <div className="mb-3 min-h-0 flex-1 space-y-0.5 overflow-y-auto rounded-lg border border-[var(--border-subtle)] p-1.5">
              {info.episodes.map((ep) => (
                <label
                  key={ep.url}
                  className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm hover:bg-[var(--surface-card-hover)]"
                >
                  <input
                    type="checkbox"
                    checked={selected.has(ep.url)}
                    onChange={() => toggle(ep.url)}
                    className="h-3.5 w-3.5 flex-none accent-[var(--accent-text)]"
                  />
                  <span className="min-w-0 flex-1 truncate text-[var(--text-normal)]">
                    {ep.title}
                  </span>
                  {ep.duration_ms != null && (
                    <span className="flex-none text-xs tabular-nums text-[var(--text-faint)]">
                      {formatMs(ep.duration_ms)}
                    </span>
                  )}
                </label>
              ))}
            </div>

            <div className="flex-none space-y-2">
              <div>
                <div className="mb-1 text-xs font-medium text-[var(--text-muted)]">清晰度上限</div>
                <div className="flex flex-wrap gap-1.5">
                  {QUALITY_PRESETS.map((q) => (
                    <button
                      key={q.label}
                      onClick={() => setMaxHeight(q.value)}
                      className={`rounded px-2 py-1 text-xs ${maxHeight === q.value ? "bg-primary/20 text-primary" : "bg-[var(--surface-card-hover)]"}`}
                    >
                      {q.label}
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
                优先自带中文字幕（没有则语音转写）
              </label>
              {useSub && (
                <label className="flex items-center gap-2 pl-5 text-xs text-[var(--text-normal)]">
                  <input
                    type="checkbox"
                    checked={autocorrect}
                    onChange={(e) => setAutocorrect(e.target.checked)}
                    className="h-3.5 w-3.5 accent-[var(--accent-text)]"
                  />
                  下载后用 AI 纠错字幕
                </label>
              )}
              {error && <p className="text-xs text-[var(--status-err)]">{humanizeError(error)}</p>}
              <div className="flex justify-end gap-2 pt-1">
                <Button size="sm" variant="outline" onClick={onClose}>
                  取消
                </Button>
                <Button size="sm" disabled={selected.size === 0} onClick={runImport}>
                  导入 {selected.size} 个
                </Button>
              </div>
            </div>
          </>
        )}

        {step === "importing" && progress && (
          <div className="space-y-3 py-4">
            <p className="text-center text-sm text-[var(--text-muted)]">
              正在导入 {progress.done} / {progress.total}…
            </p>
            <p className="truncate text-center text-xs text-[var(--text-faint)]">{progress.title}</p>
            <div className="h-1.5 overflow-hidden rounded-full bg-[var(--surface-card-active)]">
              <div
                className="h-full rounded-full bg-primary transition-all"
                style={{ width: `${progress.total ? (progress.done / progress.total) * 100 : 0}%` }}
              />
            </div>
            <p className="text-center text-xs text-[var(--text-faint)]">
              下载中请勿关闭；失败的集不会中断其余项。
            </p>
          </div>
        )}

        {step === "done" && results && (
          <div className="space-y-3">
            <p className="text-sm text-[var(--text-strong)]">
              导入完成：成功 {results.ok} 个
              {results.failures.length > 0 && `，失败 ${results.failures.length} 个`}。
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
                完成
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
