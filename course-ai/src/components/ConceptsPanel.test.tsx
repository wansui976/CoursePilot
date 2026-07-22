import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ConceptsPanel } from "./ConceptsPanel";

const { list, analyze, conceptDueCounts, dueByConcept, review } = vi.hoisted(() => ({
  list: vi.fn(),
  analyze: vi.fn(),
  conceptDueCounts: vi.fn(),
  dueByConcept: vi.fn(),
  review: vi.fn(),
}));
vi.mock("@/lib/ipc", () => ({
  ipc: {
    concepts: { list, analyze },
    srs: { conceptDueCounts, dueByConcept, review },
  },
}));

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
    conceptDueCounts.mockReset().mockResolvedValue([]);
    dueByConcept.mockReset().mockResolvedValue([]);
    review.mockReset().mockResolvedValue(undefined);
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

  it("shows a per-concept review button and launches a scoped review session", async () => {
    conceptDueCounts.mockResolvedValue([{ concept_id: "k1", due: 2 }]);
    dueByConcept.mockResolvedValue([
      { id: "c1", video_id: "v1", course_id: "c1", front: "卡片正面", back: "卡片背面", source_ms: 65000 },
    ]);
    renderPanel();

    fireEvent.click(await screen.findByRole("button", { name: /复习 2/ }));
    // 以该概念作用域拉到期卡，进入复习会话显示第一张卡。
    await waitFor(() => expect(dueByConcept).toHaveBeenCalledWith("c1", "k1"));
    expect(await screen.findByText("卡片正面")).toBeInTheDocument();
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
