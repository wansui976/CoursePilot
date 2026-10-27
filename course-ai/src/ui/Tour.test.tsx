import "@/i18n";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { useTours } from "@/stores/tours";
import { Tour, type TourStep } from "./Tour";

/** jsdom 里元素都没有尺寸：给锚点一个看得见的矩形。 */
function Anchor({ name, x = 100 }: { name: string; x?: number }) {
  return (
    <button
      type="button"
      data-tour={name}
      ref={(el) => {
        if (el) {
          el.getBoundingClientRect = () =>
            ({ left: x, top: 100, right: x + 80, bottom: 130, width: 80, height: 30, x, y: 100 }) as DOMRect;
        }
      }}
    >
      {name}
    </button>
  );
}

const STEPS: TourStep[] = [
  { anchor: "a", title: "第一步", body: "说明一" },
  { anchor: "missing", title: "不在的步骤", body: "这步的锚点不在页面上" },
  { anchor: "b", title: "第二步", body: "说明二" },
];

describe("Tour", () => {
  beforeEach(() => {
    localStorage.clear();
    useTours.setState({ seen: new Set(), active: null });
  });

  it("walks through the steps whose anchors are on screen, then remembers it was seen", async () => {
    render(
      <>
        <Anchor name="a" />
        <Anchor name="b" x={300} />
        <Tour id="library" steps={STEPS} delay={0} />
      </>,
    );

    const dialog = await screen.findByRole("dialog", { name: "第一步" });
    expect(dialog).toHaveTextContent("说明一");
    // 锚点不在的那步不算：一共 2 步
    expect(dialog).toHaveTextContent("1 / 2");
    expect(screen.getByRole("button", { name: "下一步" })).toHaveFocus();

    fireEvent.click(screen.getByRole("button", { name: "下一步" }));
    expect(await screen.findByRole("dialog", { name: "第二步" })).toHaveTextContent("2 / 2");

    fireEvent.click(screen.getByRole("button", { name: "知道了" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(useTours.getState().seen.has("library")).toBe(true);
    expect(JSON.parse(localStorage.getItem("course-ai-tours-seen") ?? "[]")).toEqual(["library"]);
  });

  it("closes for good from the × button or Esc", async () => {
    const { unmount } = render(
      <>
        <Anchor name="a" />
        <Tour id="library" steps={STEPS} delay={0} />
      </>,
    );
    await screen.findByRole("dialog", { name: "第一步" });
    fireEvent.click(screen.getByRole("button", { name: "关闭引导" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(useTours.getState().seen.has("library")).toBe(true);
    unmount();

    render(
      <>
        <Anchor name="a" />
        <Tour id="workbench" steps={STEPS} delay={0} />
      </>,
    );
    await screen.findByRole("dialog", { name: "第一步" });
    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(useTours.getState().seen.has("workbench")).toBe(true);
  });

  it("stays hidden when already seen or not enabled", async () => {
    useTours.setState({ seen: new Set(["library"]), active: null });
    render(
      <>
        <Anchor name="a" />
        <Tour id="library" steps={STEPS} delay={0} />
        <Tour id="course" steps={STEPS} delay={0} enabled={false} />
      </>,
    );
    await act(() => new Promise((resolve) => setTimeout(resolve, 400)));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("shows one tour at a time", async () => {
    render(
      <>
        <Anchor name="a" />
        <Tour id="library" steps={[STEPS[0]]} delay={0} />
        <Tour id="course" steps={[{ anchor: "a", title: "另一组", body: "…" }]} delay={0} />
      </>,
    );
    await screen.findByRole("dialog", { name: "第一步" });
    await act(() => new Promise((resolve) => setTimeout(resolve, 400)));
    expect(screen.getAllByRole("dialog")).toHaveLength(1);

    // 前一组看完，下一组才轮到
    fireEvent.click(screen.getByRole("button", { name: "知道了" }));
    expect(await screen.findByRole("dialog", { name: "另一组" })).toBeInTheDocument();
  });

  it("skips a step when its anchor goes away", async () => {
    function Page({ showB }: { showB: boolean }) {
      return (
        <>
          <Anchor name="a" />
          {showB && <Anchor name="b" x={300} />}
          <Tour
            id="library"
            delay={0}
            steps={[
              { anchor: "b", title: "会消失的一步", body: "…" },
              { anchor: "a", title: "留下的一步", body: "…" },
            ]}
          />
        </>
      );
    }
    const { rerender } = render(<Page showB />);
    await screen.findByRole("dialog", { name: "会消失的一步" });
    rerender(<Page showB={false} />);
    expect(await screen.findByRole("dialog", { name: "留下的一步" })).toHaveTextContent("2 / 2");
  });
});
