import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import "@/i18n";
import { ipc } from "@/lib/ipc";
import { MistakeDeck } from "./MistakeDeck";

function renderDeck(onReview = vi.fn()) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MistakeDeck onReview={onReview} />
    </QueryClientProvider>,
  );
  return onReview;
}

describe("MistakeDeck", () => {
  it("shows the latest mistake with its streak and starts a mistakes-only review", async () => {
    vi.spyOn(ipc.srs, "mistakes").mockResolvedValue([
      { card_id: "a", video_id: "v", course_id: "c", front: "重根时一定不能对角化吗？", back: "不一定", source_ms: 1000, lapses: 2, streak: 1 },
      { card_id: "b", video_id: "v", course_id: "c", front: "Q2", back: "A2", source_ms: null, lapses: 1, streak: 0 },
    ]);
    const onReview = renderDeck();
    expect(await screen.findByText("重根时一定不能对角化吗？")).toBeInTheDocument();
    expect(screen.getByText("答错 2 次")).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "已连对 1 次，共需 3 次" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "只复习错题" }));
    expect(onReview).toHaveBeenCalled();
  });

  it("renders nothing when there are no mistakes", async () => {
    const spy = vi.spyOn(ipc.srs, "mistakes").mockResolvedValue([]);
    renderDeck();
    await vi.waitFor(() => expect(spy).toHaveBeenCalled());
    expect(screen.queryByText("错题本")).toBeNull();
  });
});
