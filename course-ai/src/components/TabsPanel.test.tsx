import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TabsPanel } from "./TabsPanel";

vi.mock("./AiViewPanel", () => ({
  AiViewPanel: () => <div>AI 概览内容</div>,
}));
vi.mock("./NotesPanel", () => ({
  NotesPanel: () => <div>笔记内容</div>,
}));
const transcriptPanel = vi.fn(() => <div>文稿内容</div>);
vi.mock("./TranscriptPanel", () => ({
  TranscriptPanel: () => transcriptPanel(),
}));
vi.mock("./SlidesPanel", () => ({
  SlidesPanel: () => <div>课件内容</div>,
}));

describe("TabsPanel", () => {
  beforeEach(() => {
    localStorage.clear();
    transcriptPanel.mockClear();
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

  it("does not rerender an opened transcript when its parent updates with the same video", async () => {
    const { rerender } = render(<TabsPanel videoId="video-1" />);

    fireEvent.click(screen.getByRole("tab", { name: "文稿" }));
    await screen.findByText("文稿内容");
    expect(transcriptPanel).toHaveBeenCalledTimes(1);

    rerender(<TabsPanel videoId="video-1" />);

    await waitFor(() => expect(transcriptPanel).toHaveBeenCalledTimes(1));
  });
});
