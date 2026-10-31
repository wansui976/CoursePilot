import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useRef, useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { Modal, ModalClose } from "./dialog";
import { ShellContext, type Shell } from "@/app/shell";

function Harness({
  locked = false,
  onOpenChange = vi.fn(),
}: {
  locked?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const [open, setOpen] = useState(true);
  const returnRef = useRef<HTMLButtonElement>(null);
  return (
    <>
      <button ref={returnRef}>回到这里</button>
      <Modal
        open={open}
        onOpenChange={(next) => {
          onOpenChange(next);
          setOpen(next);
        }}
        locked={locked}
        title="确认"
        description="说明文字"
        overlayTestId="overlay"
        returnFocusTo={() => returnRef.current}
      >
        <ModalClose>关闭</ModalClose>
      </Modal>
    </>
  );
}

describe("Modal", () => {
  it("is a labelled, described modal dialog that Home's back handling can find", () => {
    render(<Harness />);
    const dialog = screen.getByRole("dialog", { name: "确认" });
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(dialog).toHaveAccessibleDescription("说明文字");
    expect(dialog).toHaveAttribute("data-state", "open");
    expect(screen.getByTestId("overlay")).toHaveClass("ca-dialog-overlay");
  });

  it("closes on Escape and returns focus to the requested element", async () => {
    render(<Harness />);
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    // Radix 的 FocusScope 在卸载后的下一个任务里才归还焦点。
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "回到这里" })).toHaveFocus(),
    );
  });

  it("ignores every close path while locked", () => {
    const onOpenChange = vi.fn();
    render(<Harness locked onOpenChange={onOpenChange} />);
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    fireEvent.pointerDown(screen.getByTestId("overlay"));
    fireEvent.click(screen.getByRole("button", { name: "关闭" }));
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });
});

describe("Modal 在手机上呈现为底部弹层", () => {
  const phoneShell = { isPhoneDevice: true } as unknown as Shell;

  function renderSheet(locked: boolean, onOpenChange = vi.fn()) {
    render(
      <ShellContext.Provider value={phoneShell}>
        <Modal open onOpenChange={onOpenChange} title="下载" locked={locked}>
          <p>内容</p>
        </Modal>
      </ShellContext.Provider>,
    );
    return onOpenChange;
  }

  it("叠放布局下 data-presentation=sheet，并带抓手", () => {
    renderSheet(false);
    expect(screen.getByRole("dialog")).toHaveAttribute("data-presentation", "sheet");
    expect(screen.getByTestId("sheet-handle")).toBeInTheDocument();
  });

  it("往下拖过阈值松手即关闭；locked 时拖不动", () => {
    const onOpenChange = renderSheet(false);
    const handle = screen.getByTestId("sheet-handle");
    fireEvent.pointerDown(handle, { pointerId: 1, clientY: 100 });
    fireEvent.pointerMove(handle, { pointerId: 1, clientY: 260 });
    fireEvent.pointerUp(handle, { pointerId: 1, clientY: 260 });
    expect(onOpenChange).toHaveBeenCalledWith(false);
    cleanup();

    const lockedChange = renderSheet(true);
    const lockedHandle = screen.getByTestId("sheet-handle");
    fireEvent.pointerDown(lockedHandle, { pointerId: 1, clientY: 100 });
    fireEvent.pointerMove(lockedHandle, { pointerId: 1, clientY: 400 });
    fireEvent.pointerUp(lockedHandle, { pointerId: 1, clientY: 400 });
    expect(lockedChange).not.toHaveBeenCalled();
  });

  it("手机上按 Escape 也能关掉弹层", () => {
    const onOpenChange = renderSheet(false);
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("桌面默认居中", () => {
    render(
      <Modal open onOpenChange={vi.fn()} title="下载">
        <p>内容</p>
      </Modal>,
    );
    expect(screen.getByRole("dialog")).toHaveAttribute("data-presentation", "center");
  });
});
