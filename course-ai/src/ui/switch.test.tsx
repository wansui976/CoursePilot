import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { Switch } from "./switch";

describe("Switch", () => {
  it("keeps the pill size and leaves the 44px touch target to CSS", () => {
    const onCheckedChange = vi.fn();

    render(<Switch aria-label="测试开关" checked={false} onCheckedChange={onCheckedChange} />);

    const toggle = screen.getByRole("switch", { name: "测试开关" });
    // 药丸的视觉尺寸必须钉住：触屏上 ca-touch-44 的 min-width/min-height 会把它撑成圆形。
    expect(toggle).toHaveClass("ca-switch", "h-[22px]", "w-[38px]");
    expect(toggle).not.toHaveClass("ca-touch-44");
    expect(toggle).toHaveAttribute("aria-checked", "false");

    fireEvent.click(toggle);
    expect(onCheckedChange).toHaveBeenCalledWith(true);
  });

  it("moves the knob to the right when on", () => {
    render(<Switch aria-label="测试开关" checked onCheckedChange={() => undefined} />);

    const toggle = screen.getByRole("switch", { name: "测试开关" });
    expect(toggle).toHaveAttribute("aria-checked", "true");
    expect(toggle.firstElementChild).toHaveClass("translate-x-[19px]");
  });
});
