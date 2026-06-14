import { AlertCircle, RefreshCw } from "lucide-react";

// 把常见的原始错误映射成人话；其余兜底显示原文，避免吞掉有用信息。
function humanize(raw: string): string {
  const s = raw.toLowerCase();
  if (
    s.includes("api key") ||
    s.includes("apikey") ||
    s.includes("unauthorized") ||
    s.includes("401") ||
    s.includes("no profile") ||
    s.includes("未配置")
  ) {
    return "未配置或密钥无效：请到「设置」检查大模型 / 语音的 API Key。";
  }
  if (s.includes("timeout") || s.includes("timed out") || s.includes("超时")) {
    return "请求超时，请检查网络后重试。";
  }
  if (
    s.includes("network") ||
    s.includes("connect") ||
    s.includes("fetch") ||
    s.includes("dns")
  ) {
    return "网络连接失败，请检查网络后重试。";
  }
  if (s.includes("rate") && s.includes("limit")) {
    return "请求过于频繁（限流），请稍后重试。";
  }
  if (s.includes("ffmpeg")) {
    return "缺少 ffmpeg 或音频处理失败。";
  }
  return raw;
}

/** 统一的错误提示：语义错误色 + role=alert（读屏播报）+ 可选「重试」。 */
export function ErrorNote({
  error,
  onRetry,
  className,
}: {
  error: unknown;
  onRetry?: () => void;
  className?: string;
}) {
  const raw = error instanceof Error ? error.message : String(error);
  return (
    <div
      role="alert"
      className={`flex items-start gap-2 rounded-lg bg-[var(--status-err-bg)] px-3 py-2 text-xs leading-relaxed text-[var(--status-err)] ${className ?? ""}`}
    >
      <AlertCircle className="mt-0.5 h-3.5 w-3.5 flex-none" />
      <span className="min-w-0 flex-1 break-words">{humanize(raw)}</span>
      {onRetry && (
        <button
          type="button"
          onClick={onRetry}
          className="inline-flex flex-none items-center gap-1 rounded px-1.5 py-0.5 font-medium underline-offset-2 hover:underline"
        >
          <RefreshCw className="h-3 w-3" />
          重试
        </button>
      )}
    </div>
  );
}
