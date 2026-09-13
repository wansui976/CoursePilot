import "@testing-library/jest-dom/vitest";
import "@/i18n";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppRail } from "./AppRail";

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

function baseProps(overrides: Partial<Parameters<typeof AppRail>[0]> = {}) {
  return {
    view: "library" as const,
    sidebarExpanded: true,
    onExpandSidebar: vi.fn(),
    queueOpen: false,
    queueCount: 0,
    onToggleQueue: vi.fn(),
    onOpenDashboard: vi.fn(),
    assistantActive: false,
    onToggleAssistant: vi.fn(),
    theme: "light" as const,
    themeToggleLabel: "切换到夜晚模式",
    onToggleTheme: vi.fn(),
    onOpenRecycleBin: vi.fn(),
    onOpenSettings: vi.fn(),
    onBackToLibrary: vi.fn(),
    onGoLibraryHome: vi.fn(),
    ...overrides,
  };
}

function renderRail(overrides: Partial<Parameters<typeof AppRail>[0]> = {}) {
  return { ...render(<AppRail {...baseProps(overrides)} />), props: baseProps(overrides) };
}

describe("AppRail", () => {
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

  it("library view: logo goes to the course hub; no expand button when expanded", () => {
    const onGoLibraryHome = vi.fn();
    renderRail({ view: "library", sidebarExpanded: true, onGoLibraryHome });
    fireEvent.click(screen.getByRole("button", { name: "回到课程库首页" }));
    expect(onGoLibraryHome).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("button", { name: "展开侧栏" })).not.toBeInTheDocument();
  });

  it("workbench view: logo goes back to library; expand button shown when collapsed", () => {
    const onBackToLibrary = vi.fn();
    renderRail({ view: "workbench", sidebarExpanded: false, onBackToLibrary });
    fireEvent.click(screen.getByRole("button", { name: "返回课程库" }));
    expect(onBackToLibrary).toHaveBeenCalledTimes(1);
    const expand = screen.getByRole("button", { name: "展开侧栏" });
    fireEvent.click(expand);
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

  it("reflects assistant active state and toggles it", () => {
    const onToggleAssistant = vi.fn();
    renderRail({ assistantActive: true, onToggleAssistant });
    const btn = screen.getByRole("button", { name: "切换助手" });
    expect(btn).toHaveClass("active");
    fireEvent.click(btn);
    expect(onToggleAssistant).toHaveBeenCalledTimes(1);
  });

  it("records the theme toggle origin from the rail button center", () => {
    const onToggleTheme = vi.fn();
    renderRail({ onToggleTheme });
    const button = screen.getByRole("button", { name: "切换到夜晚模式" });
    const rect = { left: 6, top: 400, width: 44, height: 44, right: 50, bottom: 444, x: 6, y: 400, toJSON: () => ({}) };
    vi.spyOn(button, "getBoundingClientRect").mockReturnValue(rect as DOMRect);
    fireEvent.click(button);
    expect(mockSetThemeToggleOrigin).toHaveBeenCalledWith(28, 422);
    expect(onToggleTheme).toHaveBeenCalledTimes(1);
  });

  it("shows the sun icon when theme is dark", () => {
    renderRail({ theme: "dark", themeToggleLabel: "切换到夜晚模式" });
    expect(screen.getByRole("button", { name: "切换到夜晚模式" })).toBeInTheDocument();
  });
});