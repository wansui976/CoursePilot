import type { Extensions } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { TaskItem, TaskList } from "@tiptap/extension-list";
import { Table } from "@tiptap/extension-table";
import { TableRow } from "@tiptap/extension-table-row";
import { TableHeader } from "@tiptap/extension-table-header";
import { TableCell } from "@tiptap/extension-table-cell";
import { TimestampNode } from "./timestampNode";
import { MathNode } from "./mathNode";
import { NoteImage } from "./noteImage";

/**
 * 笔记编辑器与历史预览共用的一套节点：两边一致，预览才能和编辑器里看到的一样。
 *
 * 链接不在点击时直接打开：编辑时点链接是为了把光标放进去改字；在 Tauri 里 window.open
 * 也不会交给系统浏览器。打开走链接浮条上的按钮（openUrl）。
 */
export function notesExtensions(): Extensions {
  return [
    StarterKit.configure({
      // 拖放落点：强调色细线，不用默认的黑线。
      dropcursor: { color: "var(--accent)", width: 2 },
      link: {
        openOnClick: false,
        autolink: true,
        linkOnPaste: true,
        defaultProtocol: "https",
        HTMLAttributes: { target: null, rel: "noopener noreferrer nofollow" },
      },
    }),
    TaskList,
    TaskItem.configure({ nested: true }),
    TimestampNode,
    MathNode,
    NoteImage,
    Table.configure({ resizable: false }),
    TableRow,
    TableHeader,
    TableCell,
  ];
}
