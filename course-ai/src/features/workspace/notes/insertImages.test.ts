import { describe, expect, it } from "vitest";
import { imageFiles, imageFilesFromTransfer } from "./insertImages";

const png = () => new File(["x"], "shot.png", { type: "image/png" });

function item(file: File | null, type: string, kind = "file") {
  return { kind, type, getAsFile: () => file };
}

describe("imageFilesFromTransfer", () => {
  it("files 里有图就直接用（触屏「相册」选图、文件输入框）", () => {
    const file = png();
    expect(imageFilesFromTransfer({ files: [file], items: [] })).toEqual([file]);
  });

  it("files 是空的时从 items 里取（WKWebView / Safari 粘贴截图、访达拖图）", () => {
    const file = png();
    expect(imageFilesFromTransfer({ files: [], items: [item(file, "image/png")] })).toEqual([file]);
  });

  it("只看文件类的 item，字符串（链接、纯文本）不算图片", () => {
    const file = png();
    expect(
      imageFilesFromTransfer({
        items: [item(null, "text/plain", "string"), item(file, "image/png")],
      }),
    ).toEqual([file]);
  });

  it("非图片文件和不给文件的 item 都跳过", () => {
    expect(
      imageFilesFromTransfer({
        items: [item(new File(["x"], "a.pdf", { type: "application/pdf" }), "application/pdf"), item(null, "")],
      }),
    ).toEqual([]);
  });

  it("没有数据时返回空数组，不抛错", () => {
    expect(imageFilesFromTransfer(null)).toEqual([]);
    expect(imageFilesFromTransfer(undefined)).toEqual([]);
    expect(imageFilesFromTransfer({})).toEqual([]);
  });

  it("imageFiles 也接受普通数组（拖放里拿到的是 File[] 而不是 FileList）", () => {
    expect(imageFiles([png()])).toHaveLength(1);
  });
});
