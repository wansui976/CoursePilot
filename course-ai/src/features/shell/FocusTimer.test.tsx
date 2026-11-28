import "@testing-library/jest-dom/vitest";
import i18n from "@/i18n";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { localDay, useFocusTimer } from "@/stores/focusTimer";
import { FocusTimerButton } from "./FocusTimer";
import { useFocusTicker } from "./useFocusTicker";

const { notify } = vi.hoisted(() => ({ notify: vi.fn(() => Promise.resolve()) }));
vi.mock("@/lib/ipc", () => ({ ipc: { notify } }));
vi.mock("@/lib/feedback", () => ({ playSound: vi.fn() }));

function Harness() {
  useFocusTicker();
  return <FocusTimerButton variant="sidebar" />;
}

beforeEach(async () => {
  await i18n.changeLanguage("zh-CN");
  localStorage.clear();
  useFocusTimer.setState({
    phase: "idle",
    endsAt: 0,
    focusMinutes: 25,
    breakMinutes: 5,
    autoBreak: true,
    doneToday: { day: localDay(), count: 0, minutes: 0 },
    lastTransition: null,
  });
});

afterEach(() => vi.useRealTimers());

describe("FocusTimerButton", () => {
  it("starts a focus block from the menu and shows the time left", () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "专注计时" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "开始专注 25 分钟" }));
    expect(useFocusTimer.getState().phase).toBe("focus");
    expect(screen.getByRole("button", { name: /专注中，还剩 2[45]:\d\d/ })).toBeInTheDocument();
  });

  it("changes the focus length", () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "专注计时" }));
    fireEvent.click(screen.getByRole("menuitemradio", { name: "45" }));
    expect(useFocusTimer.getState().focusMinutes).toBe(45);
    expect(screen.getByRole("menuitem", { name: "开始专注 45 分钟" })).toBeInTheDocument();
  });

  it("notifies when a block ends", () => {
    vi.useFakeTimers();
    const now = Date.now();
    useFocusTimer.setState({ phase: "focus", endsAt: now + 1500 });
    render(<Harness />);
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(useFocusTimer.getState().phase).toBe("break");
    expect(notify).toHaveBeenCalledWith("专注结束", expect.stringContaining("休息 5 分钟"));
  });
});
