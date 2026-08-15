import "@testing-library/jest-dom/vitest";
import "@/i18n";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { AssistantToolChips } from "./AssistantToolChips";

describe("AssistantToolChips", () => {
  it("shows resume learning in user-facing language", () => {
    render(<AssistantToolChips tools={["resume_learning"]} />);
    const chips = screen.getByTestId("tool-chips");
    expect(chips).toHaveTextContent("继续上次学习");
    expect(chips).not.toHaveTextContent("resume_learning");
  });

  it("shows weak-concept analysis without exposing the function name", () => {
    render(<AssistantToolChips tools={["list_weak_concepts"]} />);
    const chips = screen.getByTestId("tool-chips");
    expect(chips).toHaveTextContent("查看薄弱知识点");
    expect(chips).not.toHaveTextContent("list_weak_concepts");
  });

  it("shows the generated course outline in user-facing language", () => {
    render(<AssistantToolChips tools={["get_course_outline"]} />);
    const chips = screen.getByTestId("tool-chips");
    expect(chips).toHaveTextContent("读取课程知识结构");
    expect(chips).not.toHaveTextContent("get_course_outline");
  });

  it("shows each tool outcome in text and does not merge opposite outcomes", () => {
    render(
      <AssistantToolChips
        tools={["search_content", "search_content"]}
        toolRuns={[
          { callId: "one", name: "search_content", status: "completed" },
          { callId: "two", name: "search_content", status: "failed" },
        ]}
      />,
    );

    expect(screen.getByRole("list", { name: "工具调用记录" })).toBeInTheDocument();
    expect(screen.getByRole("listitem", { name: "搜索课程内容，已完成" })).toBeInTheDocument();
    expect(screen.getByRole("listitem", { name: "搜索课程内容，失败" })).toBeInTheDocument();
    expect(screen.queryByText("×2")).not.toBeInTheDocument();
  });

  it("collapses only adjacent calls with the same tool and status", () => {
    render(
      <AssistantToolChips
        tools={[]}
        toolRuns={[
          { callId: "one", name: "search_bilibili", status: "completed" },
          { callId: "two", name: "search_bilibili", status: "completed" },
          { callId: "three", name: "search_bilibili", status: "canceled" },
        ]}
      />,
    );

    expect(
      screen.getByRole("listitem", { name: "搜索 B 站，已完成，2 次" }),
    ).toHaveTextContent("×2");
    expect(screen.getByRole("listitem", { name: "搜索 B 站，已停止" })).toBeInTheDocument();
  });

  it("uses a neutral finished state for legacy records", () => {
    render(<AssistantToolChips tools={["list_videos"]} />);
    expect(screen.getByRole("listitem", { name: "查看视频列表，已结束" })).toBeInTheDocument();
  });

  it("fills partially restored tool runs without changing the final call order", () => {
    render(
      <AssistantToolChips
        tools={["list_courses", "list_videos", "search_content"]}
        toolRuns={[{ callId: "video", name: "list_videos", status: "failed" }]}
      />,
    );

    const items = screen.getAllByRole("listitem");
    expect(items.map((item) => item.getAttribute("aria-label"))).toEqual([
      "查看课程，已结束",
      "查看视频列表，失败",
      "搜索课程内容，已结束",
    ]);
    for (const item of items) {
      expect(item).toHaveClass("text-[var(--text-strong)]");
    }
  });
});
