import { AlertCircle, RefreshCw, Settings } from "lucide-react";
import { useTranslation } from "react-i18next";
import { errorFixFor, humanizeError } from "@/lib/errors";
import { useOptionalShell } from "@/app/shell";

/**
 * 统一的错误提示：语义错误色 + role=alert（读屏播报）+ 可选「重试」。
 * 报错是配置问题（没配大模型、语音识别密钥无效）时再给一个「去设置」，直达对应分类。
 */
export function ErrorNote({
  error,
  onRetry,
  className,
}: {
  error: unknown;
  onRetry?: () => void;
  className?: string;
}) {
  const { t, i18n } = useTranslation();
  const shell = useOptionalShell();
  const fix = shell ? errorFixFor(error) : null;
  return (
    <div
      role="alert"
      className={`flex items-start gap-2 rounded-lg bg-[var(--status-err-bg)] px-3 py-2 text-xs leading-relaxed text-[var(--status-err)] ${className ?? ""}`}
    >
      <AlertCircle className="mt-0.5 h-3.5 w-3.5 flex-none" />
      <span className="min-w-0 flex-1 break-words">
        {humanizeError(error, i18n.language)}
      </span>
      {fix && shell && (
        <button
          type="button"
          onClick={() => shell.openSettingsCategory(fix)}
          className="inline-flex flex-none items-center gap-1 rounded px-1.5 py-0.5 font-medium underline-offset-2 hover:underline"
        >
          <Settings className="h-3 w-3" />
          {t(fix === "llm" ? "errors.fixLlm" : "errors.fixAsr")}
        </button>
      )}
      {onRetry && (
        <button
          type="button"
          onClick={onRetry}
          className="inline-flex flex-none items-center gap-1 rounded px-1.5 py-0.5 font-medium underline-offset-2 hover:underline"
        >
          <RefreshCw className="h-3 w-3" />
          {t("common.retry")}
        </button>
      )}
    </div>
  );
}
