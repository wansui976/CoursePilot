import "@testing-library/jest-dom/vitest";
import "@/i18n";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ExplanationResult } from "@/lib/types";
import { FindExplanationDialog } from "./FindExplanationDialog";

const { mockIpc } = vi.hoisted(() => ({
  mockIpc: {
    tools: { ocrImage: vi.fn(), findExplanations: vi.fn() },
    slides: { image: vi.fn().mockResolvedValue([]) },
    videos: { cover: vi.fn().mockResolvedValue(null) },
  },
}));
vi.mock("@/lib/ipc", () => ({ ipc: mockIpc }));
vi.mock("./VideoCover", () => ({ VideoCover: () => <span data-testid="cover" /> }));

const result: ExplanationResult = {
  hits: [
    { video_id: "v5", video_title: "05 特征值", start_ms: 1_394_000, end_ms: 1_460_000, snippet: "特征值满足 det(A-λI)=0", slide_image: null, slide_page: null, matched_by: "text", strong: true },
    { video_id: "v6", video_title: "06 对角化", start_ms: 482_000, end_ms: 500_000, snippet: "对角化的前提", slide_image: null, slide_page: null, matched_by: "text", strong: true },
    { video_id: "v2", video_title: "02 矩阵", start_ms: 60_000, end_ms: 70_000, snippet: "矩阵乘法", slide_image: null, slide_page: null, matched_by: "text", strong: false },
  ],
  concepts: [{ concept_id: "k1", name: "特征值", video_id: "v5", start_ms: 1_390_000 }],
};

function renderDialog(props: Partial<Parameters<typeof FindExplanationDialog>[0]> = {}) {
  const handlers = {
    onClose: vi.fn(),
    onOpenAt: vi.fn(),
    onPlayInOrder: vi.fn(),
    onSolveWithGuide: vi.fn(),
    onAskAssistant: vi.fn(),
  };
  render(
    <QueryClientProvider client={new QueryClient()}>
      <FindExplanationDialog courseId="c1" {...handlers} {...props} />
    </QueryClientProvider>,
  );
  return handlers;
}

describe("FindExplanationDialog", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIpc.tools.findExplanations.mockResolvedValue(result);
    mockIpc.tools.ocrImage.mockResolvedValue("求矩阵 A 的特征值");
  });

  it("手打题目 → 找讲解 → 结果按相关度列出，点一条从那里播放", async () => {
    const handlers = renderDialog();
    fireEvent.click(screen.getByRole("button", { name: "没有图？直接输入题目" }));
    fireEvent.change(screen.getByPlaceholderText("输入或粘贴题目文字"), { target: { value: "求特征值" } });
    fireEvent.click(screen.getByRole("button", { name: "找讲解" }));
    await waitFor(() => expect(screen.getByRole("list", { name: "讲这道题的地方" })).toBeInTheDocument());
    expect(mockIpc.tools.findExplanations).toHaveBeenCalledWith("c1", "求特征值", null);
    expect(screen.getAllByText("最相关")).toHaveLength(2);
    expect(screen.getByText("可能相关")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /05 特征值/ }));
    expect(handlers.onOpenAt).toHaveBeenCalledWith("v5", 1_394_000);
    expect(handlers.onClose).toHaveBeenCalled();
  });

  it("「依次播放」只放最相关的几段；知识点可点", async () => {
    const handlers = renderDialog();
    fireEvent.click(screen.getByRole("button", { name: "没有图？直接输入题目" }));
    fireEvent.change(screen.getByPlaceholderText("输入或粘贴题目文字"), { target: { value: "求特征值" } });
    fireEvent.click(screen.getByRole("button", { name: "找讲解" }));
    const play = await screen.findByRole("button", { name: /依次播放这 2 段/ });
    fireEvent.click(play);
    expect(handlers.onPlayInOrder).toHaveBeenCalledWith([result.hits[0], result.hits[1]]);
  });

  it("带图进来：用整张图 → 自动识字填进文字框，可改后再找，图一起带上", async () => {
    renderDialog({ initialImage: "data:image/png;base64,AAAA" });
    fireEvent.click(screen.getByRole("button", { name: "用整张图" }));
    const textarea = await screen.findByPlaceholderText("输入或粘贴题目文字");
    await waitFor(() => expect(textarea).toHaveValue("求矩阵 A 的特征值"));
    expect(mockIpc.tools.ocrImage).toHaveBeenCalledWith("data:image/png;base64,AAAA");
    fireEvent.change(textarea, { target: { value: "求矩阵 A 的特征值 λ" } });
    fireEvent.click(screen.getByRole("button", { name: "找讲解" }));
    await waitFor(() =>
      expect(mockIpc.tools.findExplanations).toHaveBeenCalledWith("c1", "求矩阵 A 的特征值 λ", "data:image/png;base64,AAAA"),
    );
  });

  it("没找到时给出用引导模式一起解的出路", async () => {
    mockIpc.tools.findExplanations.mockResolvedValue({ hits: [], concepts: [] });
    const handlers = renderDialog();
    fireEvent.click(screen.getByRole("button", { name: "没有图？直接输入题目" }));
    fireEvent.change(screen.getByPlaceholderText("输入或粘贴题目文字"), { target: { value: "冷门题" } });
    fireEvent.click(screen.getByRole("button", { name: "找讲解" }));
    fireEvent.click(await screen.findByRole("button", { name: "用引导模式一起解" }));
    expect(handlers.onSolveWithGuide).toHaveBeenCalledWith("冷门题", null);
  });
});
