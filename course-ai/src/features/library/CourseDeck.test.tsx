import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import "@/i18n";
import type { Course, VideoListItem } from "@/lib/types";
import { CourseDeck, type DeckCourse } from "./CourseDeck";

function course(id: string, name: string): Course {
  return {
    id,
    name,
    root_path: "",
    cover_image: null,
    created_at: 0,
    updated_at: 0,
    video_count: 3,
    sort_order: 0,
    color: "green",
  } as Course;
}

const video = { id: "v1", title: "第 2 讲 对角化" } as VideoListItem;
const items: DeckCourse[] = ["线性代数", "宏观经济学", "日语 N3 语法", "数据结构", "心理学"].map((name, i) => ({
  course: course(`c${i}`, name),
  videos: [video],
  watched: 0,
  next: video,
}));

describe("CourseDeck", () => {
  it("stacks courses by depth and shows the front course's details", () => {
    render(<CourseDeck items={items} front={0} onFrontChange={vi.fn()} onOpenCourse={vi.fn()} onContinue={vi.fn()} />);
    const options = screen.getAllByRole("option");
    expect(options.map((o) => o.getAttribute("data-depth"))).toEqual(["0", "1", "2", "3", "4"]);
    expect(screen.getByRole("heading", { name: "线性代数" })).toBeInTheDocument();
  });

  it("brings a peeking card to the front when clicked, and opens the front one", () => {
    const onFrontChange = vi.fn();
    const onOpenCourse = vi.fn();
    render(
      <CourseDeck items={items} front={0} onFrontChange={onFrontChange} onOpenCourse={onOpenCourse} onContinue={vi.fn()} />,
    );
    fireEvent.click(screen.getByRole("option", { name: "日语 N3 语法" }));
    expect(onFrontChange).toHaveBeenCalledWith(2);
    fireEvent.click(screen.getByRole("option", { name: "线性代数" }));
    expect(onOpenCourse).toHaveBeenCalledWith("c0");
  });

  it("flips with the arrow keys, wrapping around", () => {
    const onFrontChange = vi.fn();
    render(<CourseDeck items={items} front={0} onFrontChange={onFrontChange} onOpenCourse={vi.fn()} onContinue={vi.fn()} />);
    const stack = screen.getByRole("listbox");
    fireEvent.keyDown(stack, { key: "ArrowLeft" });
    expect(onFrontChange).toHaveBeenLastCalledWith(4);
    fireEvent.keyDown(stack, { key: "ArrowRight" });
    expect(onFrontChange).toHaveBeenLastCalledWith(1);
  });

  it("continues the front course at its next lecture", () => {
    const onContinue = vi.fn();
    render(<CourseDeck items={items} front={0} onFrontChange={vi.fn()} onOpenCourse={vi.fn()} onContinue={onContinue} />);
    fireEvent.click(screen.getByRole("button", { name: /继续学习/ }));
    expect(onContinue).toHaveBeenCalledWith("c0", "v1");
  });
});
