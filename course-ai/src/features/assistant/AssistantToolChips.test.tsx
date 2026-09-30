import "@testing-library/jest-dom/vitest";
import "@/i18n";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { AssistantToolChips } from "./AssistantToolChips";

/** 多个工具时默认折叠成一行计数，先展开再断言明细。 */
function expandSummary(count: number) {
  fireEvent.click(screen.getByRole("button", { name: `使用了 ${count} 个工具` }));
}

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

  it("collapses several calls into one summary line until expanded", () => {
    render(
      <AssistantToolChips
        tools={["search_content", "search_content"]}
        toolRuns={[
          { callId: "one", name: "search_content", status: "completed" },
          { callId: "two", name: "search_content", status: "failed" },
        ]}
      />,
    );

    // 默认只留一行灰色计数，明细收起来。
    expect(screen.queryByRole("list", { name: "工具调用记录" })).not.toBeInTheDocument();
    expandSummary(2);

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

    expandSummary(3);
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

    expandSummary(3);
    const items = screen.getAllByRole("listitem");
    expect(items.map((item) => item.getAttribute("aria-label"))).toEqual([
      "查看课程，已结束",
      "查看视频列表，失败",
      "搜索课程内容，已结束",
    ]);
    // 状态降噪：只有失败/停止借用状态色，其余保持中性。
    expect(items[1]).toHaveClass("text-[var(--status-err)]");
    expect(items[0]).toHaveClass("text-[var(--text-muted)]");
    expect(items[2]).toHaveClass("text-[var(--text-muted)]");
  });

  it("shows the running tool on the collapsed summary line", () => {
    render(
      <AssistantToolChips
        tools={["search_content", "list_videos"]}
        toolRuns={[
          { callId: "one", name: "search_content", status: "completed" },
          { callId: "two", name: "list_videos", status: "running" },
        ]}
      />,
    );

    expect(screen.getByRole("button", { name: "正在查看视频列表…" })).toBeInTheDocument();
    expect(screen.queryByText("查看课程")).not.toBeInTheDocument();
  });
});
