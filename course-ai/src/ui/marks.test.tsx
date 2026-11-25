import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { formatClock, Kbd, Mark, Tag, Timestamp } from "./marks";

describe("formatClock", () => {
  it("formats minutes and seconds, padding both", () => {
    expect(formatClock(0)).toBe("00:00");
    expect(formatClock(65_000)).toBe("01:05");
    expect(formatClock(24 * 60_000 + 5_000)).toBe("24:05");
  });

  it("adds hours for long lectures and never goes negative", () => {
    expect(formatClock(3_862_000)).toBe("01:04:22"); // 和进度条一致
    expect(formatClock(-5)).toBe("00:00");
  });
});

describe("Timestamp", () => {
  it("is a button that seeks to its moment", () => {
    const onSeek = vi.fn();
    render(<Timestamp ms={1_445_000} onSeek={onSeek} />);
    fireEvent.click(screen.getByRole("button", { name: /24:05/ }));
    expect(onSeek).toHaveBeenCalledWith(1_445_000);
  });

  it("is plain text without a handler", () => {
    render(<Timestamp ms={190_000} />);
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.getByText("03:10")).toBeTruthy();
  });
});

describe("Mark, Kbd and Tag", () => {
  it("render their content with the design classes", () => {
    render(
      <div>
        <Mark>重点</Mark>
        <Kbd>N</Kbd>
        <Tag color="green">线性代数</Tag>
      </div>,
    );
    expect(screen.getByText("重点").className).toContain("ca-mark");
    expect(screen.getByText("N").tagName).toBe("KBD");
    const tag = screen.getByText("线性代数");
    expect(tag.style.background).toBe("var(--tag-green-bg)");
  });

  it("falls back to gray when a course has no color", () => {
    render(<Tag color={null}>未分类</Tag>);
    expect(screen.getByText("未分类").style.color).toBe("var(--tag-gray-text)");
  });
});
