import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { BottomTabBar } from "./BottomTabBar";

describe("BottomTabBar", () => {
  it("renders the three tabs and marks the active one", () => {
    render(<BottomTabBar active="courses" onSelect={() => undefined} />);
    expect(screen.getByRole("button", { name: "课程" })).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("button", { name: "队列" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "设置" })).toBeInTheDocument();
  });

  it("calls onSelect with the tapped tab key", () => {
    const onSelect = vi.fn();
    render(<BottomTabBar active="courses" onSelect={onSelect} />);
    fireEvent.click(screen.getByRole("button", { name: "设置" }));
    expect(onSelect).toHaveBeenCalledWith("settings");
  });

  it("shows a queue badge when queueCount > 0", () => {
    render(<BottomTabBar active="courses" queueCount={3} onSelect={() => undefined} />);
    expect(screen.getByText("3")).toBeInTheDocument();
  });
});
