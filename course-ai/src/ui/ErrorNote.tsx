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
      className={`ca-callout err ${className ?? ""}`}
    >
      <AlertCircle className="ca-callout-icon" />
      <span className="min-w-0 flex-1 break-words text-[var(--text-normal)]">
        {humanizeError(error, i18n.language)}
      </span>
      {fix && shell && (
        <button
          type="button"
          onClick={() => shell.openSettingsCategory(fix)}
          className="ca-callout-act"
        >
          <Settings className="h-3 w-3" />
          {t(fix === "llm" ? "errors.fixLlm" : "errors.fixAsr")}
        </button>
      )}
      {onRetry && (
        <button
          type="button"
          onClick={onRetry}
          className="ca-callout-act"
        >
          <RefreshCw className="h-3 w-3" />
          {t("common.retry")}
        </button>
      )}
    </div>
  );
}
