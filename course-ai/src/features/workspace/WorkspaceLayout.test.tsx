import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import "@/i18n";
import { readVideoResumeState, writeVideoResumeState } from "@/lib/resumeState";
import { WorkspaceLayout } from "./WorkspaceLayout";

function layout(videoId: string, availableWidth = 1400) {
  return (
    <WorkspaceLayout
      videoId={videoId}
      shellWide
      availableWidth={availableWidth}
      player={<section data-testid="player" />}
      panel={<div>panel</div>}
    />
  );
}

const separator = () => screen.getByRole("separator", { name: "调整学习资料宽度" });

describe("WorkspaceLayout", () => {
  beforeEach(() => localStorage.clear());

  it("restores the next video's layout without remounting the player", () => {
    writeVideoResumeState("a", { studyPanelWidth: 500 });
    writeVideoResumeState("b", { studyPanelWidth: 640, studyPanelCollapsed: true });
    const { rerender } = render(layout("a"));
    const player = screen.getByTestId("player");
    expect(separator()).toHaveAttribute("aria-valuenow", "500");

    rerender(layout("b"));
    expect(screen.getByTestId("player")).toBe(player);
    expect(screen.getByLabelText("学习工作台响应布局")).toHaveAttribute("data-panel-collapsed");

    rerender(layout("a"));
    expect(separator()).toHaveAttribute("aria-valuenow", "500");
  });

  it("标题行右端的开关收起 / 展开面板，展开后回到原来的宽度", () => {
    writeVideoResumeState("a", { studyPanelWidth: 560 });
    render(layout("a"));
    const wb = screen.getByLabelText("学习工作台响应布局");

    fireEvent.click(screen.getByRole("button", { name: "收起学习资料面板" }));
    expect(wb).toHaveAttribute("data-panel-collapsed");
    expect(screen.queryByRole("complementary", { name: "学习资料面板" })).not.toBeInTheDocument();
    expect(readVideoResumeState("a").studyPanelCollapsed).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "展开学习资料面板" }));
    expect(wb).not.toHaveAttribute("data-panel-collapsed");
    expect(separator()).toHaveAttribute("aria-valuenow", "560");
  });

  it("分隔线拖过最小宽度再往右一段就收起，并保留拖动前的宽度", () => {
    // 同步执行回调并返回 0：代码在回调跑完后才记下返回值当「已排一帧」，返回非 0
    // 会让后续的 pointermove 都以为上一帧还没跑而被跳过（真实浏览器里回调总在下一帧）。
    const raf = vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => {
      cb(0);
      return 0;
    });
    try {
      writeVideoResumeState("a", { studyPanelWidth: 480 });
      render(layout("a"));
      const wb = screen.getByLabelText("学习工作台响应布局");

      fireEvent.pointerDown(separator(), { clientX: 900 });
      // 480 - 150 = 330：低于最小宽度但没过收起阈值（384 - 96 = 288），只是夹在最小宽度。
      fireEvent.pointerMove(window, { clientX: 1050 });
      expect(wb).not.toHaveAttribute("data-collapse-pending");
      // 480 - 250 = 230：过了阈值，面板变淡提示松手即收起。
      fireEvent.pointerMove(window, { clientX: 1150 });
      expect(wb).toHaveAttribute("data-collapse-pending");
      fireEvent.pointerUp(window);

      expect(wb).toHaveAttribute("data-panel-collapsed");
      expect(wb).not.toHaveAttribute("data-collapse-pending");
      fireEvent.click(screen.getByRole("button", { name: "展开学习资料面板" }));
      expect(separator()).toHaveAttribute("aria-valuenow", "480");
    } finally {
      raf.mockRestore();
    }
  });

  it("专注阅读：面板占满、播放器只隐藏不卸载，收起的面板也会展开，Esc 退出", () => {
    writeVideoResumeState("a", { studyPanelCollapsed: true });
    render(layout("a"));
    const wb = screen.getByLabelText("学习工作台响应布局");
    const player = screen.getByTestId("player");

    fireEvent.click(screen.getByRole("button", { name: "专注阅读" }));
    expect(wb).toHaveAttribute("data-reading-focus");
    expect(wb).not.toHaveAttribute("data-panel-collapsed");
    expect(screen.getByRole("complementary", { name: "学习资料面板" })).toBeInTheDocument();
    expect(screen.getByTestId("player")).toBe(player);

    fireEvent.keyDown(window, { key: "Escape" });
    expect(wb).not.toHaveAttribute("data-reading-focus");
    // 退出后回到原来的收起状态。
    expect(wb).toHaveAttribute("data-panel-collapsed");
  });

  it("persists keyboard resizing per video and globally", () => {
    render(layout("a"));
    fireEvent.keyDown(separator(), { key: "ArrowLeft" });
    expect(separator()).toHaveAttribute("aria-valuenow", "504");
    expect(readVideoResumeState("a").studyPanelWidth).toBe(504);
    expect(localStorage.getItem("course-ai-study-panel-width")).toBe("504");
  });

  it("stacks and hides the resizer when the player cannot keep its minimum width", () => {
    render(layout("a", 700));
    expect(screen.getByLabelText("学习工作台响应布局")).toHaveAttribute("data-layout", "stacked");
    expect(screen.queryByRole("separator")).not.toBeInTheDocument();
  });
});
