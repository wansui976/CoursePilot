import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { QuizPanel } from "./QuizPanel";

const { mockIpc } = vi.hoisted(() => ({
  mockIpc: {
    ai: {
      getQuiz: vi.fn(),
    },
    srs: {
      generate: vi.fn(),
    },
  },
}));

vi.mock("@/lib/ipc", () => ({ ipc: mockIpc }));

function renderQuizPanel() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });

  return render(
    <QueryClientProvider client={queryClient}>
      <QuizPanel videoId="video-1" />
    </QueryClientProvider>,
  );
}

describe("QuizPanel", () => {
  beforeEach(() => {
    mockIpc.ai.getQuiz.mockReset();
    mockIpc.srs.generate.mockReset().mockResolvedValue(1);
  });

  it("adds the quiz to spaced-repetition review", async () => {
    mockIpc.ai.getQuiz.mockResolvedValue(
      JSON.stringify([{ type: "judge", stem: "地球是圆的", answer: true }]),
    );
    renderQuizPanel();

    fireEvent.click(await screen.findByRole("button", { name: /加入每日复习/ }));

    await waitFor(() =>
      expect(mockIpc.srs.generate).toHaveBeenCalledWith("video-1"),
    );
    expect(await screen.findByText("已加入复习")).toBeInTheDocument();
  });

  it("renders LaTeX math in quiz stems, options, and explanations", async () => {
    mockIpc.ai.getQuiz.mockResolvedValue(
      JSON.stringify([
        {
          type: "single",
          stem: "若速度为 \\(v\\)，求动能公式",
          options: ["\\(E_k=\\frac12mv^2\\)", "\\(E=mc^2\\)"],
          answer: "\\(E_k=\\frac12mv^2\\)",
          explanation: "代入 \\[E_k=\\frac12mv^2\\] 即可。",
          ref_ms: 1000,
        },
      ]),
    );

    const { container } = renderQuizPanel();

    await waitFor(() => {
      expect(container.querySelectorAll(".katex").length).toBeGreaterThanOrEqual(3);
    });

    fireEvent.click(screen.getByRole("button", { name: "显示答案" }));

    await waitFor(() => {
      expect(container.querySelectorAll(".katex").length).toBeGreaterThanOrEqual(5);
    });
  });

  it("uses the theme status token for the revealed answer", async () => {
    mockIpc.ai.getQuiz.mockResolvedValue(
      JSON.stringify([
        { type: "judge", stem: "地球是圆的", answer: true },
      ]),
    );
    renderQuizPanel();

    fireEvent.click(await screen.findByRole("button", { name: "显示答案" }));

    // 答案色走主题 token（深浅主题对比都达标），不硬编码 tailwind 绿。
    expect((await screen.findByText(/答案：/)).closest("div")).toHaveClass(
      "text-[var(--status-ok)]",
    );
  });

  it("shows the empty state (not a crash) when stored quiz JSON is not an array", async () => {
    // 旧数据 / 校验前生成的题库可能不是数组（如 {"questions":[...]}）。
    mockIpc.ai.getQuiz.mockResolvedValue('{"questions":[]}');

    renderQuizPanel();

    expect(
      await screen.findByText(/还没有题目/),
    ).toBeInTheDocument();
  });

  it("drops malformed stored questions instead of blanking the panel", async () => {
    // 逐题校验是后来才加的，库里存量题目没经过它。渲染时 options.map 撞上字符串
    // 就是 TypeError，一道坏题会让整个面板白屏——坏题丢掉，好题照常显示。
    mockIpc.ai.getQuiz.mockResolvedValue(
      JSON.stringify([
        {},
        { type: "single", stem: null, options: ["a", "b"], answer: "a" },
        { type: "single", stem: "选项写成了字符串", options: "a、b", answer: "a" },
        { type: "single", stem: "答案是个对象", options: ["a", "b"], answer: { a: 1 } },
        { type: "single", stem: "这道题是好的", options: ["甲", "乙"], answer: "甲" },
      ]),
    );

    renderQuizPanel();

    expect(await screen.findByText("这道题是好的")).toBeInTheDocument();
    expect(screen.queryByText("选项写成了字符串")).not.toBeInTheDocument();
    expect(screen.queryByText("答案是个对象")).not.toBeInTheDocument();
    expect(screen.queryByText(/还没有题目/)).not.toBeInTheDocument();
  });

  it("still renders a question whose options are missing", async () => {
    // 判断题本来就没有选项；缺 options 不该被当成坏题丢掉。
    mockIpc.ai.getQuiz.mockResolvedValue(
      JSON.stringify([{ type: "judge", stem: "地球是圆的", answer: true }]),
    );

    renderQuizPanel();

    expect(await screen.findByText("地球是圆的")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "显示答案" }));
    expect(await screen.findByText(/正确/)).toBeInTheDocument();
  });

  it("题目装在自己的滚动区里，而不是被标签页容器裁掉", async () => {
    // 真实反馈：练习翻不动。标签页容器是 overflow-hidden 的，这个面板却直接铺了一坨
    // 内容出去——不是滚不动，是压根没地方滚，后面的题被裁在视口外。
    mockIpc.ai.getQuiz.mockResolvedValue(
      JSON.stringify(
        Array.from({ length: 20 }, (_, i) => ({
          type: "judge",
          stem: `第 ${i + 1} 题`,
          answer: true,
        })),
      ),
    );

    renderQuizPanel();

    const scroller = await screen.findByLabelText("练习内容滚动区");
    // jsdom 不做布局，滚不出真实位移。能验证的是最后一题确实挂在这个滚动区里，
    // 且容器本身限高并允许纵向滚动——少了任何一样，题目就又被裁掉了。
    expect(scroller).toContainElement(screen.getByText("第 20 题"));
    expect(scroller).toHaveClass("h-full", "overflow-y-auto");
  });
});
