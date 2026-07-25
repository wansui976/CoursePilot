import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { DailyGoalDialog } from "./DailyGoalDialog";

function renderDialog(value = 30, onSave = vi.fn()) {
  render(
    <div className="ca-app" data-testid="theme-root" data-theme="light">
      <DailyGoalDialog value={value} onSave={onSave} />
    </div>,
  );
  const trigger = screen.getByRole("button", { name: "编辑目标" });
  fireEvent.click(trigger);
  return { onSave, trigger };
}

describe("DailyGoalDialog", () => {
  it("opens an accessible dial and saves keyboard adjustments", async () => {
    const { onSave } = renderDialog();
    const dialog = screen.getByRole("dialog", { name: "设置每日目标" });
    const dial = within(dialog).getByRole("slider", { name: "每日学习目标" });
    const themeRoot = screen.getByTestId("theme-root");

    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(themeRoot).toContainElement(dialog);
    expect(dial).toHaveAttribute("aria-valuemin", "5");
    expect(dial).toHaveAttribute("aria-valuemax", "180");
    expect(dial).toHaveAttribute("aria-valuenow", "30");
    await waitFor(() => expect(dial).toHaveFocus());

    fireEvent.keyDown(dial, { key: "PageUp" });
    expect(dial).toHaveAttribute("aria-valuenow", "60");
    expect(dial).toHaveAttribute("aria-valuetext", "60 分钟");

    const save = within(dialog).getByRole("button", { name: "保存" });
    expect(save).toHaveClass("bg-[var(--accent)]", "border-[var(--accent)]");
    fireEvent.click(save);
    expect(onSave).toHaveBeenCalledWith(60);
    expect(screen.queryByRole("dialog", { name: "设置每日目标" })).not.toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "编辑目标" })).toHaveFocus(),
    );
  });

  it("updates the value while dragging around the ring", () => {
    const { onSave } = renderDialog();
    const dialog = screen.getByRole("dialog", { name: "设置每日目标" });
    const dial = within(dialog).getByRole("slider", { name: "每日学习目标" });
    vi.spyOn(dial, "getBoundingClientRect").mockReturnValue({
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      right: 208,
      bottom: 208,
      width: 208,
      height: 208,
      toJSON: () => ({}),
    });

    fireEvent.pointerDown(dial, {
      pointerId: 1,
      pointerType: "mouse",
      button: 0,
      clientX: 104,
      clientY: 20,
    });
    expect(dial).toHaveAttribute("aria-valuenow", "95");

    fireEvent.pointerMove(dial, {
      pointerId: 1,
      pointerType: "mouse",
      clientX: 160,
      clientY: 160,
    });
    fireEvent.pointerUp(dial, { pointerId: 1, pointerType: "mouse" });
    expect(dial).toHaveAttribute("aria-valuenow", "180");

    fireEvent.click(within(dialog).getByRole("button", { name: "保存" }));
    expect(onSave).toHaveBeenCalledWith(180);
  });

  it("discards a draft when cancelled", async () => {
    const { onSave, trigger } = renderDialog(45);
    const dialog = screen.getByRole("dialog", { name: "设置每日目标" });
    const dial = within(dialog).getByRole("slider", { name: "每日学习目标" });

    fireEvent.keyDown(dial, { key: "End" });
    expect(dial).toHaveAttribute("aria-valuenow", "180");
    fireEvent.click(within(dialog).getByRole("button", { name: "取消" }));

    expect(onSave).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog", { name: "设置每日目标" })).not.toBeInTheDocument();
    await waitFor(() => expect(trigger).toHaveFocus());
  });
});
