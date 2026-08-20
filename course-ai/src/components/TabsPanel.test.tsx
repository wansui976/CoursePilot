import "@testing-library/jest-dom/vitest";
import "@/i18n";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ipc } from "@/lib/ipc";
import { TabsPanel } from "./TabsPanel";

vi.mock("./AiViewPanel", () => ({
  AiViewPanel: () => <div>概览内容</div>,
}));
vi.mock("./NotesPanel", () => ({
  NotesPanel: () => <div>笔记内容</div>,
}));
const transcriptPanel = vi.fn(() => <div>文稿内容</div>);
vi.mock("./TranscriptPanel", () => ({
  TranscriptPanel: () => transcriptPanel(),
}));
vi.mock("./QuizPanel", () => ({
  QuizPanel: () => <div>练习内容</div>,
}));
vi.mock("./MoreStudyPanel", () => ({
  MoreStudyPanel: () => <div>更多内容</div>,
}));
vi.mock("@/lib/ipc", () => ({
  ipc: {
    ai: {
      getQuiz: vi.fn().mockResolvedValue(null),
      getNotes: vi.fn().mockResolvedValue(null),
      getSummary: vi.fn().mockResolvedValue(null),
      getChapters: vi.fn().mockResolvedValue([]),
    },
  },
}));

function renderPanel() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <TabsPanel videoId="video-1" />
    </QueryClientProvider>,
  );
}

describe("TabsPanel", () => {
  beforeEach(() => {
    localStorage.clear();
    transcriptPanel.mockClear();
    // 徽标 mock 归零：badge 测试里的 mockResolvedValue 会改写下游测试的 tab 可访问名。
    vi.mocked(ipc.ai.getQuiz).mockResolvedValue(null);
    vi.mocked(ipc.ai.getNotes).mockResolvedValue(null);
    vi.mocked(ipc.ai.getSummary).mockResolvedValue(null);
    vi.mocked(ipc.ai.getChapters).mockResolvedValue([]);
  });

  it("exposes the flattened primary learning tasks", async () => {
    renderPanel();
    await screen.findByText("概览内容");
    // 徽标在空数据下不出声，纯标签文字保持原样。
    expect(screen.getAllByRole("tab").map((tab) => tab.textContent)).toEqual(
      ["概览", "文稿", "笔记", "练习", "更多"],
    );
  });

  it("shows content badges only when data exists", async () => {
    vi.mocked(ipc.ai.getQuiz).mockResolvedValue(
      JSON.stringify([{ stem: "题目一" }, { stem: "" }, { options: "坏题" }]) as never,
    );
    vi.mocked(ipc.ai.getNotes).mockResolvedValue("# 我的笔记") as never;

    renderPanel();

    const tabs = screen.getAllByRole("tab");
    // 练习 1 题、笔记圆点；概览（无摘要/章节）与文稿不亮。
    await waitFor(() =>
      expect(screen.getByRole("tab", { name: /练习/ })).toHaveTextContent("1"),
    );
    expect(tabs[0].querySelector(".rounded-full")).toBeNull();
    expect(tabs[1].querySelector(".rounded-full")).toBeNull();
    expect(tabs[2].querySelector(".rounded-full")).not.toBeNull();
  });

  it("switches tabs with number keys 1-5", async () => {
    renderPanel();
    await screen.findByText("概览内容");

    fireEvent.keyDown(document.body, { key: "2" });
    expect(screen.getByRole("tab", { name: "文稿" })).toHaveAttribute(
      "data-state",
      "active",
    );

    fireEvent.keyDown(document.body, { key: "5" });
    expect(screen.getByRole("tab", { name: "更多" })).toHaveAttribute(
      "data-state",
      "active",
    );
  });

  it("does not hijack number keys while typing in an input", async () => {
    renderPanel();
    await screen.findByText("概览内容");

    const input = document.createElement("input");
    document.body.appendChild(input);
    input.focus();
    fireEvent.keyDown(input, { key: "2" });
    input.remove();

    expect(screen.getByRole("tab", { name: "概览" })).toHaveAttribute(
      "data-state",
      "active",
    );
  });

  it("restores the active study tab for the video when remounted", () => {
    const { rerender } = renderPanel();

    fireEvent.click(screen.getByRole("tab", { name: "笔记" }));

    expect(screen.getByRole("tab", { name: "笔记" })).toHaveAttribute(
      "data-state",
      "active",
    );

    rerender(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <TabsPanel key="remount" videoId="video-1" />
      </QueryClientProvider>,
    );

    expect(screen.getByRole("tab", { name: "笔记" })).toHaveAttribute(
      "data-state",
      "active",
    );
  });

  it("loads the next video's active tab and drops panels visited by the previous video", async () => {
    localStorage.setItem(
      "course-ai-resume:video-1",
      JSON.stringify({ activeTab: "transcript" }),
    );
    localStorage.setItem(
      "course-ai-resume:video-2",
      JSON.stringify({ activeTab: "notes" }),
    );
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { rerender } = render(
      <QueryClientProvider client={queryClient}>
        <TabsPanel videoId="video-1" />
      </QueryClientProvider>,
    );

    expect(screen.getByRole("tab", { name: "文稿" })).toHaveAttribute(
      "data-state",
      "active",
    );
    const transcriptContent = await screen.findByText("文稿内容");
    expect(transcriptContent.closest("[data-study-tab]")).toHaveAttribute(
      "data-study-tab",
      "transcript",
    );
    fireEvent.click(screen.getByRole("tab", { name: "更多" }));
    expect(await screen.findByText("更多内容")).toBeInTheDocument();

    rerender(
      <QueryClientProvider client={queryClient}>
        <TabsPanel videoId="video-2" />
      </QueryClientProvider>,
    );

    expect(screen.getByRole("tab", { name: "笔记" })).toHaveAttribute(
      "data-state",
      "active",
    );
    expect(await screen.findByText("笔记内容")).toBeInTheDocument();
    expect(screen.queryByText("文稿内容")).not.toBeInTheDocument();
    expect(screen.queryByText("更多内容")).not.toBeInTheDocument();
  });

  it("does not rerender an opened transcript when its parent updates with the same video", async () => {
    const { rerender } = renderPanel();
    // 先等徽标查询 settle：徽标数据到达会让 TabsPanel 内部重渲染一次，
    // 与「父组件用相同 videoId 重渲染」是两回事——后者由 memo 挡住。
    await screen.findByText("概览内容");
    await waitFor(() => expect(ipc.ai.getQuiz).toHaveBeenCalled());

    fireEvent.click(screen.getByRole("tab", { name: "文稿" }));
    await screen.findByText("文稿内容");
    expect(transcriptPanel).toHaveBeenCalledTimes(1);

    rerender(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <TabsPanel videoId="video-1" />
      </QueryClientProvider>,
    );

    await waitFor(() => expect(transcriptPanel).toHaveBeenCalledTimes(1));
  });
});
