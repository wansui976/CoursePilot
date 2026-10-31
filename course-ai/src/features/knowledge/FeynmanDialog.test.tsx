import "@testing-library/jest-dom/vitest";
import "@/i18n";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FeynmanAttempt } from "@/lib/types";
import { usePlayer } from "@/stores/player";
import { FeynmanDialog } from "./FeynmanDialog";

const { mockIpc } = vi.hoisted(() => ({
  mockIpc: {
    feynman: { transcribe: vi.fn(), evaluate: vi.fn(), attempts: vi.fn() },
    srs: { addCard: vi.fn() },
  },
}));
vi.mock("@/lib/ipc", () => ({
  ipc: mockIpc,
  feynmanTopicKey: (topic: { kind: string; concept_id?: string }) => `concept:${topic.concept_id}`,
}));

const attempt = (over: Partial<FeynmanAttempt["result"]> = {}, explanation = "沿负梯度走。学习率越大越好。"): FeynmanAttempt => ({
  id: "a1",
  topic_key: "concept:k1",
  explanation,
  created_at: 1,
  result: {
    covered: [{ point: "沿负梯度方向迭代", quote: "沿负梯度走。" }],
    missed: [{ point: "学习率过大会震荡", video_id: "v3", ref_ms: 430_000 }],
    wrong: [{ quote: "学习率越大越好", correction: "过大会震荡甚至发散", video_id: "v3", ref_ms: 450_000 }],
    comment: "方向讲对了，再补上学习率的影响。",
    ...over,
  },
});

function renderDialog() {
  const handlers = { onClose: vi.fn(), onOpenAt: vi.fn(), onGuide: vi.fn() };
  const rendered = render(
    <QueryClientProvider client={new QueryClient()}>
      <FeynmanDialog topic={{ kind: "concept", concept_id: "k1" }} title="梯度下降" cardVideoId="v3" {...handlers} />
    </QueryClientProvider>,
  );
  return { ...handlers, unmount: rendered.unmount };
}

async function explain(text: string) {
  const typeInstead = screen.queryByRole("button", { name: "不方便出声？打字也行" });
  if (typeInstead) fireEvent.click(typeInstead);
  fireEvent.change(await screen.findByLabelText("你讲的内容"), { target: { value: text } });
  fireEvent.click(screen.getByRole("button", { name: "对照课程看看" }));
}

describe("FeynmanDialog", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    mockIpc.feynman.attempts.mockResolvedValue([]);
    mockIpc.feynman.evaluate.mockResolvedValue(attempt());
    mockIpc.srs.addCard.mockResolvedValue("c1");
  });

  it("打开对话框先请求暂停播放：不能把正在讲的课录进麦克风", () => {
    const before = usePlayer.getState().pauseRequest;
    renderDialog();
    expect(usePlayer.getState().pauseRequest).toBe(before + 1);
  });

  it("没提交就关掉对话框：讲稿按话题留着，再打开还在", async () => {
    const first = renderDialog();
    fireEvent.change(await screen.findByLabelText("你讲的内容"), {
      target: { value: "我理解的梯度下降是每次沿着负梯度走一小步" },
    });
    first.unmount();

    renderDialog();
    expect(await screen.findByLabelText("你讲的内容")).toHaveValue(
      "我理解的梯度下降是每次沿着负梯度走一小步",
    );
  });

  it("打字讲一遍 → 看到覆盖率、讲错与漏掉的点，点回看跳到原片", async () => {
    const handlers = renderDialog();
    await explain("沿负梯度走。学习率越大越好。");
    expect(mockIpc.feynman.evaluate).toHaveBeenCalledWith({ kind: "concept", concept_id: "k1" }, "沿负梯度走。学习率越大越好。");
    expect(await screen.findByText("讲到 1 / 2 个要点")).toBeInTheDocument();
    expect(screen.getByText("漏了：学习率过大会震荡")).toBeInTheDocument();
    expect(screen.getByText("过大会震荡甚至发散")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "回看 07:10" }));
    expect(handlers.onOpenAt).toHaveBeenCalledWith("v3", 427_000);
  });

  it("漏掉的点做成复习卡；讲错的交给引导模式", async () => {
    const handlers = renderDialog();
    await explain("沿负梯度走。学习率越大越好。");
    fireEvent.click(await screen.findByRole("button", { name: "漏掉的 1 点做成复习卡" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "已加入 1 张复习卡" })).toBeInTheDocument());
    expect(mockIpc.srs.addCard).toHaveBeenCalledWith("v3", "feynman", "用自己的话讲讲：学习率过大会震荡", "学习率过大会震荡", 430_000);
    fireEvent.click(screen.getByRole("button", { name: "讲错的地方引导我改" }));
    expect(handlers.onGuide).toHaveBeenCalledWith(expect.stringContaining("学习率越大越好"));
  });

  it("重新打开时展示上次保存的结果，而不是回到录音界面", async () => {
    mockIpc.feynman.attempts.mockResolvedValue([attempt()]);
    const first = renderDialog();
    expect(await screen.findByText("讲到 1 / 2 个要点")).toBeInTheDocument();
    first.unmount();

    renderDialog();
    // 结果来自 feynman_attempts，不需要重新评估；「再讲一遍」仍能开始新的一次。
    expect(await screen.findByText("讲到 1 / 2 个要点")).toBeInTheDocument();
    expect(screen.getByText("漏了：学习率过大会震荡")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "再讲一遍" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "开始录音" })).not.toBeInTheDocument();
  });

  it("有未提交草稿时优先回到草稿，而不是旧结果", async () => {
    mockIpc.feynman.attempts.mockResolvedValue([attempt()]);
    localStorage.setItem("course-ai-feynman-draft:concept:k1", "这份还没提交");

    renderDialog();
    expect(await screen.findByLabelText("你讲的内容")).toHaveValue("这份还没提交");
    expect(screen.queryByText("讲到 1 / 2 个要点")).not.toBeInTheDocument();
  });

  it("再讲一遍：数出这次补上了上次漏掉的几点", async () => {
    renderDialog();
    await explain("第一次讲解");
    await screen.findByText("讲到 1 / 2 个要点");
    mockIpc.feynman.evaluate.mockResolvedValue(
      attempt({ covered: [{ point: "学习率太大时会来回震荡", quote: "" }], missed: [], wrong: [] }, "第二次"),
    );
    fireEvent.click(screen.getByRole("button", { name: "再讲一遍" }));
    await explain("第二次讲解");
    expect(await screen.findByText("这次补上了上次漏掉的 1 点")).toBeInTheDocument();
    expect(screen.getByText("讲得很完整，没有漏也没有错。")).toBeInTheDocument();
  });
});
