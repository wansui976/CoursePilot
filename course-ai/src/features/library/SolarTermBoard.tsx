import { useTranslation } from "react-i18next";
import { solarTermOn } from "@/lib/solarTerms";

/** 节气那天，黑板角落用粉笔写一行：节气名 · 第一候。只在中文界面出现。 */
export function SolarTermBoard({ now, className }: { now: Date; className?: string }) {
  const { i18n } = useTranslation();
  const term = solarTermOn(now);
  if (!term || !i18n.language.startsWith("zh")) return null;
  return (
    <span className={`ca-term-board ${className ?? ""}`} title={`今日${term.name}`}>
      <b>{term.name}</b>
      <span>{term.phenology}</span>
    </span>
  );
}
