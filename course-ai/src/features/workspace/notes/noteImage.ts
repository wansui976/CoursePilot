import { mergeAttributes, Node } from "@tiptap/core";
import i18n from "@/i18n";
import { ipc } from "@/lib/ipc";

/** 笔记里引用本地图片的 src 前缀；图片本身存在 note_images 表里，按 id 取。 */
export const NOTE_IMAGE_PREFIX = "note-image:";

export function noteImageId(src: string): string | null {
  return src.startsWith(NOTE_IMAGE_PREFIX) ? src.slice(NOTE_IMAGE_PREFIX.length) : null;
}

// 同一张图在编辑器、历史预览里反复出现，只读一次库、只建一个 blob URL。
// 失败的不缓存：图片可能只是还没从另一台设备同步过来，下次显示时再试。
const urlCache = new Map<string, Promise<string>>();

export function resolveNoteImageSrc(src: string): Promise<string> {
  const id = noteImageId(src);
  if (!id) return Promise.resolve(src);
  let pending = urlCache.get(id);
  if (!pending) {
    pending = ipc.ai.readNoteImage(id).then((buffer) => URL.createObjectURL(new Blob([buffer])));
    pending.catch(() => urlCache.delete(id));
    urlCache.set(id, pending);
  }
  return pending;
}

/** 刚存进库的图：直接拿内存里的 Blob 建 URL，插入后不必再读一遍库。 */
export function primeNoteImage(src: string, blob: Blob) {
  const id = noteImageId(src);
  if (id && !urlCache.has(id)) urlCache.set(id, Promise.resolve(URL.createObjectURL(blob)));
}

/**
 * 块级图片节点。src 是 `note-image:<id>`（本地图片）或普通网址；节点视图异步换成可显示的地址。
 * width / height 是原图像素尺寸，只用来在加载前按比例占位，免得图出来时正文跳动。
 */
export const NoteImage = Node.create({
  name: "image",
  group: "block",
  atom: true,
  draggable: true,
  selectable: true,

  addAttributes() {
    return {
      src: { default: null },
      alt: { default: null },
      width: { default: null },
      height: { default: null },
    };
  },

  parseHTML() {
    // 从网页粘贴来的 data: 图片不收：几 MB 的 base64 会直接写进笔记正文。
    return [{ tag: 'img[src]:not([src^="data:"])' }];
  },

  renderHTML({ HTMLAttributes }) {
    return ["img", mergeAttributes(HTMLAttributes)];
  },

  addNodeView() {
    return ({ node }) => {
      const dom = document.createElement("figure");
      dom.className = "ca-note-image";
      dom.dataset.noteImage = "";
      const img = document.createElement("img");
      img.alt = String(node.attrs.alt ?? "");
      img.draggable = false;
      const width = Number(node.attrs.width);
      const height = Number(node.attrs.height);
      if (width > 0 && height > 0) {
        img.width = width;
        img.height = height;
        img.style.aspectRatio = `${width} / ${height}`;
      }
      dom.append(img);

      const src = String(node.attrs.src ?? "");
      dom.dataset.state = "loading";
      resolveNoteImageSrc(src)
        .then((url) => {
          img.src = url;
          img.onload = () => (dom.dataset.state = "ready");
          img.onerror = () => showMissing();
        })
        .catch(() => showMissing());

      function showMissing() {
        dom.dataset.state = "missing";
        img.remove();
        const note = document.createElement("span");
        note.className = "ca-note-image-missing";
        note.textContent = noteImageId(src)
          ? i18n.t("notes.imageMissing")
          : i18n.t("notes.imageBroken");
        dom.append(note);
      }

      return { dom };
    };
  },
});
