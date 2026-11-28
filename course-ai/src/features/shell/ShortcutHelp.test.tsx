import "@testing-library/jest-dom/vitest";
import i18n from "@/i18n";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_BINDINGS, useShortcuts } from "@/stores/shortcuts";
import { SHORTCUT_HELP_EVENT, ShortcutHelp } from "./ShortcutHelp";

beforeEach(async () => {
  await i18n.changeLanguage("zh-CN");
  useShortcuts.setState({ bindings: { ...DEFAULT_BINDINGS, takeNote: "q" } });
});

describe("ShortcutHelp", () => {
  it("opens on ? and lists the user's own bindings", () => {
    render(<ShortcutHelp />);
    fireEvent.keyDown(window, { key: "?" });
    expect(screen.getByRole("dialog", { name: "键盘快捷键" })).toBeInTheDocument();
    const row = screen.getByText("记一笔").closest("li")!;
    expect(row).toHaveTextContent("Q");
    expect(screen.getByText("区间复读").closest("li")).toHaveTextContent("R");
  });

  it("ignores ? typed into a text field", () => {
    render(
      <>
        <input aria-label="field" />
        <ShortcutHelp />
      </>,
    );
    fireEvent.keyDown(screen.getByLabelText("field"), { key: "?" });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("opens from the palette event", () => {
    render(<ShortcutHelp />);
    fireEvent(window, new Event(SHORTCUT_HELP_EVENT));
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });
});
