import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ReviewSession } from "./ReviewSession";

const { due, review } = vi.hoisted(() => ({ due: vi.fn(), review: vi.fn() }));
vi.mock("@/lib/ipc", () => ({ ipc: { srs: { due, review } } }));

const DAY = 86_400_000;
const cards = [
  {
    id: "a",
    video_id: "v1",
    course_id: "c1",
    front: "问题一",
    back: "答案一",
    source_ms: 5000,
    question_type: "single",
    options: ["答案一", "干扰项二", "干扰项三", "干扰项四"],
    correct_options: ["答案一"],
    preview_ms: [60_000, 3 * DAY, 8 * DAY, 21 * DAY],
  },
  {
    id: "b",
    video_id: null,
    course_id: null,
    front: "问题二",
    back: "答案二",
    source_ms: null,
    // 长间隔：跨到「个月」「年」这两档。
    preview_ms: [60_000, 45 * DAY, 400 * DAY, 800 * DAY],
  },
];

function deferred() {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

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

    fireEvent.click(screen.getByRole("button", { name: /选项 A/ }));
    fireEvent.click(screen.getByRole("button", { name: /提交答案/ }));
    expect(screen.getByText("回答正确")).toBeInTheDocument();

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

  it("waits for the grade write and ignores duplicate submissions", async () => {
    const pending = deferred();
    review.mockReturnValueOnce(pending.promise);
    renderSession();
    await screen.findByText("问题一");
    fireEvent.click(screen.getByRole("button", { name: /选项 A/ }));
    fireEvent.click(screen.getByRole("button", { name: /提交答案/ }));

    const grade = screen.getByRole("button", { name: /良好/ });
    fireEvent.click(grade);
    fireEvent.click(grade);

    await waitFor(() => expect(review).toHaveBeenCalledTimes(1));
    expect(screen.getByText("问题一")).toBeInTheDocument();
    expect(grade).toBeDisabled();

    pending.resolve();
    expect(await screen.findByText("问题二")).toBeInTheDocument();
  });

  it("keeps the current card visible when saving a grade fails", async () => {
    review.mockRejectedValueOnce(new Error("database locked"));
    renderSession();
    await screen.findByText("问题一");
    fireEvent.click(screen.getByRole("button", { name: /选项 A/ }));
    fireEvent.click(screen.getByRole("button", { name: /提交答案/ }));
    fireEvent.click(screen.getByRole("button", { name: /良好/ }));

    expect(await screen.findByRole("alert")).toHaveTextContent("database locked");
    expect(screen.getByText("问题一")).toBeInTheDocument();

    review.mockResolvedValueOnce(undefined);
    fireEvent.click(screen.getByRole("button", { name: /良好/ }));
    expect(await screen.findByText("问题二")).toBeInTheDocument();
  });

  it("每个评分档都写着按下去会推到多久之后", async () => {
    renderSession();
    await screen.findByText("问题一");
    fireEvent.click(screen.getByRole("button", { name: /选项 A/ }));
    fireEvent.click(screen.getByRole("button", { name: /提交答案/ }));

    // 后端给的四个间隔原样呈现，前端不另算——这四个数就是按下去会发生的事。
    expect(screen.getByRole("button", { name: /重来/ })).toHaveTextContent("1 分钟");
    expect(screen.getByRole("button", { name: /困难/ })).toHaveTextContent("3 天");
    expect(screen.getByRole("button", { name: /良好/ })).toHaveTextContent("8 天");
    expect(screen.getByRole("button", { name: /容易/ })).toHaveTextContent("21 天");
    // 读屏也要听得到后果，而不只是一个「容易」。
    expect(
      screen.getByRole("button", { name: "容易，下次复习在 21 天后" }),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /良好/ }));
    await screen.findByText("问题二");
    fireEvent.click(screen.getByRole("button", { name: /显示答案/ }));
    // 长间隔换算成月和年，40 天与 70 天不该都显示成「1 个月」。
    expect(screen.getByRole("button", { name: /困难/ })).toHaveTextContent("1.5 个月");
    expect(screen.getByRole("button", { name: /良好/ })).toHaveTextContent("1.1 年");
    expect(screen.getByRole("button", { name: /容易/ })).toHaveTextContent("2.2 年");
  });

  it("后端没给间隔时照样能打分，不会瞎写一个数字", async () => {
    due.mockResolvedValue([{ ...cards[1], preview_ms: undefined }]);
    renderSession();
    await screen.findByText("问题二");
    fireEvent.click(screen.getByRole("button", { name: /显示答案/ }));

    const good = screen.getByRole("button", { name: "良好" });
    expect(good).toHaveTextContent(/^良好3$/);
    fireEvent.click(good);
    await waitFor(() => expect(review).toHaveBeenCalledWith("b", 3));
  });

  it("offers 回看出处 for a card with a source and jumps on click", async () => {
    const onJump = vi.fn();
    renderSession(onJump);
    await screen.findByText("问题一");
    fireEvent.click(screen.getByRole("button", { name: /选项 A/ }));
    fireEvent.click(screen.getByRole("button", { name: /提交答案/ }));

    fireEvent.click(screen.getByRole("button", { name: /回看出处/ }));
    expect(onJump).toHaveBeenCalledWith(cards[0]);
  });

  it("selects an option by letter and submits with the space key", async () => {
    renderSession();
    await screen.findByText("问题一");
    fireEvent.keyDown(window, { key: "ArrowRight" });
    expect(screen.getByRole("button", { name: /选项 A/ })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    fireEvent.keyDown(window, { key: "a" });
    expect(screen.getByRole("button", { name: /选项 A/ })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    fireEvent.keyDown(window, { key: " " });
    expect(screen.getByText("回答正确")).toBeInTheDocument();
  });

  it("keeps the submit label readable and shows explicit incorrect feedback", async () => {
    renderSession();
    await screen.findByText("问题一");
    const submit = screen.getByRole("button", { name: /提交答案/ });
    // 实色强调按钮的字用 --on-accent，不继承页面文字色——否则蓝底上是深色字，看不清。
    expect(submit).toHaveClass("text-[var(--on-accent)]");
    expect(submit).toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: /选项 B/ }));
    expect(submit).toBeEnabled();
    fireEvent.click(submit);

    expect(screen.getByText("回答不正确")).toBeInTheDocument();
    expect(screen.getByText("正确答案")).toBeInTheDocument();
    expect(screen.getByText("你的选择")).toBeInTheDocument();
  });

  it("supports multiple-choice selection and leaves focused option space alone", async () => {
    due.mockResolvedValue([
      {
        id: "multi",
        video_id: "v1",
        course_id: "c1",
        front: "哪些是质数？",
        back: "2、3\n质数只能被 1 和自身整除。",
        source_ms: null,
        question_type: "multi",
        options: ["2", "3", "4", "6"],
        correct_options: ["2", "3"],
      },
    ]);
    renderSession();
    await screen.findByText("哪些是质数？");

    const first = screen.getByRole("button", { name: "选项 A：2" });
    first.focus();
    fireEvent.keyDown(first, { key: " " });
    expect(screen.queryByText("回答正确")).not.toBeInTheDocument();

    fireEvent.click(first);
    fireEvent.click(screen.getByRole("button", { name: "选项 B：3" }));
    fireEvent.click(screen.getByRole("button", { name: /提交答案/ }));
    expect(screen.getByText("回答正确")).toBeInTheDocument();
  });

  it("keeps cards without choice metadata on the original reveal flow", async () => {
    due.mockResolvedValue([cards[1]]);
    renderSession();
    await screen.findByText("问题二");
    const reveal = screen.getByRole("button", { name: /显示答案/ });
    expect(reveal).toHaveClass("text-[var(--on-accent)]");
    fireEvent.keyDown(window, { key: " " });
    expect(screen.getByText("答案二")).toBeInTheDocument();
  });

  it("shows an empty message when nothing is due", async () => {
    due.mockResolvedValue([]);
    renderSession();
    expect(
      await screen.findByText("今天没有待复习的卡片"),
    ).toBeInTheDocument();
  });

  it("shows a retry state when loading due cards fails", async () => {
    due.mockRejectedValueOnce(new Error("database unavailable")).mockResolvedValueOnce([]);
    renderSession();

    expect(await screen.findByRole("alert")).toHaveTextContent("database unavailable");
    expect(screen.queryByText("今天没有待复习的卡片")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    expect(await screen.findByText("今天没有待复习的卡片")).toBeInTheDocument();
    expect(due).toHaveBeenCalledTimes(2);
  });
});
