import "@testing-library/jest-dom/vitest";
import "@/i18n";
import i18n from "@/i18n";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReviewBook, ReviewProgress } from "@/lib/ipc";
import { ReviewBookPanel } from "./ReviewBookPanel";

const { get, running, generate, cancel } = vi.hoisted(() => ({
  get: vi.fn(),
  running: vi.fn(),
  generate: vi.fn(),
  cancel: vi.fn(),
}));
vi.mock("@/lib/ipc", () => ({ ipc: { reviewBook: { get, running, generate, cancel } } }));

function renderPanel(onJump = vi.fn()) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <ReviewBookPanel courseId="c1" onJump={onJump} />
    </QueryClientProvider>,
  );
  return { onJump };
}

const empty: ReviewBook = {
  title: null,
  generated_at: null,
  chapters: [],
  outline_stale: false,
  videos_with_notes: 3,
  videos_without_notes: [],
};

const book: ReviewBook = {
  title: "机器学习复习",
  generated_at: Date.now() - 60_000,
  outline_stale: false,
  videos_with_notes: 2,
  videos_without_notes: ["第三讲"],
  chapters: [
    {
      idx: 0,
      title: "优化",
      intro: "怎么把损失降下来",
      content_md: "## 学习目标\n- 能说清梯度下降 [N001 12:30]\n\n| 考点 | 怎么答 |\n| --- | --- |\n| 学习率 | 先小后大 [N002] |",
      sources: {
        N001: { video_id: "v1", video_title: "第一讲 梯度下降", start_ms: 750_000 },
        N002: { video_id: "v1", video_title: "第一讲 梯度下降", start_ms: 780_000 },
      },
      error: null,
      stale: false,
      generated_at: Date.now(),
    },
    {
      idx: 1,
      title: "泛化",
      intro: "",
      content_md: null,
      sources: {},
      error: "模型输出达到单次输出上限被截断",
      stale: false,
      generated_at: null,
    },
  ],
};

describe("ReviewBookPanel", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("zh-CN");
    vi.clearAllMocks();
    running.mockResolvedValue(false);
  });

  it("offers to build the book, shows progress, and lists the chapters once written", async () => {
    get.mockResolvedValueOnce(empty).mockResolvedValue(book);
    let report!: (progress: ReviewProgress) => void;
    let finish!: () => void;
    generate.mockImplementation((_course: string, _rewrite: number | null, onProgress: (p: ReviewProgress) => void) => {
      report = onProgress;
      return new Promise((resolve) => {
        finish = () => resolve({ written: 1, failed: 1, canceled: false });
      });
    });
    renderPanel();

    fireEvent.click(await screen.findByRole("button", { name: "生成复习资料" }));
    await waitFor(() => expect(generate).toHaveBeenCalledWith("c1", null, expect.any(Function)));
    act(() => report({ stage: "chapters", done: 1, total: 2 }));
    expect(await screen.findByText("正在写各章 · 已完成 1/2")).toBeInTheDocument();

    act(() => finish());
    expect(await screen.findByRole("heading", { name: "优化" })).toBeInTheDocument();
    expect(screen.getAllByText(/1 章没写成/).length).toBeGreaterThan(0);
    expect(screen.getByText(/1 个视频还没有笔记.*第三讲/)).toBeInTheDocument();
  });

  it("renders sources as chips that jump to the video moment, and tables", async () => {
    get.mockResolvedValue(book);
    const { onJump } = renderPanel();
    const chip = await screen.findByRole("button", { name: "回看「第一讲 梯度下降」12:30" });
    fireEvent.click(chip);
    expect(onJump).toHaveBeenCalledWith("v1", 750_000);
    // 没写时间的出处跳到小节开头。
    fireEvent.click(screen.getByRole("button", { name: "回看「第一讲 梯度下降」13:00" }));
    expect(onJump).toHaveBeenLastCalledWith("v1", 780_000);
    expect(screen.getByRole("table")).toBeInTheDocument();
    expect(document.body.textContent).not.toContain("[N001");
  });

  it("retries just the failed chapter", async () => {
    get.mockResolvedValue(book);
    generate.mockResolvedValue({ written: 1, failed: 0, canceled: false });
    renderPanel();
    expect(await screen.findByText(/这一章没写成：模型输出达到单次输出上限被截断/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "重试这一章" }));
    await waitFor(() => expect(generate).toHaveBeenCalledWith("c1", 1, expect.any(Function)));
  });

  it("explains that notes are needed when no video has any", async () => {
    get.mockResolvedValue({ ...empty, videos_with_notes: 0 });
    renderPanel();
    expect(await screen.findByText(/这门课还没有笔记/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "生成复习资料" })).toBeNull();
  });

  it("picks up a build that is still running in the background", async () => {
    get.mockResolvedValue(empty);
    running.mockResolvedValue(true);
    renderPanel();
    expect(await screen.findByText("正在后台生成…")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    expect(cancel).toHaveBeenCalledWith("c1");
  });
});
