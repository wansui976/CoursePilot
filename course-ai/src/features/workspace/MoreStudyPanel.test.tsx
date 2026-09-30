import "@testing-library/jest-dom/vitest";
import "@/i18n";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { MoreStudyPanel } from "./MoreStudyPanel";

vi.mock("./QuizPanel", () => ({
  QuizPanel: () => <div>练习内容</div>,
}));
vi.mock("./SlidesPanel", () => ({
  SlidesPanel: () => <div>课件内容</div>,
}));
vi.mock("./MindmapPanel", () => ({
  MindmapPanel: () => <div>脑图内容</div>,
}));
vi.mock("./ClipsPanel", () => ({
  ClipsPanel: () => <div>片段内容</div>,
}));
vi.mock("./RagSearchPanel", () => ({
  RagSearchPanel: ({ mode }: { mode: string }) => <div>搜索内容 {mode}</div>,
}));

describe("MoreStudyPanel", () => {
  it("groups low-frequency study tools behind one compact selector", async () => {
    render(<MoreStudyPanel videoId="video-1" />);

    const group = screen.getByRole("group", { name: "更多学习资料" });
    expect(group).toBeInTheDocument();
    // 练习从一级 tab 并入更多后是这里的默认视图。
    expect(screen.getByRole("button", { name: "练习" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(await screen.findByText("练习内容")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "课件" }));
    expect(await screen.findByText("课件内容")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "脑图" }));
    expect(await screen.findByText("脑图内容")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "片段" }));
    expect(await screen.findByText("片段内容")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "搜索" }));
    expect(await screen.findByText("搜索内容 search")).toBeInTheDocument();
  });

  it("opens directly on the given initial view (legacy quiz tab migration)", async () => {
    render(<MoreStudyPanel videoId="video-1" initialView="slides" />);

    expect(screen.getByRole("button", { name: "课件" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(await screen.findByText("课件内容")).toBeInTheDocument();
  });
});
