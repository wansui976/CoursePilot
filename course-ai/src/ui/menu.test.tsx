import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ShellContext, type Shell } from "@/app/shell";
import { Menu, MenuItem } from "./menu";

const phoneShell = { isPhoneDevice: true } as unknown as Shell;

describe("Menu 在手机上呈现为底部弹层", () => {
  it("挂到 body，点菜单项不会触发调用方的「点外面收起」", () => {
    const outside = vi.fn();
    document.addEventListener("pointerdown", outside);
    const onPick = vi.fn();
    render(
      <ShellContext.Provider value={phoneShell}>
        <div data-testid="host">
          <Menu aria-label="操作" onClose={vi.fn()}>
            <MenuItem onClick={onPick}>改名</MenuItem>
          </Menu>
        </div>
      </ShellContext.Provider>,
    );
    const menu = screen.getByRole("menu", { name: "操作" });
    expect(menu).toHaveAttribute("data-sheet");
    expect(screen.getByTestId("host")).not.toContainElement(menu);
    const item = screen.getByRole("menuitem", { name: "改名" });
    fireEvent.pointerDown(item);
    fireEvent.click(item);
    expect(outside).not.toHaveBeenCalled();
    expect(onPick).toHaveBeenCalled();
    document.removeEventListener("pointerdown", outside);
  });

  it("点遮罩关闭", () => {
    const onClose = vi.fn();
    render(
      <ShellContext.Provider value={phoneShell}>
        <Menu aria-label="操作" onClose={onClose}>
          <MenuItem>改名</MenuItem>
        </Menu>
      </ShellContext.Provider>,
    );
    fireEvent.click(document.querySelector(".ca-menu-scrim")!);
    expect(onClose).toHaveBeenCalled();
  });

  it("桌面（不在叠放布局）保持原样的就地下拉", () => {
    render(
      <div data-testid="host">
        <Menu aria-label="操作" className="absolute">
          <MenuItem>改名</MenuItem>
        </Menu>
      </div>,
    );
    const menu = screen.getByRole("menu", { name: "操作" });
    expect(menu).not.toHaveAttribute("data-sheet");
    expect(screen.getByTestId("host")).toContainElement(menu);
    expect(menu).toHaveClass("absolute");
  });
});
