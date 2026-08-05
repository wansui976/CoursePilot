import "@testing-library/jest-dom/vitest";
import "@/i18n";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TabsPanel } from "./TabsPanel";

vi.mock("./AiViewPanel", () => ({
  AiViewPanel: () => <div>概览内容</div>,
}));
vi.mock("./NotesPanel", () => ({
  NotesPanel: () => <div>笔记内容</div>,
}));
const transcriptPanel = vi.fn(() => <div>文稿内容</div>);
vi.mock("./TranscriptPanel", () => ({
  TranscriptPanel: () => transcriptPanel(),
}));
vi.mock("./QuizPanel", () => ({
  QuizPanel: () => <div>练习内容</div>,
}));
vi.mock("./MoreStudyPanel", () => ({
  MoreStudyPanel: () => <div>更多内容</div>,
}));

describe("TabsPanel", () => {
  beforeEach(() => {
    localStorage.clear();
    transcriptPanel.mockClear();
  });

  it("exposes the flattened primary learning tasks", async () => {
    render(<TabsPanel videoId="video-1" />);
    await screen.findByText("概览内容");
    expect(screen.getAllByRole("tab").map((tab) => tab.textContent)).toEqual(
      ["概览", "文稿", "笔记", "练习", "更多"],
    );
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

  it("loads the next video's active tab and drops panels visited by the previous video", async () => {
    localStorage.setItem(
      "course-ai-resume:video-1",
      JSON.stringify({ activeTab: "transcript" }),
    );
    localStorage.setItem(
      "course-ai-resume:video-2",
      JSON.stringify({ activeTab: "notes" }),
    );
    const { rerender } = render(<TabsPanel videoId="video-1" />);

    expect(screen.getByRole("tab", { name: "文稿" })).toHaveAttribute(
      "data-state",
      "active",
    );
    expect(await screen.findByText("文稿内容")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("tab", { name: "更多" }));
    expect(await screen.findByText("更多内容")).toBeInTheDocument();

    rerender(<TabsPanel videoId="video-2" />);

    expect(screen.getByRole("tab", { name: "笔记" })).toHaveAttribute(
      "data-state",
      "active",
    );
    expect(await screen.findByText("笔记内容")).toBeInTheDocument();
    expect(screen.queryByText("文稿内容")).not.toBeInTheDocument();
    expect(screen.queryByText("更多内容")).not.toBeInTheDocument();
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
