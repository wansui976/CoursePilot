import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
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
