import { type Editor } from "@tiptap/react";
import { BubbleMenu } from "@tiptap/react/menus";
import {
  Bold,
  Code,
  Heading2,
  Italic,
  List,
  ListOrdered,
  Strikethrough,
  Table as TableIcon,
  Trash2,
} from "lucide-react";
import { useTranslation } from "react-i18next";

/** 笔记编辑器的浮出格式条：选中文字时出现，不占用编辑区布局。
 *  只暴露 StarterKit + Table 扩展里已有、且不会误伤的命令（笔记编辑高频的那组）。 */
export function NotesToolbar({ editor }: { editor: Editor }) {
  const { t } = useTranslation();
  // 防御：真实 tiptap editor 必有 isActive/chain；测试里的替身没有，此时不渲染工具栏
  // （导入不挂载 DOM，只有渲染才触发 tippy，jsdom 下会炸）。
  if (!editor.isActive || !editor.chain) return null;
  const inTable = editor.isActive("table");

  const btn = (active: boolean) =>
    `ca-touch-44 grid h-7 w-7 flex-none place-items-center rounded-md transition-colors ${
      active
        ? "bg-[var(--accent-weak)] text-[var(--accent-text)]"
        : "text-[var(--text-muted)] hover:bg-[var(--surface-card-hover)] hover:text-[var(--text-strong)]"
    }`;

  const tools: { icon: typeof Bold; label: string; run: () => void; active: boolean }[] = [
    {
      icon: Bold,
      label: t("notesToolbar.bold"),
      active: editor.isActive("bold"),
      run: () => editor.chain().focus().toggleBold().run(),
    },
    {
      icon: Italic,
      label: t("notesToolbar.italic"),
      active: editor.isActive("italic"),
      run: () => editor.chain().focus().toggleItalic().run(),
    },
    {
      icon: Strikethrough,
      label: t("notesToolbar.strike"),
      active: editor.isActive("strike"),
      run: () => editor.chain().focus().toggleStrike().run(),
    },
    {
      icon: Code,
      label: t("notesToolbar.code"),
      active: editor.isActive("code"),
      run: () => editor.chain().focus().toggleCode().run(),
    },
    {
      icon: List,
      label: t("notesToolbar.bulletList"),
      active: editor.isActive("bulletList"),
      run: () => editor.chain().focus().toggleBulletList().run(),
    },
    {
      icon: ListOrdered,
      label: t("notesToolbar.orderedList"),
      active: editor.isActive("orderedList"),
      run: () => editor.chain().focus().toggleOrderedList().run(),
    },
    {
      icon: Heading2,
      label: t("notesToolbar.heading"),
      active: editor.isActive("heading", { level: 2 }),
      run: () => editor.chain().focus().toggleHeading({ level: 2 }).run(),
    },
  ];

  return (
    <BubbleMenu
      editor={editor}
      className="flex items-center gap-0.5 rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-panel)] p-1 shadow-[var(--shadow-pop)]"
    >
      {tools.map(({ icon: Icon, label, run, active }) => (
        <button
          key={label}
          type="button"
          aria-label={label}
          title={label}
          onMouseDown={(event) => event.preventDefault()}
          onClick={run}
          className={btn(active)}
        >
          <Icon className="h-3.5 w-3.5" />
        </button>
      ))}
      <span aria-hidden="true" className="mx-0.5 h-5 w-px bg-[var(--border-subtle)]" />
      {/* 表格：在表内时切换为行/列操作；不在表内时是插入表格。 */}
      {inTable ? (
        <>
          <button
            type="button"
            aria-label={t("notesToolbar.tableAddRow")}
            title={t("notesToolbar.tableAddRow")}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => editor.chain().focus().addRowAfter().run()}
            className={btn(false)}
          >
            <span className="text-[13px] font-semibold leading-none">＋行</span>
          </button>
          <button
            type="button"
            aria-label={t("notesToolbar.tableAddCol")}
            title={t("notesToolbar.tableAddCol")}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => editor.chain().focus().addColumnAfter().run()}
            className={btn(false)}
          >
            <span className="text-[13px] font-semibold leading-none">＋列</span>
          </button>
          <button
            type="button"
            aria-label={t("notesToolbar.tableDelete")}
            title={t("notesToolbar.tableDelete")}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => editor.chain().focus().deleteTable().run()}
            className={btn(false)}
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        </>
      ) : (
        <button
          type="button"
          aria-label={t("notesToolbar.tableInsert")}
          title={t("notesToolbar.tableInsert")}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() =>
            editor
              .chain()
              .focus()
              .insertTable({ rows: 2, cols: 2, withHeaderRow: true })
              .run()
          }
          className={btn(false)}
        >
          <TableIcon className="h-3.5 w-3.5" />
        </button>
      )}
    </BubbleMenu>
  );
}
