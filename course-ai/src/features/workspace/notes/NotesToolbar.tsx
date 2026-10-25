import { type Editor, useEditorState } from "@tiptap/react";
import { BubbleMenu } from "@tiptap/react/menus";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  Bold,
  Camera,
  Check,
  Code,
  ExternalLink,
  ImagePlus,
  Italic,
  Link2,
  List,
  ListChecks,
  ListOrdered,
  type LucideIcon,
  Minus,
  MoreHorizontal,
  Quote,
  Redo2,
  SquareCode,
  Strikethrough,
  Table as TableIcon,
  Undo2,
} from "lucide-react";
import { type FormEvent, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { coarsePointer } from "@/lib/useContainerWidth";
import { cn } from "@/lib/utils";
import { Menu, MenuItem } from "@/ui/menu";
import { GhostSelect } from "@/ui/select";
import { imageFiles } from "./insertImages";
import { normalizeLinkHref } from "./linkHref";

type BlockType = "paragraph" | "h1" | "h2" | "h3";

/** 编辑器还没挂到页面上时 can() 会抛错（命令管理器尚未建立），当作「不能」。 */
function can(editor: Editor, command: "undo" | "redo"): boolean {
  try {
    return editor.can()[command]();
  } catch {
    return false;
  }
}

function blockType(editor: Editor): BlockType {
  for (const level of [1, 2, 3] as const) {
    if (editor.isActive("heading", { level })) return `h${level}`;
  }
  return "paragraph";
}


const toolClass = (active = false) =>
  cn(
    "ca-touch-44 grid h-7 w-7 flex-none place-items-center rounded-md transition-colors disabled:pointer-events-none disabled:opacity-35",
    active
      ? "bg-[var(--accent-weak)] text-[var(--accent-text)]"
      : "text-[var(--text-muted)] hover:bg-[var(--surface-card-hover)] hover:text-[var(--text-strong)]",
  );

function Tool({
  icon: Icon,
  label,
  onRun,
  active,
  disabled,
}: {
  icon: LucideIcon;
  label: string;
  onRun: () => void;
  active?: boolean;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      aria-pressed={active ?? undefined}
      disabled={disabled}
      // 不抢编辑器焦点：点完按钮光标还在原处。
      onMouseDown={(event) => event.preventDefault()}
      onClick={onRun}
      className={toolClass(active)}
    >
      <Icon className="h-4 w-4" />
    </button>
  );
}

type ChainCommand = (chain: ReturnType<Editor["chain"]>) => ReturnType<Editor["chain"]>;

const TABLE_ACTIONS: [string, ChainCommand][] = [
  ["tableAddRow", (chain) => chain.addRowAfter()],
  ["tableAddCol", (chain) => chain.addColumnAfter()],
  ["tableDeleteRow", (chain) => chain.deleteRow()],
  ["tableDeleteCol", (chain) => chain.deleteColumn()],
  ["tableDelete", (chain) => chain.deleteTable()],
];

function Divider() {
  return <span aria-hidden="true" className="mx-1 h-4 w-px flex-none bg-[var(--border-subtle)]" />;
}

/**
 * 笔记编辑器的格式条：固定在笔记顶部，放 Markdown 编辑器的常用操作。
 * Markdown 语法照样能直接敲（# 标题、- 列表、[ ] 待办、> 引用、``` 代码块、--- 分隔线）。
 *
 * 光标在表格或链接里时，旁边再浮出对应的小条（行列操作 / 打开、修改、去掉链接）。
 */
export function NotesToolbar({
  editor,
  onInsertImages,
  onCaptureFrame,
  imageBusy,
}: {
  editor: Editor;
  onInsertImages: (files: File[]) => void;
  onCaptureFrame: () => void;
  imageBusy: boolean;
}) {
  const { t } = useTranslation();
  const fileRef = useRef<HTMLInputElement>(null);
  const [linkDraft, setLinkDraft] = useState<string | null>(null);
  const [touch] = useState(coarsePointer);
  const state = useEditorState({
    editor,
    selector: ({ editor: current }) => ({
      block: blockType(current),
      bold: current.isActive("bold"),
      italic: current.isActive("italic"),
      strike: current.isActive("strike"),
      code: current.isActive("code"),
      link: current.isActive("link"),
      href: String(current.getAttributes("link").href ?? ""),
      bulletList: current.isActive("bulletList"),
      orderedList: current.isActive("orderedList"),
      taskList: current.isActive("taskList"),
      blockquote: current.isActive("blockquote"),
      codeBlock: current.isActive("codeBlock"),
      table: current.isActive("table"),
      canUndo: can(current, "undo"),
      canRedo: can(current, "redo"),
    }),
  });

  const run = (command: ChainCommand) => command(editor.chain().focus()).run();

  // 不常用的收进「⋯」：常驻的只留写笔记最高频的几样，窄面板里一行放得下。
  const [moreOpen, setMoreOpen] = useState(false);
  const moreRef = useRef<HTMLDivElement>(null);
  const moreTriggerRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!moreOpen) return;
    const close = (event: PointerEvent) => {
      if (!moreRef.current?.contains(event.target as Node)) setMoreOpen(false);
    };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, [moreOpen]);
  const moreItems: {
    icon: LucideIcon;
    label: string;
    command: ChainCommand;
    active?: boolean;
    disabled?: boolean;
  }[] = [
    { icon: Strikethrough, label: t("notesToolbar.strike"), active: state.strike, command: (c) => c.toggleStrike() },
    { icon: Code, label: t("notesToolbar.code"), active: state.code, command: (c) => c.toggleCode() },
    { icon: Quote, label: t("notesToolbar.blockquote"), active: state.blockquote, command: (c) => c.toggleBlockquote() },
    { icon: SquareCode, label: t("notesToolbar.codeBlock"), active: state.codeBlock, command: (c) => c.toggleCodeBlock() },
    { icon: Minus, label: t("notesToolbar.divider"), command: (c) => c.setHorizontalRule() },
    {
      icon: TableIcon,
      label: t("notesToolbar.tableInsert"),
      disabled: state.table,
      command: (c) => c.insertTable({ rows: 3, cols: 3, withHeaderRow: true }),
    },
  ];
  const moreActive = moreItems.some((item) => item.active);

  function openLinkEditor() {
    setLinkDraft(state.href);
  }

  function applyLink(event: FormEvent) {
    event.preventDefault();
    const href = normalizeLinkHref(linkDraft ?? "");
    const chain = editor.chain().focus().extendMarkRange("link");
    if (href) {
      if (editor.state.selection.empty && !state.link) {
        // 没选中文字：把网址本身作为链接文字插进去。
        chain.insertContent({ type: "text", text: href, marks: [{ type: "link", attrs: { href } }] }).run();
      } else {
        chain.setLink({ href }).run();
      }
    } else {
      chain.unsetLink().run();
    }
    setLinkDraft(null);
  }

  const blockOptions: { value: BlockType; label: string }[] = [
    { value: "paragraph", label: t("notesToolbar.paragraph") },
    { value: "h1", label: t("notesToolbar.heading1") },
    { value: "h2", label: t("notesToolbar.heading2") },
    { value: "h3", label: t("notesToolbar.heading3") },
  ];

  return (
    <>
      <div role="toolbar" aria-label={t("notesToolbar.label")} className="flex min-w-0 flex-1 items-center">
      {/* 放不下时（手机竖屏）横向滑动；「更多」菜单在滑动区外面，弹出时不会被裁掉。 */}
      <div className="ca-notes-toolbar flex min-w-0 items-center gap-0.5 overflow-x-auto">
        <GhostSelect
          aria-label={t("notesToolbar.blockType")}
          value={state.block}
          options={blockOptions}
          onChange={(value) =>
            run((chain) =>
              value === "paragraph"
                ? chain.setParagraph()
                : chain.setHeading({ level: Number(value.slice(1)) as 1 | 2 | 3 }),
            )
          }
          className="min-w-[4.5rem] justify-between"
        />
        <Divider />
        <Tool icon={Bold} label={t("notesToolbar.bold")} active={state.bold} onRun={() => run((c) => c.toggleBold())} />
        <Tool icon={Italic} label={t("notesToolbar.italic")} active={state.italic} onRun={() => run((c) => c.toggleItalic())} />
        <Tool icon={Link2} label={t("notesToolbar.link")} active={state.link || linkDraft !== null} onRun={openLinkEditor} />
        <Divider />
        <Tool icon={List} label={t("notesToolbar.bulletList")} active={state.bulletList} onRun={() => run((c) => c.toggleBulletList())} />
        <Tool icon={ListOrdered} label={t("notesToolbar.orderedList")} active={state.orderedList} onRun={() => run((c) => c.toggleOrderedList())} />
        <Tool icon={ListChecks} label={t("notesToolbar.taskList")} active={state.taskList} onRun={() => run((c) => c.toggleTaskList())} />
        <Divider />
        <Tool icon={ImagePlus} label={t("notesToolbar.image")} disabled={imageBusy} onRun={() => fileRef.current?.click()} />
        <Tool icon={Camera} label={t("notesToolbar.captureFrame")} disabled={imageBusy} onRun={onCaptureFrame} />
        {/* 触屏上没有 ⌘Z，撤销 / 重做要有按钮。 */}
        {touch && (
          <>
            <Divider />
            <Tool icon={Undo2} label={t("notesToolbar.undo")} disabled={!state.canUndo} onRun={() => run((c) => c.undo())} />
            <Tool icon={Redo2} label={t("notesToolbar.redo")} disabled={!state.canRedo} onRun={() => run((c) => c.redo())} />
          </>
        )}
      </div>
        <div ref={moreRef} className="relative flex-none">
          <button
            ref={moreTriggerRef}
            type="button"
            aria-label={t("notesToolbar.more")}
            title={t("notesToolbar.more")}
            aria-haspopup="menu"
            aria-expanded={moreOpen}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => setMoreOpen((open) => !open)}
            className={toolClass(moreOpen || moreActive)}
          >
            <MoreHorizontal className="h-4 w-4" />
          </button>
          {moreOpen && (
            <Menu
              aria-label={t("notesToolbar.more")}
              triggerRef={moreTriggerRef}
              onClose={() => setMoreOpen(false)}
              className="absolute right-0 top-full z-30 mt-1 min-w-[10rem]"
            >
              {moreItems.map(({ icon: Icon, label, active, disabled, command }) => (
                <MenuItem
                  key={label}
                  disabled={disabled}
                  onClick={() => {
                    setMoreOpen(false);
                    run(command);
                  }}
                  className={cn("flex items-center gap-2", active && "text-[var(--accent-text)]")}
                >
                  <Icon className="h-3.5 w-3.5 flex-none" />
                  <span className="flex-1">{label}</span>
                  {active && <Check aria-hidden="true" className="h-3.5 w-3.5 flex-none" />}
                </MenuItem>
              ))}
            </Menu>
          )}
        </div>
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          multiple
          hidden
          onChange={(event) => {
            const files = imageFiles(event.target.files);
            event.target.value = "";
            if (files.length) onInsertImages(files);
          }}
        />
      </div>

      {linkDraft !== null && (
        <form
          onSubmit={applyLink}
          className="ca-notes-link-form absolute inset-x-0 top-full z-20 flex items-center gap-2 border-b border-[var(--border-subtle)] bg-[var(--surface-panel)] px-3 py-2 shadow-[var(--shadow-pop)]"
        >
          <input
            autoFocus
            type="url"
            inputMode="url"
            aria-label={t("notesToolbar.linkAddress")}
            placeholder="https://"
            value={linkDraft}
            onChange={(event) => setLinkDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                setLinkDraft(null);
                editor.commands.focus();
              }
            }}
            className="min-w-0 flex-1 rounded-md border border-[var(--border-subtle)] bg-[var(--surface-input)] px-2 py-1 text-sm text-[var(--text-strong)] outline-none focus-visible:border-[var(--accent-text)]"
          />
          <button
            type="submit"
            className="ca-touch-44 flex-none rounded-md px-2 py-1 text-sm font-medium text-[var(--accent-text)] hover:bg-[var(--surface-card-hover)]"
          >
            {t("notesToolbar.linkApply")}
          </button>
          <button
            type="button"
            onClick={() => {
              setLinkDraft(null);
              editor.commands.focus();
            }}
            className="ca-touch-44 flex-none rounded-md px-2 py-1 text-sm text-[var(--text-muted)] hover:bg-[var(--surface-card-hover)]"
          >
            {t("notesToolbar.linkCancel")}
          </button>
        </form>
      )}

      <BubbleMenu
        editor={editor}
        pluginKey="notesLinkMenu"
        shouldShow={({ editor: current, state: view }) =>
          current.isEditable && view.selection.empty && current.isActive("link")
        }
        className="flex max-w-[min(360px,90vw)] items-center gap-0.5 rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-panel)] p-1 shadow-[var(--shadow-pop)]"
      >
        <span className="min-w-0 flex-1 truncate px-1.5 text-xs text-[var(--text-muted)]">{state.href}</span>
        <Tool
          icon={ExternalLink}
          label={t("notesToolbar.linkOpen")}
          onRun={() => {
            const href = normalizeLinkHref(state.href);
            if (href) void openUrl(href);
          }}
        />
        <button
          type="button"
          onMouseDown={(event) => event.preventDefault()}
          onClick={openLinkEditor}
          className="ca-touch-44 flex-none rounded-md px-2 py-1 text-xs text-[var(--text-normal)] hover:bg-[var(--surface-card-hover)]"
        >
          {t("notesToolbar.linkEdit")}
        </button>
        <button
          type="button"
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => run((c) => c.extendMarkRange("link").unsetLink())}
          className="ca-touch-44 flex-none rounded-md px-2 py-1 text-xs text-[var(--text-normal)] hover:bg-[var(--surface-card-hover)]"
        >
          {t("notesToolbar.linkRemove")}
        </button>
      </BubbleMenu>

      <BubbleMenu
        editor={editor}
        pluginKey="notesTableMenu"
        shouldShow={({ editor: current }) => current.isEditable && current.isActive("table")}
        className="flex items-center gap-0.5 rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-panel)] p-1 shadow-[var(--shadow-pop)]"
      >
        {TABLE_ACTIONS.map(([key, command]) => (
          <button
            key={key}
            type="button"
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => run(command)}
            className={cn(
              "ca-touch-44 flex-none whitespace-nowrap rounded-md px-2 py-1 text-xs hover:bg-[var(--surface-card-hover)]",
              key === "tableDelete" ? "text-[var(--status-err)]" : "text-[var(--text-normal)]",
            )}
          >
            {t(`notesToolbar.${key}`)}
          </button>
        ))}
      </BubbleMenu>
    </>
  );
}
