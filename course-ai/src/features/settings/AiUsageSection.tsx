import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { ipc, type AiUsageRow, type AiUsageSummary, type DeepSeekBalance } from "@/lib/ipc";
import { ErrorNote } from "@/ui/ErrorNote";
import { FIELD, Group, Row, Select, StackRow } from "@/features/settings/primitives";
import { formatTokens, formatUsd } from "@/lib/aiUsageFormat";

const BUDGET_KEY = "ai_monthly_budget_usd";

const CURRENCY_SIGN: Record<string, string> = { CNY: "¥", USD: "$" };
const money = (currency: string, amount: string) =>
  CURRENCY_SIGN[currency] ? `${CURRENCY_SIGN[currency]}${amount}` : `${amount} ${currency}`;

/**
 * 设置 → 大模型 下面的「用量与花费」：本月花了多少、每月预算，按用途 / 课程 / 模型拆开看。
 * 花费是后端按参考价估算的（命中缓存的输入按缓存价），不是账单。
 */
export function AiUsageSection() {
  const { t, i18n } = useTranslation();
  const [days, setDays] = useState(30);
  // 设置页的其他分组都直接调 IPC、不走查询缓存（设置面板不在 QueryClientProvider 下也能用），这里一样。
  const [data, setData] = useState<AiUsageSummary | null>(null);
  const [error, setError] = useState<unknown>(null);
  const load = useCallback(async () => {
    try {
      setData(await ipc.aiUsage.summary(days));
      setError(null);
    } catch (err) {
      setError(err);
    }
  }, [days]);
  useEffect(() => {
    void load();
  }, [load]);
  const refetch = load;
  // DeepSeek 余额：没配 DeepSeek 官方的模型时后端返回 null，这一行就不显示。查失败不挡别的。
  const [balance, setBalance] = useState<DeepSeekBalance | null>(null);
  const [balanceError, setBalanceError] = useState("");
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const value = await ipc.aiUsage.deepseekBalance();
        if (alive) setBalance(value);
      } catch (err) {
        if (alive) setBalanceError(String(err));
      }
    })();
    return () => {
      alive = false;
    };
  }, []);
  const [budget, setBudget] = useState("");
  const [savedBudget, setSavedBudget] = useState("");
  useEffect(() => {
    let alive = true;
    void ipc.settings
      .get(BUDGET_KEY)
      .then((value) => {
        if (!alive) return;
        setBudget(value ?? "");
        setSavedBudget(value ?? "");
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  async function saveBudget() {
    const trimmed = budget.trim();
    const parsed = Number(trimmed);
    const next = trimmed === "" || !Number.isFinite(parsed) || parsed <= 0 ? "" : String(parsed);
    setBudget(next);
    if (next === savedBudget) return;
    await ipc.settings.set(BUDGET_KEY, next);
    setSavedBudget(next);
    await load();
  }

  const tokens = (row: AiUsageRow) =>
    t("aiUsage.tokens", {
      input: formatTokens(row.promptTokens, i18n.language),
      output: formatTokens(row.completionTokens, i18n.language),
    });
  const labelName = (key: string) => t(`aiUsage.labels.${key}`, { defaultValue: key });

  const list = (title: string, rows: AiUsageRow[], name: (row: AiUsageRow) => string) =>
    rows.length > 0 && (
      <StackRow label={title}>
        <ul className="flex flex-col divide-y divide-[var(--border-faint)]">
          {rows.slice(0, 8).map((row) => (
            <li key={row.key} className="flex items-baseline gap-3 py-1.5 text-sm">
              <span className="min-w-0 flex-1 truncate text-[var(--text-strong)]">{name(row)}</span>
              <span className="hidden flex-none text-xs tabular-nums text-[var(--text-muted)] sm:inline">
                {tokens(row)}
                {row.promptTokens > 0 && row.cachedTokens > 0 && (
                  <>
                    {" · "}
                    {t("aiUsage.cachedShare", {
                      percent: Math.round((row.cachedTokens / row.promptTokens) * 100),
                    })}
                  </>
                )}
              </span>
              <span className="w-20 flex-none text-right tabular-nums text-[var(--text-strong)]">
                {formatUsd(row.costUsd)}
              </span>
            </li>
          ))}
        </ul>
      </StackRow>
    );

  const budgetValue = data?.budgetUsd ?? null;
  const ratio = budgetValue ? Math.min(1, (data?.monthCostUsd ?? 0) / budgetValue) : 0;
  return (
    <Group header={t("aiUsage.title")} hint={t("aiUsage.footnote")}>
      {error != null && (
        <div className="px-4 py-3">
          <ErrorNote error={error} onRetry={() => void refetch()} />
        </div>
      )}
      <Row label={t("aiUsage.month")} layout="inline">
        <div className="flex min-w-[10rem] flex-col items-end gap-1">
          <span className="text-sm font-semibold tabular-nums text-[var(--text-strong)]">
            {budgetValue
              ? t("aiUsage.monthOf", {
                  spent: formatUsd(data?.monthCostUsd ?? 0),
                  budget: formatUsd(budgetValue),
                })
              : formatUsd(data?.monthCostUsd ?? 0)}
          </span>
          {budgetValue != null && (
            <div
              role="progressbar"
              aria-label={t("aiUsage.month")}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(ratio * 100)}
              className="h-1 w-40 overflow-hidden rounded-full bg-[var(--surface-card-active)]"
            >
              <div
                className={ratio >= 1 ? "h-full bg-[var(--status-err)]" : "ca-fill-grad h-full"}
                style={{ width: `${ratio * 100}%` }}
              />
            </div>
          )}
        </div>
      </Row>
      {(balance || balanceError) && (
        <Row
          label={t("aiUsage.deepseekBalance")}
          hint={t("aiUsage.deepseekBalanceHint")}
          layout="inline"
          status={
            balanceError ? (
              <span className="text-[var(--status-err)]">{balanceError}</span>
            ) : balance && !balance.isAvailable ? (
              <span className="text-[var(--status-err)]">{t("aiUsage.deepseekUnavailable")}</span>
            ) : (
              balance?.balances
                .filter((info) => Number(info.granted) > 0)
                .map((info) => t("aiUsage.deepseekGranted", { amount: money(info.currency, info.granted) }))
                .join(" · ") || undefined
            )
          }
        >
          {balance && (
            <span className="text-sm font-semibold tabular-nums text-[var(--text-strong)]">
              {balance.balances.length > 0
                ? balance.balances.map((info) => money(info.currency, info.total)).join(" · ")
                : "—"}
            </span>
          )}
        </Row>
      )}
      <Row label={t("aiUsage.budget")} hint={t("aiUsage.budgetHint")} htmlFor="ai-monthly-budget" layout="inline">
        <input
          id="ai-monthly-budget"
          type="number"
          inputMode="decimal"
          min={0}
          step={0.5}
          className={`${FIELD} w-28 text-right`}
          value={budget}
          placeholder={t("aiUsage.budgetPlaceholder")}
          onChange={(event) => setBudget(event.target.value)}
          onBlur={() => void saveBudget()}
          onKeyDown={(event) => {
            if (event.key === "Enter") event.currentTarget.blur();
          }}
        />
      </Row>
      <Row label={t("aiUsage.range")} htmlFor="ai-usage-range">
        <Select id="ai-usage-range" value={String(days)} onChange={(event) => setDays(Number(event.target.value))}>
          <option value="30">{t("aiUsage.days30")}</option>
          <option value="90">{t("aiUsage.days90")}</option>
          <option value="365">{t("aiUsage.days365")}</option>
        </Select>
      </Row>
      {data && data.total.calls === 0 ? (
        <StackRow>
          <p className="text-sm text-[var(--text-muted)]">{t("aiUsage.empty")}</p>
        </StackRow>
      ) : (
        data && (
          <>
            {list(t("aiUsage.byLabel"), data.byLabel, (row) => labelName(row.key))}
            {list(t("aiUsage.byCourse"), data.byCourse, (row) => row.name ?? t("aiUsage.noCourse"))}
            {list(t("aiUsage.byModel"), data.byModel, (row) => row.key)}
            {data.total.unpricedCalls > 0 && (
              <StackRow>
                <p className="text-xs text-[var(--text-muted)]">
                  {t("aiUsage.unpriced", { count: data.total.unpricedCalls })}
                </p>
              </StackRow>
            )}
          </>
        )
      )}
    </Group>
  );
}
