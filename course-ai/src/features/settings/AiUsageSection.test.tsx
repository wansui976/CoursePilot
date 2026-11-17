import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import { AiUsageSection } from "./AiUsageSection";
import { VideoAiUsage } from "@/features/workspace/VideoAiUsage";

const { mockIpc } = vi.hoisted(() => ({
  mockIpc: {
    aiUsage: { summary: vi.fn(), video: vi.fn(), deepseekBalance: vi.fn() },
    settings: { get: vi.fn(), set: vi.fn() },
  },
}));
vi.mock("@/lib/ipc", () => ({ ipc: mockIpc }));

const row = (key: string, name: string | null, costUsd: number, extra = {}) => ({
  key,
  name,
  calls: 3,
  promptTokens: 120_000,
  cachedTokens: 90_000,
  completionTokens: 8_000,
  costUsd,
  unpricedCalls: 0,
  ...extra,
});

describe("AiUsageSection", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("zh-CN");
    mockIpc.settings.get.mockReset().mockResolvedValue("5");
    mockIpc.settings.set.mockReset().mockResolvedValue(undefined);
    mockIpc.aiUsage.deepseekBalance.mockReset().mockResolvedValue(null);
    mockIpc.aiUsage.summary.mockReset().mockResolvedValue({
      sinceMs: 0,
      total: row("", null, 0.42, { unpricedCalls: 2 }),
      byLabel: [row("notes", null, 0.3), row("correction", null, 0.12)],
      byModel: [row("deepseek-flash", null, 0.42)],
      byCourse: [row("c1", "机器学习导论", 0.4), row("", null, 0.02)],
      monthCostUsd: 0.42,
      budgetUsd: 5,
    });
  });

  it("shows this month against the budget, broken down by task, course and model", async () => {
    render(<AiUsageSection />);
    expect(await screen.findByText("$0.42 / 预算 $5.00")).toBeInTheDocument();
    expect(screen.getByRole("progressbar", { name: "本月花费" })).toHaveAttribute("aria-valuenow", "8");
    // 用途显示成中文名，不是内部的 label。
    expect(screen.getByText("笔记")).toBeInTheDocument();
    expect(screen.getByText("字幕纠错")).toBeInTheDocument();
    expect(screen.getByText("机器学习导论")).toBeInTheDocument();
    expect(screen.getByText("其他（助手、未归属）")).toBeInTheDocument();
    expect(screen.getAllByText(/缓存命中 75%/).length).toBeGreaterThan(0);
    expect(screen.getByText("2 次调用查不到价格，未计入")).toBeInTheDocument();
  });

  it("hides the DeepSeek balance row when no official DeepSeek profile is set up", async () => {
    render(<AiUsageSection />);
    await screen.findByText("$0.42 / 预算 $5.00");
    expect(mockIpc.aiUsage.deepseekBalance).toHaveBeenCalled();
    expect(screen.queryByText("DeepSeek 余额")).not.toBeInTheDocument();
  });

  it("shows the DeepSeek balance with its granted part, and warns when it has run out", async () => {
    mockIpc.aiUsage.deepseekBalance.mockResolvedValue({
      profileName: "DeepSeek",
      isAvailable: true,
      balances: [{ currency: "CNY", total: "110.00", granted: "10.00", toppedUp: "100.00" }],
    });
    const { unmount } = render(<AiUsageSection />);
    expect(await screen.findByText("¥110.00")).toBeInTheDocument();
    expect(screen.getByText("含赠送 ¥10.00")).toBeInTheDocument();
    unmount();

    mockIpc.aiUsage.deepseekBalance.mockResolvedValue({
      profileName: "DeepSeek",
      isAvailable: false,
      balances: [{ currency: "CNY", total: "0.00", granted: "0.00", toppedUp: "0.00" }],
    });
    render(<AiUsageSection />);
    expect(await screen.findByText("余额不足，调用会失败，请先充值")).toBeInTheDocument();
  });

  it("shows a failed balance lookup in its own row without hiding the spend", async () => {
    mockIpc.aiUsage.deepseekBalance.mockRejectedValue("查询 DeepSeek 余额失败（HTTP 401）");
    render(<AiUsageSection />);
    expect(await screen.findByText("查询 DeepSeek 余额失败（HTTP 401）")).toBeInTheDocument();
    expect(screen.getByText("$0.42 / 预算 $5.00")).toBeInTheDocument();
  });

  it("saves the budget, and clearing it means no limit", async () => {
    render(<AiUsageSection />);
    const input = await screen.findByLabelText("每月预算（美元）");
    await waitFor(() => expect(input).toHaveValue(5));
    fireEvent.change(input, { target: { value: "12.5" } });
    fireEvent.blur(input);
    await waitFor(() => expect(mockIpc.settings.set).toHaveBeenCalledWith("ai_monthly_budget_usd", "12.5"));
    fireEvent.change(input, { target: { value: "-3" } });
    fireEvent.blur(input);
    await waitFor(() => expect(mockIpc.settings.set).toHaveBeenCalledWith("ai_monthly_budget_usd", ""));
  });
});

describe("VideoAiUsage", () => {
  const wrap = (ui: React.ReactElement) =>
    render(<QueryClientProvider client={new QueryClient()}>{ui}</QueryClientProvider>);

  it("shows what this lecture's AI processing cost", async () => {
    await i18n.changeLanguage("zh-CN");
    mockIpc.aiUsage.video.mockResolvedValue(row("", null, 0.0123));
    wrap(<VideoAiUsage videoId="v1" />);
    expect(await screen.findByText(/AI 处理：约 \$0\.01 · /)).toBeInTheDocument();
  });

  it("stays hidden until something was recorded", async () => {
    mockIpc.aiUsage.video.mockResolvedValue({ ...row("", null, 0), calls: 0 });
    const { container } = wrap(<VideoAiUsage videoId="v2" />);
    await waitFor(() => expect(mockIpc.aiUsage.video).toHaveBeenCalledWith("v2"));
    expect(container).toBeEmptyDOMElement();
  });
});
