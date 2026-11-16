/** 大模型用量的显示格式（设置里的「用量与花费」、视频概览底下那一行共用）。 */

/** 美元金额：不到 1 美分时给到四位小数，免得满屏 $0.00。 */
export function formatUsd(value: number): string {
  if (value > 0 && value < 0.01) return `$${value.toFixed(4)}`;
  return `$${value.toFixed(2)}`;
}

/** token 数：1.2 万 / 34 万这样读得快。 */
export function formatTokens(value: number, language: string): string {
  return new Intl.NumberFormat(language, { notation: "compact", maximumFractionDigits: 1 }).format(value);
}
