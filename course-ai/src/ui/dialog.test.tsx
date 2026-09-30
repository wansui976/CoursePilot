import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useRef, useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { Modal, ModalClose } from "./dialog";

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
