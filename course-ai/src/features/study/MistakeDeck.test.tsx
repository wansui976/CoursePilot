import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import { MistakeDeck } from "./MistakeDeck";

const { mockIpc } = vi.hoisted(() => ({ mockIpc: { srs: { mistakes: vi.fn() } } }));
vi.mock("@/lib/ipc", () => ({ ipc: mockIpc }));
vi.mock("@/lib/viewTransition", () => ({ prefersReducedMotion: () => true }));

const card = (id: string, front: string) => ({
  card_id: id,
  video_id: "v",
  course_id: "c",
  front,
  back: "",
  source_ms: null,
  lapses: 2,
  streak: 1,
});

function renderDeck(onReview: () => void = () => {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MistakeDeck onReview={onReview} />
    </QueryClientProvider>,
  );
}

describe("错题本（抽认卡环）", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("zh-CN");
    mockIpc.srs.mistakes.mockReset();
  });

  it("最上面一张写题面、答错次数和连对进度，「只复习错题」开始错题复习", async () => {
    mockIpc.srs.mistakes.mockResolvedValue([
      { ...card("a", "重根时一定不能对角化吗？"), source_ms: 1000 },
      { ...card("b", "Q2"), lapses: 1, streak: 0 },
    ]);
    const onReview = vi.fn();
    renderDeck(onReview);
    expect(await screen.findByText("重根时一定不能对角化吗？")).toBeInTheDocument();
    expect(screen.getByText("答错 2 次")).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "已连对 1 次，共需 3 次" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "只复习错题" }));
    expect(onReview).toHaveBeenCalled();
  });

  it("点最上面那张翻到下一张，翻完一圈回到第一张", async () => {
    mockIpc.srs.mistakes.mockResolvedValue([card("a", "第一题"), card("b", "第二题")]);
    renderDeck();
    const top = await screen.findByRole("button", { name: "翻到下一张（1 / 2）" });
    expect(top).toHaveTextContent("第一题");
    fireEvent.click(top);
    expect(await screen.findByRole("button", { name: "翻到下一张（2 / 2）" })).toHaveTextContent("第二题");
    fireEvent.keyDown(screen.getByRole("button", { name: /翻到下一张/ }), { key: "ArrowRight" });
    expect(await screen.findByRole("button", { name: "翻到下一张（1 / 2）" })).toHaveTextContent("第一题");
  });

  it("一开始就没有错题时什么都不显示", async () => {
    mockIpc.srs.mistakes.mockResolvedValue([]);
    const { container } = renderDeck();
    await vi.waitFor(() => expect(mockIpc.srs.mistakes).toHaveBeenCalled());
    expect(screen.queryByText("错题本")).toBeNull();
    expect(container).toBeEmptyDOMElement();
  });
});
