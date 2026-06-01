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
    };
  },

  parseHTML() {
    return [{ tag: "span[data-ms]" }];
  },

  renderHTML({ HTMLAttributes }) {
    const ms = Number(HTMLAttributes.ms ?? 0);
    return [
      "span",
      mergeAttributes(HTMLAttributes, {
        "data-ms": String(ms),
        class:
          "cursor-pointer rounded bg-primary/20 px-1 text-xs text-primary align-middle",
      }),
      `▶ ${HTMLAttributes.label || formatMs(ms)}`,
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
