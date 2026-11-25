/** 大模型用量的显示格式（设置里的「用量与花费」、模型详情的参考价、视频概览底下那一行共用）。 */

/**
 * 参考汇率：1 美元合多少人民币。花费在库里一律按美元记（各家参考价多是美元），中文界面显示时
 * 按它折成人民币。2026-11-24 市场价约 6.66；改的时候和 `src-tauri/src/usage_log.rs` 的
 * `USD_TO_CNY` 一起改。
 */
export const USD_TO_CNY = 6.66;

export type Currency = "CNY" | "USD";

/** 中文界面用人民币，其余用美元。 */
export function currencyFor(language: string): Currency {
  return language.toLowerCase().startsWith("zh") ? "CNY" : "USD";
}

/** 美元金额折成界面货币。 */
export function fromUsd(usd: number, currency: Currency): number {
  return currency === "CNY" ? usd * USD_TO_CNY : usd;
}

/** 界面货币的金额折回美元（存预算用）。 */
export function toUsd(amount: number, currency: Currency): number {
  return currency === "CNY" ? amount / USD_TO_CNY : amount;
}

const SIGN: Record<Currency, string> = { CNY: "¥", USD: "$" };

/** 花费：按界面语言用 ¥ 或 $；不到 1 分（1 美分）时给到四位小数，免得满屏 0.00。 */
export function formatCost(usd: number, language: string): string {
  const currency = currencyFor(language);
  const value = fromUsd(usd, currency);
  if (value > 0 && value < 0.01) return `${SIGN[currency]}${value.toFixed(4)}`;
  return `${SIGN[currency]}${value.toFixed(2)}`;
}

/** 每百万 token 的参考价（库里是美元）。 */
export function formatPricePerMillion(usd: number | null | undefined, language: string): string | null {
  if (usd == null) return null;
  const currency = currencyFor(language);
  if (usd === 0) return `${SIGN[currency]}0`;
  const value = fromUsd(usd, currency);
  return `${SIGN[currency]}${value.toFixed(value >= 0.1 ? 2 : 3)}`;
}

/** token 数：1.2 万 / 34 万这样读得快。 */
export function formatTokens(value: number, language: string): string {
  return new Intl.NumberFormat(language, { notation: "compact", maximumFractionDigits: 1 }).format(value);
}
