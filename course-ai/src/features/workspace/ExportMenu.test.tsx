import "@testing-library/jest-dom/vitest";
import "@/i18n";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ExportMenu } from "./ExportMenu";

const { isMobileMock, shareFileMock, revealMock } = vi.hoisted(() => ({
  isMobileMock: vi.fn(),
  shareFileMock: vi.fn(),
  revealMock: vi.fn(),
}));

vi.mock("@tauri-apps/plugin-opener", () => ({ revealItemInDir: revealMock }));

vi.mock("@/lib/mobileFiles", () => ({
  isMobile: isMobileMock,
  shareFile: shareFileMock,
}));

describe("ExportMenu", () => {
  beforeEach(() => {
    isMobileMock.mockReset().mockReturnValue(false);
    shareFileMock.mockReset();
    revealMock.mockReset().mockResolvedValue(undefined);
  });

  it("导出后可以在文件夹中显示导出的文件", async () => {
    const path = "/courses/a/.courseai/v1/exports/v1/notes.md";
    render(<ExportMenu items={[{ label: "Markdown", run: vi.fn().mockResolvedValue(path) }]} />);

    fireEvent.click(screen.getByRole("button", { name: "导出" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Markdown" }));
    fireEvent.click(await screen.findByRole("button", { name: "在文件夹中显示" }));

    expect(revealMock).toHaveBeenCalledWith(path);
  });

  it("supports menu keyboard navigation and restores focus on Escape", async () => {
    render(
      <ExportMenu
        items={[
          { label: "Markdown", run: vi.fn().mockResolvedValue("/tmp/notes.md") },
          { label: "PDF", run: vi.fn().mockResolvedValue("/tmp/notes.pdf") },
        ]}
      />,
    );

    const trigger = screen.getByRole("button", { name: "导出" });
    expect(trigger).toHaveAttribute("aria-haspopup", "menu");
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(trigger);

    const menu = screen.getByRole("menu", { name: "导出" });
    const markdown = screen.getByRole("menuitem", { name: "Markdown" });
    const pdf = screen.getByRole("menuitem", { name: "PDF" });
    await waitFor(() => expect(markdown).toHaveFocus());
    expect(trigger).toHaveAttribute("aria-expanded", "true");

    fireEvent.keyDown(menu, { key: "ArrowDown" });
    expect(pdf).toHaveFocus();
    fireEvent.keyDown(menu, { key: "Home" });
    expect(markdown).toHaveFocus();
    fireEvent.keyDown(menu, { key: "End" });
    expect(pdf).toHaveFocus();
    fireEvent.keyDown(menu, { key: "Escape" });

    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    await waitFor(() => expect(trigger).toHaveFocus());
  });

  it("导出耗时较长（按钮禁用期间）也会在结束后把焦点还给导出按钮", async () => {
    let finish: (path: string) => void = () => {};
    const run = vi.fn(() => new Promise<string>((resolve) => (finish = resolve)));
    render(<ExportMenu items={[{ label: "Markdown", run }]} />);

    const trigger = screen.getByRole("button", { name: "导出" });
    fireEvent.click(trigger);
    fireEvent.click(await screen.findByRole("menuitem", { name: "Markdown" }));

    // 导出进行中：按钮禁用，下一帧的焦点归还落空。等过这一帧再结束导出。
    await waitFor(() => expect(trigger).toBeDisabled());
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(trigger).not.toHaveFocus();

    await act(async () => finish("/tmp/slow-notes.md"));
    await waitFor(() => expect(trigger).toHaveFocus());
  });

  it("announces success and returns focus after an export", async () => {
    const run = vi.fn().mockResolvedValue("/tmp/current-notes.md");
    render(<ExportMenu items={[{ label: "Markdown", run }]} />);

    const trigger = screen.getByRole("button", { name: "导出" });
    fireEvent.click(trigger);
    fireEvent.click(await screen.findByRole("menuitem", { name: "Markdown" }));

    await waitFor(() => expect(run).toHaveBeenCalledTimes(1));
    expect(await screen.findByRole("status")).toHaveTextContent("current-notes.md");
    await waitFor(() => expect(trigger).toHaveFocus());
  });

  it("announces export errors without visually truncating them", async () => {
    const run = vi.fn().mockRejectedValue(new Error("导出目录没有写入权限，请选择其他目录"));
    render(<ExportMenu items={[{ label: "Markdown", run }]} />);

    fireEvent.click(screen.getByRole("button", { name: "导出" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Markdown" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("没有文件访问权限，请检查目录权限后重试。");
    expect(alert).not.toHaveClass("truncate");
    fireEvent.click(screen.getByRole("button", { name: "关闭" }));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});
