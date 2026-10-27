import "@/i18n";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
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

  it("runs onNext before moving on and waits for an anchor on the page it navigated to", async () => {
    function Flow() {
      const [page, setPage] = useState<"home" | "settings">("home");
      return (
        <>
          {page === "home" ? <Anchor name="settings" /> : <Anchor name="llm" x={400} />}
          <Tour
            id="library"
            delay={0}
            steps={[
              { anchor: "settings", title: "去设置", body: "…", onNext: () => setTimeout(() => setPage("settings"), 800) },
              { anchor: "llm", awaitAnchor: true, title: "配大模型", items: ["注册", "新增", "保存"] },
            ]}
          />
        </>
      );
    }
    render(<Flow />);
    // 第二步的锚点开场时不在，但它是跳转后才出现的，也算一步
    expect(await screen.findByRole("dialog", { name: "去设置" })).toHaveTextContent("1 / 2");
    fireEvent.click(screen.getByRole("button", { name: "下一步" }));
    // 新页面 0.8 秒后才渲染出锚点：不能当成「锚点没了」跳过
    const next = await screen.findByRole("dialog", { name: "配大模型" });
    expect(next).toHaveTextContent("2 / 2");
    expect(screen.getAllByRole("listitem").map((li) => li.textContent)).toEqual(["注册", "新增", "保存"]);
  });

  it("hides while its anchor is scrolled off screen instead of skipping the step", async () => {
    let top = 100;
    render(
      <>
        <button
          type="button"
          data-tour="far"
          ref={(el) => {
            if (el) {
              el.getBoundingClientRect = () =>
                ({ left: 100, top, right: 180, bottom: top + 30, width: 80, height: 30, x: 100, y: top }) as DOMRect;
            }
          }}
        >
          far
        </button>
        <Tour id="library" delay={0} steps={[STEPS[0], { anchor: "far", title: "填表这步", body: "…" }]} />
        <Anchor name="a" />
      </>,
    );
    await screen.findByRole("dialog", { name: "第一步" });
    fireEvent.click(screen.getByRole("button", { name: "下一步" }));
    await screen.findByRole("dialog", { name: "填表这步" });
    // 往下滚：锚点跑到屏幕上方外面
    top = -500;
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    await act(() => new Promise((resolve) => setTimeout(resolve, 900)));
    expect(useTours.getState().seen.has("library")).toBe(false);
    // 滚回来：还是这一步
    top = 100;
    expect(await screen.findByRole("dialog", { name: "填表这步" })).toBeInTheDocument();
  });

  it("runs the skipped step's onNext before moving on", async () => {
    const onNext = vi.fn();
    function Page({ showB }: { showB: boolean }) {
      return (
        <>
          <Anchor name="a" />
          {showB && <Anchor name="b" x={300} />}
          <Tour
            id="library"
            delay={0}
            steps={[
              { anchor: "b", title: "会消失的一步", onNext },
              { anchor: "a", title: "留下的一步" },
            ]}
          />
        </>
      );
    }
    const { rerender } = render(<Page showB />);
    await screen.findByRole("dialog", { name: "会消失的一步" });
    rerender(<Page showB={false} />);
    expect(await screen.findByRole("dialog", { name: "留下的一步" })).toBeInTheDocument();
    // 锚点消失不等于这一步的跳转可以不做：否则下一步会停在错误的页面上。
    expect(onNext).toHaveBeenCalledTimes(1);
  });

  it("goes back for a retry when a jump target never appears instead of marking the tour seen", async () => {
    render(
      <>
        <Anchor name="a" />
        <Tour
          id="library"
          delay={0}
          awaitMs={50}
          steps={[
            // 模拟「离开设置被未保存提示拦下」：onNext 什么都没跳。
            { anchor: "a", title: "第一步", onNext: () => undefined },
            { anchor: "b", awaitAnchor: true, title: "第二步" },
            { anchor: "c", awaitAnchor: true, title: "第三步" },
          ]}
        />
      </>,
    );
    await screen.findByRole("dialog", { name: "第一步" });
    fireEvent.click(screen.getByRole("button", { name: "下一步" }));

    // 目标页没出现：退回上一步，让用户处理未保存提示后重试，而不是把后续步骤全跳过。
    expect(await screen.findByRole("dialog", { name: "第一步" })).toBeInTheDocument();
    await act(() => new Promise((resolve) => setTimeout(resolve, 150)));
    expect(useTours.getState().seen.has("library")).toBe(false);
    expect(useTours.getState().active).toBe("library");
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
