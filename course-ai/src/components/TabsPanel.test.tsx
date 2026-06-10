import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TabsPanel } from "./TabsPanel";

vi.mock("./AiViewPanel", () => ({
  AiViewPanel: () => <div>AI 概览内容</div>,
}));
vi.mock("./NotesPanel", () => ({
  NotesPanel: () => <div>笔记内容</div>,
}));
vi.mock("./TranscriptPanel", () => ({
  TranscriptPanel: () => <div>文稿内容</div>,
}));
vi.mock("./SlidesPanel", () => ({
  SlidesPanel: () => <div>课件内容</div>,
}));

describe("TabsPanel", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("restores the active study tab for the video when remounted", () => {
    const { rerender } = render(<TabsPanel videoId="video-1" />);

    fireEvent.click(screen.getByRole("tab", { name: "笔记" }));

    expect(screen.getByRole("tab", { name: "笔记" })).toHaveAttribute(
      "data-state",
      "active",
    );

    rerender(<TabsPanel key="remount" videoId="video-1" />);

    expect(screen.getByRole("tab", { name: "笔记" })).toHaveAttribute(
      "data-state",
      "active",
    );
  });
});
