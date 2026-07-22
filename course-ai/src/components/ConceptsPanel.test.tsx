import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ConceptsPanel } from "./ConceptsPanel";

const { list, analyze } = vi.hoisted(() => ({ list: vi.fn(), analyze: vi.fn() }));
vi.mock("@/lib/ipc", () => ({ ipc: { concepts: { list, analyze } } }));

function renderPanel(onJump = vi.fn(), onClose = vi.fn()) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <ConceptsPanel courseId="c1" courseName="申论" onClose={onClose} onJump={onJump} />
    </QueryClientProvider>,
  );
  return { onJump, onClose };
}

const concept = {
  id: "k1",
  name: "贝叶斯定理",
  occurrences: [
    { video_id: "v1", video_title: "第一讲", start_ms: 65000 },
    { video_id: "v2", video_title: "第二讲", start_ms: 5000 },
  ],
};

describe("ConceptsPanel", () => {
  beforeEach(() => {
    list.mockReset().mockResolvedValue([concept]);
    analyze.mockReset().mockResolvedValue(1);
  });

  it("lists concepts, expands occurrences, and jumps on click", async () => {
    const { onJump } = renderPanel();
    // 概念名 + 出现次数徽标。
    expect(await screen.findByText("贝叶斯定理")).toBeInTheDocument();
    expect(screen.getByText("2")).toBeInTheDocument();

    // 展开看在哪几节讲到。
    fireEvent.click(screen.getByText("贝叶斯定理"));
    const occ = await screen.findByText(/第一讲/);
    fireEvent.click(occ.closest("button")!);
    expect(onJump).toHaveBeenCalledWith("v1", 65000);
  });

  it("shows an analyze CTA when empty and reloads after analyzing", async () => {
    list
      .mockReset()
      .mockResolvedValueOnce([]) // 初次：空
      .mockResolvedValue([concept]); // 分析后重拉
    renderPanel();

    fireEvent.click(await screen.findByRole("button", { name: /分析本课程概念/ }));
    await waitFor(() => expect(analyze).toHaveBeenCalledWith("c1"));
    expect(await screen.findByText("贝叶斯定理")).toBeInTheDocument();
  });
});
