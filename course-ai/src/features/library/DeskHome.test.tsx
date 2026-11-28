import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import { LectureContents } from "./DeskHome";

const { getChapters } = vi.hoisted(() => ({ getChapters: vi.fn() }));
vi.mock("@/lib/ipc", () => ({ ipc: { ai: { getChapters } } }));

const chapter = (id: number, startMs: number, title: string) => ({
  id,
  video_id: "v1",
  title,
  summary: null,
  start_ms: startMs,
  end_ms: startMs + 60_000,
  order_index: id,
});

function renderContents(positionMs: number) {
  const onJump = vi.fn();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = render(
    <QueryClientProvider client={client}>
      <LectureContents videoId="v1" positionMs={positionMs} onJump={onJump} />
    </QueryClientProvider>,
  );
  return { onJump, ...view };
}

describe("课桌上这一讲的目录", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("zh-CN");
    getChapters.mockReset();
  });

  it("标出上次停在的那一章，点哪章就从哪章开头看", async () => {
    getChapters.mockResolvedValue([
      chapter(1, 0, "回顾"),
      chapter(2, 180_000, "梯度方向"),
      chapter(3, 420_000, "学习率"),
    ]);
    const { onJump } = renderContents(300_000);
    const current = await screen.findByRole("button", { name: /梯度方向/ });
    expect(current).toHaveAttribute("aria-current", "step");
    expect(current).toHaveTextContent("上次停在这里");
    expect(screen.getByRole("button", { name: /学习率/ })).not.toHaveAttribute("aria-current");
    fireEvent.click(screen.getByRole("button", { name: /学习率/ }));
    expect(onJump).toHaveBeenCalledWith(420_000);
  });

  it("章节多时只列上次那章前后几章", async () => {
    getChapters.mockResolvedValue(
      Array.from({ length: 12 }, (_, i) => chapter(i + 1, i * 60_000, `第${i + 1}节`)),
    );
    renderContents(9 * 60_000 + 5_000);
    await screen.findByRole("button", { name: /第10节/ });
    expect(screen.getAllByRole("button")).toHaveLength(6);
    expect(screen.getByText("12 节")).toBeInTheDocument();
  });

  it("还没生成章节时不摆一张空目录", async () => {
    getChapters.mockResolvedValue([]);
    const { container } = renderContents(0);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(container).toBeEmptyDOMElement();
  });
});
