import { mergeAttributes, Node } from "@tiptap/core";
import { usePlayer } from "@/stores/player";
import { formatMs } from "@/lib/time";

export const TimestampNode = Node.create({
  name: "timestamp",
  inline: true,
  group: "inline",
  atom: true,

  addAttributes() {
    return {
      ms: { default: 0 },
      label: { default: "" },
      source: { default: false },
    };
  },

  parseHTML() {
    return [{ tag: "span[data-ms]" }];
  },

  renderHTML({ HTMLAttributes }) {
    const ms = Number(HTMLAttributes.ms ?? 0);
    const source =
      HTMLAttributes.source === true || HTMLAttributes.source === "true";
    return [
      "span",
      mergeAttributes(HTMLAttributes, {
        "data-ms": String(ms),
        class: source
          ? "ca-ts-chip ca-ts-source-chip cursor-pointer rounded px-1 text-xs text-[var(--text-muted)] align-middle"
          : "ca-ts-chip ca-time cursor-pointer align-middle",
      }),
      // 统一按播放器同款格式显示（>=1 小时为 hh:mm:ss，否则 mm:ss），
      // 不再沿用导入时模型/字幕写下的「总分钟:秒」，免得笔记里的时间与进度条对不上。
      `${source ? "" : "▶ "}${formatMs(ms)}`,
    ];
  },
});

/** 全局点击委托：点 [data-ms] 即 seek。在 NotesPanel 挂载一次即可。 */
export function installTimestampClick(root: HTMLElement): () => void {
  const handler = (e: MouseEvent) => {
    const target = (e.target as HTMLElement).closest<HTMLElement>("[data-ms]");
    if (target) {
      usePlayer.getState().requestSeek(Number(target.dataset.ms));
    }
  };
  root.addEventListener("click", handler);
  return () => root.removeEventListener("click", handler);
}
