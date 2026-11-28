import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import type { Course } from "@/lib/types";
import { CourseShelf } from "./CourseShelf";
import { spineWidth } from "@/lib/shelf";

const course = (id: string, name: string, count: number): Course =>
  ({ id, name, video_count: count, color: null }) as unknown as Course;

describe("书架", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("zh-CN");
  });

  it("讲数越多书脊越厚，但有上下限", () => {
    expect(spineWidth(1)).toBeLessThan(spineWidth(9));
    expect(spineWidth(9)).toBeLessThan(spineWidth(40));
    expect(spineWidth(0)).toBeGreaterThanOrEqual(24);
    expect(spineWidth(500)).toBeLessThanOrEqual(88);
  });

  it("每门课一本书，点了打开课程；长课程名截断成竖排省略号", () => {
    const onOpen = vi.fn();
    render(
      <CourseShelf
        courses={[course("c1", "机器学习导论", 9), course("c2", "操作系统：三个简单部分的深入理解", 12)]}
        onOpenCourse={onOpen}
      />,
    );
    const books = screen.getAllByRole("button");
    expect(books).toHaveLength(2);
    expect(books[0]).toHaveAccessibleName("打开课程「机器学习导论」（9 讲）");
    expect(books[1]).toHaveTextContent("︙");
    fireEvent.click(books[1]);
    expect(onOpen).toHaveBeenCalledWith("c2");
  });
});
