import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Check, Copy } from "lucide-react";

/** 代码块：等宽、横向滚动不折行，右上角一键复制（编程课的回答里常有整段代码）。 */
export function CodeBlock({ code, lang }: { code: string; lang: string }) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  return (
    <div className="group/code relative my-2">
      <pre className="overflow-x-auto rounded-md border border-[var(--border-faint)] bg-[var(--surface-card-hover)] px-3 py-2.5 font-[family-name:var(--mono)] text-[12.5px] leading-relaxed text-[var(--text-strong)]">
        <code data-lang={lang || undefined}>{code}</code>
      </pre>
      <button
        type="button"
        aria-label={copied ? t("markdown.codeCopied") : t("markdown.copyCode")}
        title={copied ? t("markdown.codeCopied") : t("markdown.copyCode")}
        onClick={() => {
          void navigator.clipboard?.writeText(code).then(
            () => {
              setCopied(true);
              window.setTimeout(() => setCopied(false), 1500);
            },
            () => {},
          );
        }}
        className="absolute right-1.5 top-1.5 grid h-7 w-7 place-items-center rounded-md bg-[var(--surface-panel)] text-[var(--text-muted)] opacity-0 transition-opacity hover:text-[var(--text-strong)] focus-visible:opacity-100 group-hover/code:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)] motion-reduce:transition-none"
      >
        {copied ? <Check className="h-3.5 w-3.5 text-[var(--status-ok)]" /> : <Copy className="h-3.5 w-3.5" />}
      </button>
    </div>
  );
}
