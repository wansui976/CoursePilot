import "@/i18n";
import { Editor } from "@tiptap/core";
import { waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { notesExtensions } from "./extensions";
import { tiptapToMarkdown } from "@/lib/tiptapToMarkdown";

const { readNoteImage } = vi.hoisted(() => ({ readNoteImage: vi.fn() }));
vi.mock("@/lib/ipc", () => ({ ipc: { ai: { readNoteImage } } }));

let editor: Editor | null = null;
beforeEach(() => {
  readNoteImage.mockReset();
  vi.stubGlobal("URL", Object.assign(URL, { createObjectURL: vi.fn(() => "blob:note-image") }));
});
afterEach(() => {
  editor?.destroy();
  editor = null;
});

function mount(src: string) {
  editor = new Editor({
    element: document.createElement("div"),
    extensions: notesExtensions(),
    content: { type: "doc", content: [{ type: "image", attrs: { src, width: 1600, height: 900 } }] },
  });
  return editor.view.dom.querySelector<HTMLElement>("[data-note-image]")!;
}

describe("笔记图片", () => {
  it("本地图片按 id 从库里读出来显示，加载前按原图比例占位", async () => {
    readNoteImage.mockResolvedValue(new Uint8Array([1, 2]).buffer);
    const figure = mount("note-image:abc");
    const img = figure.querySelector("img")!;
    expect(img.style.aspectRatio).toBe("1600 / 900");
    await waitFor(() => expect(img.getAttribute("src")).toBe("blob:note-image"));
    expect(readNoteImage).toHaveBeenCalledWith("abc");
  });

  it("库里没有（另一台设备的图还没同步过来）时给出说明，而不是一张破图", async () => {
    readNoteImage.mockRejectedValue(new Error("not found"));
    const figure = mount("note-image:missing");
    await waitFor(() => expect(figure.dataset.state).toBe("missing"));
    expect(figure.textContent).toBe("这张图片还没同步到这台设备");
  });

  it("存成 Markdown 是一行 ![](note-image:id)", () => {
    readNoteImage.mockResolvedValue(new ArrayBuffer(1));
    mount("note-image:abc");
    expect(tiptapToMarkdown(editor!.getJSON())).toBe("![](note-image:abc)");
  });
});
