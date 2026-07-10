import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { withClickableTimestamps } from "./clickableTimestamps";

describe("withClickableTimestamps", () => {
  it("marks each timestamp chip with ca-ts-chip so it can be toggled off", () => {
    render(<div>{withClickableTimestamps("看这里 [01:23] 讲得好", vi.fn())}</div>);
    const chip = screen.getByRole("button", { name: /01:23/ });
    expect(chip).toHaveClass("ca-ts-chip");
  });
});
