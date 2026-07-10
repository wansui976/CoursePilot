import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { TimestampToggle } from "./TimestampToggle";
import { useTimestampPrefs } from "@/stores/timestampPrefs";

describe("TimestampToggle", () => {
  beforeEach(() => {
    localStorage.clear();
    useTimestampPrefs.setState({ showTimestamps: true });
  });

  it("labels itself for hiding while timestamps are shown, and toggles on click", () => {
    render(<TimestampToggle />);
    const btn = screen.getByRole("button", { name: "隐藏时间戳" });

    fireEvent.click(btn);

    expect(useTimestampPrefs.getState().showTimestamps).toBe(false);
    // 状态翻转后标签变为「显示时间戳」。
    expect(screen.getByRole("button", { name: "显示时间戳" })).toBeInTheDocument();
  });
});
