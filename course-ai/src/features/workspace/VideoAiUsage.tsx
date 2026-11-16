import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { ipc } from "@/lib/ipc";
import { qk } from "@/lib/queryKeys";
import { formatTokens, formatUsd } from "@/lib/aiUsageFormat";

/**
 * 概览页底下一行小字：这节课的 AI 处理（纠错、章节、摘要、笔记、出题…）一共用了多少 token、
 * 按参考价约多少钱。还没有记录（没配大模型、或是升级前处理的）时不显示。
 */
export function VideoAiUsage({ videoId }: { videoId: string }) {
  const { t, i18n } = useTranslation();
  const { data } = useQuery({
    queryKey: qk.aiUsage.video(videoId),
    queryFn: () => ipc.aiUsage.video(videoId),
  });
  if (!data || data.calls === 0) return null;
  const tokens = formatTokens(data.promptTokens + data.completionTokens, i18n.language);
  const priced = data.unpricedCalls < data.calls;
  return (
    <p className="shrink-0 border-t border-[var(--border-faint)] px-3 py-1.5 text-[11px] tabular-nums text-[var(--text-faint)]">
      {priced
        ? t("aiUsage.videoLine", { cost: formatUsd(data.costUsd), tokens })
        : t("aiUsage.videoLineUnpriced", { tokens })}
    </p>
  );
}
