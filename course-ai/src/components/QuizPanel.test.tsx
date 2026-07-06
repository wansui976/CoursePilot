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

  it("shows the empty state (not a crash) when stored quiz JSON is not an array", async () => {
    // 旧数据 / 校验前生成的题库可能不是数组（如 {"questions":[...]}）。
    mockIpc.ai.getQuiz.mockResolvedValue('{"questions":[]}');

    renderQuizPanel();

    expect(
      await screen.findByText(/还没有题目/),
    ).toBeInTheDocument();
  });
});
