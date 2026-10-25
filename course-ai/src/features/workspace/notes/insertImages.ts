import type { Editor, JSONContent } from "@tiptap/react";
import { ipc } from "@/lib/ipc";
import { primeNoteImage } from "./noteImage";
import { blobToBase64, prepareImage } from "./prepareImage";

export interface StoredImage {
  src: string;
  width: number;
  height: number;
}

/** 压缩并存进库，返回笔记里引用它用的属性。 */
export async function storeNoteImage(videoId: string, input: Blob): Promise<StoredImage> {
  const prepared = await prepareImage(input);
  const saved = await ipc.ai.saveNoteImage(videoId, {
    mime: prepared.mime,
    dataBase64: await blobToBase64(prepared.blob),
    width: prepared.width,
    height: prepared.height,
  });
  primeNoteImage(saved.src, prepared.blob);
  return { src: saved.src, width: prepared.width, height: prepared.height };
}

export function imageFiles(list: FileList | null | undefined): File[] {
  return Array.from(list ?? []).filter((file) => file.type.startsWith("image/"));
}

/**
 * 插入一组块。`at` 给定时插在那个位置（拖放落点）；否则编辑器有焦点就插在光标处，
 * 没有焦点（光标还停在开头的默认位置）就接在末尾——和「记一笔」一样。
 */
export function insertBlocks(editor: Editor, content: JSONContent[], at?: number) {
  if (at != null) {
    editor.chain().focus().insertContentAt(at, content).run();
    return;
  }
  if (editor.isFocused) {
    editor.chain().focus().insertContent(content).run();
    return;
  }
  editor.chain().insertContentAt(editor.state.doc.content.size, content).focus("end").run();
}

export function imageBlocks(images: StoredImage[]): JSONContent[] {
  return images.map((image) => ({ type: "image", attrs: { ...image, alt: null } }));
}

/** 截取视频当前画面：图片下面跟一行带时间戳的说明，光标停在后面接着写。 */
export async function captureFrameBlocks(videoId: string, ms: number): Promise<JSONContent[]> {
  const shot = await ipc.slides.capture(videoId, Math.max(0, Math.round(ms)));
  const buffer = await ipc.slides.image(videoId, shot.image_path);
  const image = await storeNoteImage(videoId, new Blob([buffer], { type: "image/jpeg" }));
  return [
    ...imageBlocks([image]),
    {
      type: "paragraph",
      content: [
        { type: "timestamp", attrs: { ms: Math.max(0, Math.round(ms)) } },
        { type: "text", text: " " },
      ],
    },
  ];
}
