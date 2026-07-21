import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ReviewSession } from "./ReviewSession";

const { due, review } = vi.hoisted(() => ({ due: vi.fn(), review: vi.fn() }));
vi.mock("@/lib/ipc", () => ({ ipc: { srs: { due, review } } }));

const cards = [
  { id: "a", video_id: "v1", course_id: "c1", front: "问题一", back: "答案一", source_ms: 5000 },
  { id: "b", video_id: null, course_id: null, front: "问题二", back: "答案二", source_ms: null },
];

function renderSession(onJump = vi.fn(), onClose = vi.fn()) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <ReviewSession onClose={onClose} onJump={onJump} />
    </QueryClientProvider>,
  );
  return { onJump, onClose };
}

describe("ReviewSession", () => {
  beforeEach(() => {
    due.mockReset().mockResolvedValue(cards);
    review.mockReset().mockResolvedValue(undefined);
  });

  it("reveals the answer, grades, and advances through the deck", async () => {
    renderSession();
    expect(await screen.findByText("问题一")).toBeInTheDocument();
    expect(screen.getByText("1 / 2")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /显示答案/ }));
    expect(screen.getByText("答案一")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /良好/ }));
    await waitFor(() => expect(review).toHaveBeenCalledWith("a", 3));

    // 进到第二张。
    expect(await screen.findByText("问题二")).toBeInTheDocument();
    expect(screen.getByText("2 / 2")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /显示答案/ }));
    fireEvent.click(screen.getByRole("button", { name: /容易/ }));
    await waitFor(() => expect(review).toHaveBeenLastCalledWith("b", 4));

    expect(await screen.findByText("复习完成 🎉")).toBeInTheDocument();
  });

  it("offers 回看出处 for a card with a source and jumps on click", async () => {
    const onJump = vi.fn();
    renderSession(onJump);
    await screen.findByText("问题一");
    fireEvent.click(screen.getByRole("button", { name: /显示答案/ }));

    fireEvent.click(screen.getByRole("button", { name: /回看出处/ }));
    expect(onJump).toHaveBeenCalledWith(cards[0]);
  });

  it("reveals with the space key", async () => {
    renderSession();
    await screen.findByText("问题一");
    fireEvent.keyDown(window, { key: " " });
    expect(screen.getByText("答案一")).toBeInTheDocument();
  });

  it("shows an empty message when nothing is due", async () => {
    due.mockResolvedValue([]);
    renderSession();
    expect(
      await screen.findByText("今天没有待复习的卡片"),
    ).toBeInTheDocument();
  });
});
