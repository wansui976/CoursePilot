import { open } from "@tauri-apps/plugin-dialog";
import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { humanizeError } from "@/lib/errors";
import { ipc } from "@/lib/ipc";
import type { ProbeResult } from "@/lib/types";

type Step = "url" | "cookie" | "probing" | "confirm";

export function BilibiliImportDialog({
  courseId,
  onClose,
}: {
  courseId: string;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [step, setStep] = useState<Step>("url");
  const [url, setUrl] = useState("");
  const [probe, setProbe] = useState<ProbeResult | null>(null);
  const [quality, setQuality] = useState<number | undefined>(undefined);
  const [subLang, setSubLang] = useState<string | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
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
    const file = await open({
      multiple: false,
      pickerMode: "document",
      filters: [{ name: "cookies.txt", extensions: ["txt"] }],
    });
    if (!file || Array.isArray(file)) return;
    await ipc.tools.setBilibiliCookies(file);
    void runProbe();
  };

  const startUrl = async () => {
    setError(null);
    // 只有确实导入了 cookies.txt（文件存在且非空）才放行；否则先引导导入，
    // 避免设置里残留旧路径却在下载时报 412。
    const hasCookies = await ipc.tools.hasBilibiliCookies();
    if (!hasCookies) {
      setCookieReason("missing");
      setStep("cookie");
    } else {
      void runProbe();
    }
  };

  const importMutation = useMutation({
    mutationFn: (useSub: boolean) =>
      ipc.tools.importBilibili(
        courseId,
        url.trim(),
        quality,
        useSub ? subLang : undefined,
      ),
    onSuccess: (video, useSub) => {
      queryClient.invalidateQueries({ queryKey: ["videos", courseId] });
      // 选用了字幕：立即跑流水线，让字幕被消化成文稿（ASR 阶段会走字幕分支、
      // 跳过语音识别），用户无需再手动「开始处理」。
      if (useSub) {
        void ipc.pipeline.process(video.id);
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

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      onClick={onClose}
    >
      <div
        className="w-[420px] rounded-2xl border border-[var(--border-subtle)] bg-[var(--surface-panel)] p-5 shadow-[var(--shadow-pop)]"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="mb-3 text-sm font-semibold text-[var(--text-strong)]">
          下载 B站视频
        </h2>

        {step === "url" && (
          <div className="space-y-3">
            <input
              aria-label="视频链接"
              className="w-full rounded-md border border-[var(--border-subtle)] bg-[var(--surface-input)] px-3 py-2 text-sm outline-none focus:border-primary/70"
              placeholder="B 站 / 视频链接…"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
            />
            {error && <p className="text-xs text-red-400">{humanizeError(error)}</p>}
            <div className="flex justify-end gap-2">
              <Button size="sm" variant="outline" onClick={onClose}>
                取消
              </Button>
              <Button size="sm" disabled={!url.trim()} onClick={startUrl}>
                下一步
              </Button>
            </div>
          </div>
        )}

        {step === "cookie" && (
          <div className="space-y-3 text-sm text-[var(--text-muted)]">
            {cookieReason === "expired" ? (
              <p>
                B站登录态可能已失效（下载报错 <b>HTTP 412</b> 等），需要重新导出
                cookies.txt 再导入。
              </p>
            ) : (
              <p>B站自带字幕与高清晰度通常需要登录态，请先导入 cookies.txt。</p>
            )}
            <ol className="list-decimal space-y-1 pl-5 text-xs leading-relaxed">
              <li>
                Chrome 安装扩展
                <b className="text-[var(--text-strong)]">
                  {" "}
                  Get cookies.txt LOCALLY{" "}
                </b>
              </li>
              <li>登录 bilibili.com，点扩展图标导出 cookies.txt</li>
              <li>回到这里选择刚导出的 cookies.txt</li>
            </ol>
            {error && (
              <p className="whitespace-pre-wrap break-words text-xs text-red-400">
                {humanizeError(error)}
              </p>
            )}
            <div className="flex justify-end gap-2">
              <Button size="sm" variant="outline" onClick={() => setStep("url")}>
                返回
              </Button>
              <Button size="sm" onClick={pickCookie}>
                选择 cookies.txt
              </Button>
            </div>
          </div>
        )}

        {step === "probing" && (
          <p className="py-6 text-center text-sm text-[var(--text-muted)]">
            正在探测视频信息…
          </p>
        )}

        {step === "confirm" && probe && (
          <div className="space-y-4">
            <p className="text-xs text-[var(--text-faint)]">{probe.title}</p>

            <div>
              <div className="mb-1 text-xs font-medium text-[var(--text-muted)]">
                清晰度
              </div>
              <div className="flex flex-wrap gap-1.5">
                {probe.qualities.length === 0 && (
                  <span className="text-xs text-[var(--text-faint)]">
                    用最高可用
                  </span>
                )}
                {probe.qualities.map((q) => (
                  <button
                    key={q}
                    onClick={() => setQuality(q)}
                    className={`rounded px-2 py-1 text-xs ${quality === q ? "bg-primary/20 text-primary" : "bg-[var(--surface-card-hover)]"}`}
                  >
                    {q}P
                  </button>
                ))}
              </div>
            </div>

            {probe.tracks.length > 0 ? (
              <div>
                <div className="mb-1 text-xs font-medium text-[var(--text-muted)]">
                  检测到自带字幕，可用它替代 AI 转写
                </div>
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
              </div>
            ) : (
              <p className="text-xs text-[var(--text-faint)]">
                未检测到自带字幕，将用语音转写。
              </p>
            )}

            {error && <p className="text-xs text-red-400">{humanizeError(error)}</p>}
            <div className="flex justify-end gap-2">
              {probe.tracks.length > 0 && (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={importMutation.isPending}
                  onClick={() => importMutation.mutate(false)}
                >
                  不用字幕
                </Button>
              )}
              <Button
                size="sm"
                disabled={importMutation.isPending}
                onClick={() => importMutation.mutate(probe.tracks.length > 0)}
              >
                {importMutation.isPending
                  ? "下载中…"
                  : probe.tracks.length > 0
                    ? "用所选字幕下载"
                    : "下载"}
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
