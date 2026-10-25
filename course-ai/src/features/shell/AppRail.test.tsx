import "@testing-library/jest-dom/vitest";
import "@/i18n";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppRail } from "./AppRail";
import type { ShellNav } from "./shellNav";
import { makeNav } from "./testNav";

const { mockSetThemeToggleOrigin } = vi.hoisted(() => ({
  mockSetThemeToggleOrigin: vi.fn(),
}));
vi.mock("@/stores/theme", async () => {
  const actual = await vi.importActual<typeof import("@/stores/theme")>("@/stores/theme");
  return {
    ...actual,
    setThemeToggleOrigin: mockSetThemeToggleOrigin,
  };
});

function renderRail(overrides: Partial<ShellNav> = {}, onExpandSidebar = vi.fn()) {
  const nav = makeNav(overrides);
  render(<AppRail nav={nav} onExpandSidebar={onExpandSidebar} />);
  return { nav, onExpandSidebar };
}

describe("AppRail (collapsed sidebar)", () => {
  beforeEach(() => {
    mockSetThemeToggleOrigin.mockReset();
  });

  it("renders the toolbar navigation with all global entries", () => {
    renderRail();
    expect(screen.getByRole("navigation", { name: "工具栏" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "学习面板" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "切换助手" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "回收站" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "设置" })).toBeInTheDocument();
  });

  it("always offers to expand the sidebar again", () => {
    const { onExpandSidebar } = renderRail();
    fireEvent.click(screen.getByRole("button", { name: "展开侧栏" }));
    expect(onExpandSidebar).toHaveBeenCalledTimes(1);
  });

  it("library view: the library entry goes to the course hub and marks it current", () => {
    const { nav } = renderRail({ view: "library", libraryHomeActive: true });
    const library = screen.getByRole("button", { name: "回到课程库首页" });
    expect(library).toHaveClass("active");
    fireEvent.click(library);
    expect(nav.onGoLibraryHome).toHaveBeenCalledTimes(1);
  });

  it("workbench view: the library entry goes back to the library", () => {
    const { nav } = renderRail({ view: "workbench" });
    fireEvent.click(screen.getByRole("button", { name: "返回课程库" }));
    expect(nav.onBackToLibrary).toHaveBeenCalledTimes(1);
  });

  it("shows the queue entry with badge only in the library view", () => {
    renderRail({ view: "library", queueCount: 3, queueOpen: true });
    const queue = screen.getByRole("button", { name: "处理队列" });
    expect(queue).toHaveClass("active");
    expect(screen.getByText("3")).toBeInTheDocument();
  });

  it("hides the queue entry in the workbench view", () => {
    renderRail({ view: "workbench" });
    expect(screen.queryByRole("button", { name: "处理队列" })).not.toBeInTheDocument();
  });

  it("marks the open page among dashboard, settings and recycle bin", () => {
    renderRail({ dashboardOpen: true });
    expect(screen.getByRole("button", { name: "学习面板" })).toHaveClass("active");
    expect(screen.getByRole("button", { name: "设置" })).not.toHaveClass("active");
  });

  it("reflects assistant active state and toggles it", () => {
    const { nav } = renderRail({ assistantActive: true });
    const btn = screen.getByRole("button", { name: "切换助手" });
    expect(btn).toHaveClass("active");
    fireEvent.click(btn);
    expect(nav.onToggleAssistant).toHaveBeenCalledTimes(1);
  });

  it("records the theme toggle origin from the rail button center", () => {
    const { nav } = renderRail();
    const button = screen.getByRole("button", { name: "切换到夜晚模式" });
    const rect = { left: 6, top: 400, width: 44, height: 44, right: 50, bottom: 444, x: 6, y: 400, toJSON: () => ({}) };
    vi.spyOn(button, "getBoundingClientRect").mockReturnValue(rect as DOMRect);
    fireEvent.click(button);
    expect(mockSetThemeToggleOrigin).toHaveBeenCalledWith(28, 422);
    expect(nav.onToggleTheme).toHaveBeenCalledTimes(1);
  });
});
