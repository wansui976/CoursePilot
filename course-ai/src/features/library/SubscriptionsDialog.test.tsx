import "@testing-library/jest-dom/vitest";
import i18n from "@/i18n";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SubscriptionsDialog } from "./SubscriptionsDialog";

const { mockIpc } = vi.hoisted(() => ({
  mockIpc: {
    subscriptions: { list: vi.fn(), check: vi.fn(), remove: vi.fn() },
  },
}));
vi.mock("@/lib/ipc", () => ({ ipc: mockIpc }));

const sub = {
  id: "s1",
  course_id: "c1",
  url: "https://space.bilibili.com/1/lists/2",
  title: "资料分析合集",
  auto_process: true,
  last_checked_at: null,
  last_error: "第 9 讲：会员专享",
  created_at: 0,
};

function renderDialog() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const onClose = vi.fn();
  render(
    <QueryClientProvider client={client}>
      <SubscriptionsDialog courseId="c1" courseName="资料分析" onClose={onClose} />
    </QueryClientProvider>,
  );
  return { onClose };
}

describe("SubscriptionsDialog", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("zh-CN");
    mockIpc.subscriptions.list.mockReset().mockResolvedValue([sub]);
    mockIpc.subscriptions.check.mockReset();
    mockIpc.subscriptions.remove.mockReset().mockResolvedValue(undefined);
  });

  it("lists subscriptions with their last error", async () => {
    renderDialog();
    expect(await screen.findByText("资料分析合集")).toBeInTheDocument();
    expect(screen.getByText("还没检查过")).toBeInTheDocument();
    expect(screen.getByText(/会员专享/)).toBeInTheDocument();
  });

  it("checks now and reports how many videos were imported", async () => {
    mockIpc.subscriptions.check.mockResolvedValue(2);
    renderDialog();
    fireEvent.click(await screen.findByRole("button", { name: "立即检查 资料分析合集" }));
    expect(await screen.findByText("导入了 2 个新视频")).toBeInTheDocument();
    expect(mockIpc.subscriptions.check).toHaveBeenCalledWith("s1");
  });

  it("unsubscribes", async () => {
    renderDialog();
    fireEvent.click(await screen.findByRole("button", { name: "取消订阅 资料分析合集" }));
    await waitFor(() => expect(mockIpc.subscriptions.remove).toHaveBeenCalledWith("s1"));
  });

  it("explains how to subscribe when there are none", async () => {
    mockIpc.subscriptions.list.mockResolvedValue([]);
    renderDialog();
    expect(await screen.findByText(/还没有订阅/)).toBeInTheDocument();
  });
});
