import "@testing-library/jest-dom/vitest";
import "@/i18n";
import { Editor } from "@tiptap/core";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { notesExtensions } from "./extensions";
import { NotesToolbar } from "./NotesToolbar";

vi.mock("@/lib/ipc", () => ({ ipc: { ai: { readNoteImage: vi.fn() } } }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));

let editor: Editor | null = null;
afterEach(() => {
  editor?.destroy();
  editor = null;
});

function setup(text = "梯度下降") {
  const element = document.createElement("div");
  document.body.append(element);
  editor = new Editor({
    element,
    extensions: notesExtensions(),
    content: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text }] }] },
  });
  const onInsertImages = vi.fn();
  const onCaptureFrame = vi.fn();
  render(
    <NotesToolbar
      editor={editor as never}
      imageBusy={false}
      onInsertImages={onInsertImages}
      onCaptureFrame={onCaptureFrame}
    />,
  );
  return { editor, onInsertImages, onCaptureFrame };
}

function selectAll(target: Editor) {
  act(() => {
    target.commands.setTextSelection({ from: 1, to: target.state.doc.content.size - 1 });
  });
}

describe("笔记格式条", () => {
  it("加粗、待办随光标处的格式亮起", () => {
    const { editor } = setup();
    selectAll(editor);
    const bold = screen.getByRole("button", { name: "加粗" });
    expect(bold).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(bold);
    expect(editor.isActive("bold")).toBe(true);
    expect(bold).toHaveAttribute("aria-pressed", "true");

    fireEvent.click(screen.getByRole("button", { name: "待办" }));
    expect(editor.isActive("taskList")).toBe(true);
  });

  it("段落样式下拉切换标题级别", () => {
    const { editor } = setup();
    const select = screen.getByRole("combobox", { name: "段落样式" });
    fireEvent.change(select, { target: { value: "h2" } });
    expect(editor.isActive("heading", { level: 2 })).toBe(true);
    expect(select).toHaveValue("h2");
    fireEvent.change(select, { target: { value: "paragraph" } });
    expect(editor.isActive("heading")).toBe(false);
  });

  it("不常用的格式在「更多格式」里：代码块、分隔线、表格", () => {
    const { editor } = setup();
    fireEvent.click(screen.getByRole("button", { name: "更多格式" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "代码块" }));
    expect(editor.isActive("codeBlock")).toBe(true);
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "更多格式" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "插入表格" }));
    expect(editor.isActive("table")).toBe(true);
  });

  it("给选中文字加链接；没写协议补上 https://，填空则去掉链接", () => {
    const { editor } = setup();
    selectAll(editor);
    fireEvent.click(screen.getByRole("button", { name: "链接" }));
    const input = screen.getByRole("textbox", { name: "链接地址" });
    // 不能交给浏览器按 type="url" 校验：不带协议的地址会被拦下，回车什么都不发生。
    expect(input.closest("form")).toHaveAttribute("novalidate");
    fireEvent.change(input, { target: { value: "example.com/docs" } });
    fireEvent.submit(input.closest("form")!);
    expect(editor.getAttributes("link").href).toBe("https://example.com/docs");

    selectAll(editor);
    fireEvent.click(screen.getByRole("button", { name: "链接" }));
    const again = screen.getByRole("textbox", { name: "链接地址" });
    expect(again).toHaveValue("https://example.com/docs");
    fireEvent.change(again, { target: { value: "" } });
    fireEvent.submit(again.closest("form")!);
    expect(editor.isActive("link")).toBe(false);
  });

  it("不接受 javascript: 之类的链接", () => {
    const { editor } = setup();
    selectAll(editor);
    fireEvent.click(screen.getByRole("button", { name: "链接" }));
    const input = screen.getByRole("textbox", { name: "链接地址" });
    fireEvent.change(input, { target: { value: "javascript:alert(1)" } });
    fireEvent.submit(input.closest("form")!);
    expect(editor.isActive("link")).toBe(false);
  });

  it("插图片走文件选择，截画面交给面板", () => {
    const { onInsertImages, onCaptureFrame } = setup();
    fireEvent.click(screen.getByRole("button", { name: "截取当前画面" }));
    expect(onCaptureFrame).toHaveBeenCalledTimes(1);

    const input = document.querySelector<HTMLInputElement>('input[type="file"]')!;
    const png = new File(["x"], "a.png", { type: "image/png" });
    const txt = new File(["x"], "a.txt", { type: "text/plain" });
    fireEvent.change(input, { target: { files: [png, txt] } });
    expect(onInsertImages).toHaveBeenCalledWith([png]);
  });
});
