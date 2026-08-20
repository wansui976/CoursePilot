import "@testing-library/jest-dom/vitest";
import "@/i18n";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DevConsole } from "./DevConsole";

const { logs, llmUsage, clearLogs, clearLlmUsage } = vi.hoisted(() => ({
  logs: vi.fn(),
  llmUsage: vi.fn(),
  clearLogs: vi.fn(),
  clearLlmUsage: vi.fn(),
}));

vi.mock("@/lib/ipc", () => ({
  ipc: {
    dev: { logs, llmUsage, clearLogs, clearLlmUsage },
  },
}));

function renderConsole() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <DevConsole onClose={vi.fn()} />
    </QueryClientProvider>,
  );
}

describe("DevConsole", () => {
  beforeEach(() => {
    logs.mockReset().mockResolvedValue([]);
    llmUsage.mockReset().mockResolvedValue([]);
    clearLogs.mockReset().mockResolvedValue(undefined);
    clearLlmUsage.mockReset().mockResolvedValue(undefined);
  });

  it("wraps header actions into a dedicated phone-width toolbar", () => {
    renderConsole();
    const toolbar = screen.getByRole("toolbar");
    expect(toolbar).toHaveClass("w-full", "sm:w-auto");
    expect(toolbar.closest("header")).toHaveClass("flex-wrap", "sm:flex-nowrap", "px-3");
    expect(screen.getByRole("button", { name: "复制全部" })).toHaveAttribute(
      "title",
      "复制全部",
    );
    expect(screen.getByRole("button", { name: "刷新" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "清空" })).toBeInTheDocument();
  });
});
