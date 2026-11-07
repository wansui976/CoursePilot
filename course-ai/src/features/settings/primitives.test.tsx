import "@/i18n";
import "@testing-library/jest-dom/vitest";
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { Row } from "./primitives";

describe("settings Row hint", () => {
  it("keeps the explanation behind an ⓘ until asked, and always shows the status", () => {
    render(
      <Row label="识别语言" hint="对本地识别生效" status="已配置">
        <input aria-label="控件" />
      </Row>,
    );
    // 状态常显；说明默认收着。
    expect(screen.getByText("已配置")).toBeInTheDocument();
    expect(screen.queryByText("对本地识别生效")).not.toBeInTheDocument();

    const button = screen.getByRole("button", { name: "「识别语言」的说明" });
    expect(button).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(button);
    expect(button).toHaveAttribute("aria-expanded", "true");
    const note = screen.getByRole("note", { name: "「识别语言」的说明" });
    expect(note).toHaveTextContent("对本地识别生效");
    expect(button).toHaveAttribute("aria-controls", note.id);

    // 点说明本身不收起；点外面收起。
    fireEvent.pointerDown(note);
    expect(screen.getByRole("note")).toBeInTheDocument();
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole("note")).not.toBeInTheDocument();

    // 再点一次按钮也能收起。
    fireEvent.click(button);
    fireEvent.click(button);
    expect(screen.queryByRole("note")).not.toBeInTheDocument();
  });

  it("closes on Escape without letting it reach the page, and returns focus", () => {
    const pageEscape = vi.fn();
    document.addEventListener("keydown", pageEscape);
    render(
      <Row label="AI 纠错并发数" hint="越大越快">
        <input aria-label="控件" />
      </Row>,
    );
    const button = screen.getByRole("button", { name: "「AI 纠错并发数」的说明" });
    fireEvent.click(button);
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
    expect(screen.queryByRole("note")).not.toBeInTheDocument();
    expect(button).toHaveFocus();
    // 只收说明，Esc 不再冒泡去关掉整个设置页。
    expect(pageEscape).not.toHaveBeenCalled();
    document.removeEventListener("keydown", pageEscape);
  });

  it("has no ⓘ when there is nothing to explain", () => {
    render(
      <Row label="主题">
        <input aria-label="控件" />
      </Row>,
    );
    expect(screen.queryByRole("button", { name: /的说明/ })).not.toBeInTheDocument();
  });
});
