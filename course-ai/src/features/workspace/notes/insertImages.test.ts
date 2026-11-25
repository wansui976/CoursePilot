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

describe("imageFiles 在安卓选图器上", () => {
  const untyped = (name: string) => new File(["x"], name, { type: "" });

  it("选图器给回来的文件没有类型、名字只是数字时也收下", () => {
    expect(imageFiles([untyped("1000012345")], { fromImagePicker: true })).toHaveLength(1);
  });

  it("不是选图器来的：没类型就按扩展名认", () => {
    expect(imageFiles([untyped("IMG_0001.HEIC"), untyped("photo.jpg")])).toHaveLength(2);
    expect(imageFiles([untyped("notes.txt"), untyped("1000012345")])).toHaveLength(0);
  });

  it("明确不是图片的照样不收", () => {
    expect(imageFiles([new File(["x"], "a.pdf", { type: "application/pdf" })], { fromImagePicker: true })).toHaveLength(0);
  });
});
