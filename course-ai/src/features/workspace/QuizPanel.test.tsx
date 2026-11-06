import "@testing-library/jest-dom/vitest";
import "@/i18n";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { QuizPanel } from "./QuizPanel";

const { mockIpc, confirmDialog } = vi.hoisted(() => ({
  mockIpc: {
    ai: {
      getQuiz: vi.fn(),
      generate: vi.fn(),
      deleteQuizSet: vi.fn(),
      gradeQuizAnswer: vi.fn(),
      getQuizCourseRules: vi.fn(),
      setQuizCourseRules: vi.fn(),
    },
    srs: {
      generate: vi.fn(),
    },
  },
  confirmDialog: vi.fn(),
}));

vi.mock("@/lib/ipc", () => ({ ipc: mockIpc }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ confirm: confirmDialog }));

function renderQuizPanel() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });

  return {
    queryClient,
    ...render(
      <QueryClientProvider client={queryClient}>
        <QuizPanel videoId="video-1" />
      </QueryClientProvider>,
    ),
  };
}

describe("QuizPanel", () => {
  beforeEach(() => {
    mockIpc.ai.getQuiz.mockReset();
    mockIpc.ai.generate.mockReset().mockResolvedValue(undefined);
    mockIpc.srs.generate.mockReset().mockResolvedValue(1);
    mockIpc.ai.deleteQuizSet.mockReset().mockResolvedValue(undefined);
    mockIpc.ai.gradeQuizAnswer.mockReset();
    mockIpc.ai.getQuizCourseRules.mockReset().mockResolvedValue("");
    mockIpc.ai.setQuizCourseRules.mockReset().mockResolvedValue(undefined);
    confirmDialog.mockReset().mockResolvedValue(true);
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
    expect(await screen.findByRole("button", { name: "已加入复习" })).toBeInTheDocument();
  });

  it("grades answers as they are picked and shows a summary once all are answered", async () => {
    mockIpc.ai.getQuiz.mockResolvedValue(
      JSON.stringify([
        { type: "judge", stem: "地球是圆的", answer: true },
        { type: "judge", stem: "太阳从西边升起", answer: false },
      ]),
    );
    renderQuizPanel();

    await screen.findByText("已答 0/2");
    // 第 1 题选「正确」（对），第 2 题也选「正确」（错）。
    fireEvent.click(screen.getAllByRole("button", { name: "正确" })[0]);
    expect(screen.getByText("已答 1/2")).toBeInTheDocument();
    fireEvent.click(screen.getAllByRole("button", { name: "正确" })[1]);

    expect(await screen.findByText(/共 2 题，答对 1 题/)).toBeInTheDocument();
    // 答过的题锁住，不能改选。
    expect(screen.getAllByRole("button", { name: "错误" })[0]).toBeDisabled();
    // 重做这套：清掉作答。
    fireEvent.click(screen.getByRole("button", { name: "重做这套" }));
    expect(screen.getByText("已答 0/2")).toBeInTheDocument();
  });

  it("explains every option once a choice question is answered", async () => {
    mockIpc.ai.getQuiz.mockResolvedValue(
      JSON.stringify([
        {
          type: "single",
          stem: "学习率过大会怎样",
          options: ["收敛更快", "来回震荡"],
          answer: "来回震荡",
          option_notes: ["错：这是把步长和速度混为一谈", "对：步子太大越过谷底"],
          explanation: "依据：07:10",
        },
      ]),
    );
    renderQuizPanel();

    const wrong = await screen.findByRole("button", { name: /收敛更快/ });
    expect(screen.queryByText(/把步长和速度混为一谈/)).not.toBeInTheDocument();
    fireEvent.click(wrong);

    expect(await screen.findByText(/把步长和速度混为一谈/)).toBeInTheDocument();
    expect(screen.getByText(/步子太大越过谷底/)).toBeInTheDocument();
    expect(screen.getByText(/答对 0 题/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /来回震荡/ })).toBeDisabled();
  });

  it("checks a multiple-choice answer only after submitting the whole selection", async () => {
    mockIpc.ai.getQuiz.mockResolvedValue(
      JSON.stringify([
        { type: "multi", stem: "哪些是正则化", options: ["L1", "L2", "Dropout", "加大学习率"], answer: ["L1", "L2", "Dropout"] },
      ]),
    );
    renderQuizPanel();

    const submit = await screen.findByRole("button", { name: "提交" });
    expect(submit).toBeDisabled();
    for (const name of [/L1/, /L2/, /Dropout/]) fireEvent.click(screen.getByRole("button", { name }));
    expect(screen.getByText("已答 0/1")).toBeInTheDocument();
    fireEvent.click(submit);
    expect(await screen.findByText(/共 1 题，答对 1 题/)).toBeInTheDocument();
  });

  it("peeking at the answer ends the question so it cannot be answered afterwards", async () => {
    mockIpc.ai.getQuiz.mockResolvedValue(
      JSON.stringify([{ type: "judge", stem: "地球是圆的", answer: true }]),
    );
    renderQuizPanel();

    fireEvent.click(await screen.findByRole("button", { name: "显示答案" }));
    expect(await screen.findByText("答案", { exact: true })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "正确" })).toBeDisabled();
    expect(screen.getByText(/共 1 题，答对 0 题/)).toBeInTheDocument();
  });

  it("sends a written answer for grading and shows the verdict", async () => {
    const question = {
      type: "correct",
      stem: "学习率越大收敛越快。",
      answer: "学习率过大会震荡甚至发散。",
      key_points: ["指出越大越快是错的"],
      ref_ms: 430000,
    };
    mockIpc.ai.getQuiz.mockResolvedValue(JSON.stringify([question]));
    mockIpc.ai.gradeQuizAnswer.mockResolvedValue({
      verdict: "partial",
      feedback: "错处找对了，改法不完整",
      missed: ["说出过大会震荡"],
    });
    renderQuizPanel();

    const box = await screen.findByRole("textbox", { name: "指出错在哪，并写出正确的说法" });
    const submit = screen.getByRole("button", { name: "提交批改" });
    expect(submit).toBeDisabled();
    fireEvent.change(box, { target: { value: "不是越大越快" } });
    fireEvent.click(submit);

    await waitFor(() =>
      expect(mockIpc.ai.gradeQuizAnswer).toHaveBeenCalledWith(
        "video-1",
        expect.objectContaining({ type: "correct", stem: "学习率越大收敛越快。", key_points: ["指出越大越快是错的"] }),
        "不是越大越快",
      ),
    );
    expect(await screen.findByText("部分正确")).toBeInTheDocument();
    expect(screen.getByText("说出过大会震荡")).toBeInTheDocument();
    expect(screen.getByText("参考答案")).toBeInTheDocument();
    expect(screen.getByText(/部分正确 1 题/)).toBeInTheDocument();
  });

  it("shows the newest set by default and switches between sets", async () => {
    mockIpc.ai.getQuiz.mockResolvedValue(
      JSON.stringify([
        { type: "judge", stem: "最早的旧题", answer: true },
        { type: "judge", stem: "新一套的题", answer: true, set_id: "s2", style: "apply", set_at: 1_700_000_000_000 },
      ]),
    );
    renderQuizPanel();

    expect(await screen.findByText("新一套的题")).toBeInTheDocument();
    expect(screen.queryByText("最早的旧题")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "选择题目套" }));
    fireEvent.click(await screen.findByRole("menuitemradio", { name: /最初的一套/ }));
    expect(await screen.findByText("最早的旧题")).toBeInTheDocument();
  });

  it("deletes the shown set after confirming", async () => {
    mockIpc.ai.getQuiz.mockResolvedValue(
      JSON.stringify([{ type: "judge", stem: "题", answer: true, set_id: "s1", style: "recall", set_at: 1 }]),
    );
    renderQuizPanel();

    fireEvent.click(await screen.findByRole("button", { name: "选择题目套" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "删除这套题" }));
    await waitFor(() => expect(mockIpc.ai.deleteQuizSet).toHaveBeenCalledWith("video-1", "s1"));
  });

  it("generates a new set with the chosen style and saves this course's rules", async () => {
    mockIpc.ai.getQuiz.mockResolvedValue(
      JSON.stringify([{ type: "judge", stem: "题", answer: true }]),
    );
    mockIpc.ai.getQuizCourseRules.mockResolvedValue("旧要求");
    renderQuizPanel();

    fireEvent.click(await screen.findByRole("button", { name: "再出一套" }));
    const rules = await screen.findByRole("textbox", { name: "本课程的出题要求" });
    await waitFor(() => expect(rules).toHaveValue("旧要求"));
    fireEvent.click(screen.getByRole("radio", { name: /找错改错/ }));
    fireEvent.change(rules, { target: { value: "多出计算题" } });
    fireEvent.click(screen.getByRole("button", { name: "出题" }));

    await waitFor(() =>
      expect(mockIpc.ai.generate).toHaveBeenCalledWith("video-1", "quiz", { style: "correct", append: true }),
    );
    expect(mockIpc.ai.setQuizCourseRules).toHaveBeenCalledWith("video-1", "多出计算题");
  });

  it("shows and retries an add-to-review failure", async () => {
    mockIpc.ai.getQuiz.mockResolvedValue(
      JSON.stringify([{ type: "judge", stem: "地球是圆的", answer: true }]),
    );
    mockIpc.srs.generate
      .mockRejectedValueOnce(new Error("复习任务保存失败"))
      .mockResolvedValueOnce(1);
    renderQuizPanel();

    fireEvent.click(await screen.findByRole("button", { name: /加入每日复习/ }));

    expect(await screen.findByRole("alert")).toHaveTextContent("复习任务保存失败");
    fireEvent.click(screen.getByRole("button", { name: "重试" }));

    await waitFor(() => expect(mockIpc.srs.generate).toHaveBeenCalledTimes(2));
    expect(await screen.findByRole("button", { name: "已加入复习" })).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("shows a retryable read error instead of the empty state or generation entry", async () => {
    mockIpc.ai.getQuiz
      .mockRejectedValueOnce(new Error("题库读取失败"))
      .mockResolvedValueOnce(null);

    renderQuizPanel();

    expect(await screen.findByRole("alert")).toHaveTextContent("题库读取失败");
    expect(screen.queryByText(/还没有题目/)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "生成" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "重试" }));

    await waitFor(() => expect(mockIpc.ai.getQuiz).toHaveBeenCalledTimes(2));
    expect(await screen.findByText(/还没有题目/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "生成" })).toBeInTheDocument();
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
      // 题干 1 + 选项 2 + 解析 1；选择题的答案标在选项上，不再另写一遍。
      expect(container.querySelectorAll(".katex").length).toBeGreaterThanOrEqual(4);
    });
  });

  it("marks the right answer with the theme status token", async () => {
    mockIpc.ai.getQuiz.mockResolvedValue(
      JSON.stringify([
        { type: "judge", stem: "地球是圆的", answer: true },
      ]),
    );
    renderQuizPanel();

    fireEvent.click(await screen.findByRole("button", { name: "显示答案" }));

    // 对的那一项走主题 token 的底色（深浅主题对比都达标），不硬编码 tailwind 绿。
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /正确/ })).toHaveClass("bg-[var(--status-ok-bg)]"),
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
    expect(await screen.findByText("答案", { exact: true })).toBeInTheDocument();
    expect(screen.getAllByText("正确").length).toBeGreaterThanOrEqual(2);
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

    const last = await screen.findByText("第 20 题");
    const scroller = screen.getByLabelText("练习内容滚动区");
    // jsdom 不做布局，滚不出真实位移。能验证的是最后一题确实挂在这个滚动区里，
    // 且容器本身被撑满的父级限住高度、允许纵向滚动——少了任何一样，题目又被裁掉。
    expect(scroller).toContainElement(last);
    expect(scroller).toHaveClass("min-h-0", "flex-1", "overflow-y-auto");
    expect(scroller.parentElement).toHaveClass("h-full", "flex-col");
  });

  it("还没有题目时也给得出生成按钮", async () => {
    // 空状态的文案一直写着「也可点右下角生成」，而这个面板从来没挂过那组按钮——
    // 加载中和空题库都是提前 return 的，恰恰绕过了最需要它的那两个状态。
    mockIpc.ai.getQuiz.mockResolvedValue(null);
    renderQuizPanel();

    expect(await screen.findByText(/还没有题目/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "生成" }));

    await waitFor(() =>
      expect(mockIpc.ai.generate).toHaveBeenCalledWith("video-1", "quiz"),
    );
  });

  it("有题目时顶上是「再出一套」，不再有右下角的重新生成按钮", async () => {
    mockIpc.ai.getQuiz.mockResolvedValue(
      JSON.stringify([{ type: "judge", stem: "地球是圆的", answer: true }]),
    );
    renderQuizPanel();

    expect(await screen.findByRole("button", { name: "再出一套" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "重新生成" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "生成" })).not.toBeInTheDocument();
  });

  it("生成失败要说出来，而不是按钮转一圈就没了", async () => {
    mockIpc.ai.getQuiz.mockResolvedValue(null);
    mockIpc.ai.generate.mockRejectedValueOnce(new Error("模型没配好"));
    renderQuizPanel();

    await screen.findByText(/还没有题目/);
    fireEvent.click(screen.getByRole("button", { name: "生成" }));

    expect(await screen.findByText(/模型没配好/)).toBeInTheDocument();
  });

  it("hides answers revealed for the previous video when videoId changes", async () => {
    mockIpc.ai.getQuiz.mockResolvedValue(
      JSON.stringify([{ type: "judge", stem: "地球是圆的", answer: true }]),
    );
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    const ui = (videoId: string) => (
      <QueryClientProvider client={queryClient}>
        <QuizPanel videoId={videoId} />
      </QueryClientProvider>
    );
    const { rerender } = render(ui("video-1"));

    fireEvent.click(await screen.findByRole("button", { name: "显示答案" }));
    expect(await screen.findByText("答案", { exact: true })).toBeInTheDocument();

    rerender(ui("video-2"));

    await waitFor(() =>
      expect(screen.getByRole("button", { name: "显示答案" })).toBeInTheDocument(),
    );
    expect(screen.queryByText("答案", { exact: true })).not.toBeInTheDocument();
  });

  it("hides revealed answers when the same video's regenerated quiz arrives", async () => {
    mockIpc.ai.getQuiz
      .mockResolvedValueOnce(
        JSON.stringify([{ type: "judge", stem: "旧题", answer: true }]),
      )
      .mockResolvedValue(
        JSON.stringify([{ type: "judge", stem: "新题", answer: false }]),
      );
    renderQuizPanel();

    fireEvent.click(await screen.findByRole("button", { name: "显示答案" }));
    expect(await screen.findByText("答案", { exact: true })).toBeInTheDocument();

    // 有题时从「再出一套」进出题对话框，打开「替换」就是原来的重新生成。
    fireEvent.click(screen.getByRole("button", { name: "再出一套" }));
    fireEvent.click(await screen.findByRole("switch", { name: "替换现有题目" }));
    fireEvent.click(screen.getByRole("button", { name: "出题" }));
    await waitFor(() =>
      expect(mockIpc.ai.generate).toHaveBeenCalledWith("video-1", "quiz", { style: "apply", append: false }),
    );

    expect(await screen.findByText("新题")).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "显示答案" })).toBeInTheDocument(),
    );
    expect(screen.queryByText("答案", { exact: true })).not.toBeInTheDocument();
  });

  it("does not reuse revealed indexes when the query cache receives a new quiz", async () => {
    const oldQuiz = JSON.stringify([{ type: "judge", stem: "旧题", answer: true }]);
    const newQuiz = JSON.stringify([{ type: "judge", stem: "外部更新的新题", answer: false }]);
    mockIpc.ai.getQuiz.mockResolvedValue(oldQuiz);
    const { queryClient } = renderQuizPanel();

    fireEvent.click(await screen.findByRole("button", { name: "显示答案" }));
    expect(await screen.findByText("答案", { exact: true })).toBeInTheDocument();

    act(() => queryClient.setQueryData(["quiz", "video-1"], newQuiz));

    expect(await screen.findByText("外部更新的新题")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "显示答案" })).toBeInTheDocument();
    expect(screen.queryByText("答案", { exact: true })).not.toBeInTheDocument();
  });
});
