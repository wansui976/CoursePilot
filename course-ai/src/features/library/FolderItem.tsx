import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Check, Folder as FolderIcon, FolderInput, MoreHorizontal, Pencil, Trash2, X } from "lucide-react";
import type { CourseColor, Folder } from "@/lib/types";
import { IconButton } from "@/ui/icon-button";
import { Menu, MenuItem } from "@/ui/menu";
import { cn } from "@/lib/utils";
import { ColorSwatches } from "./ColorSwatches";
import { colorStyle } from "./colorStyle";

export type FolderActions = {
  onOpen: () => void;
  onStartRename: () => void;
  /** 提交改名；null = 取消。 */
  onFinishRename: (name: string | null) => void;
  onColor: (color: CourseColor | null) => void;
  onMove: () => void;
  onDelete: () => void;
};

/**
 * 课程页里的一个文件夹：网格里是一张卡（与视频卡同宽同高，网格对得齐），列表里是一行。
 * 点开进入文件夹；「⋯」菜单：重命名、颜色、移动到…、删除。拖动视频悬停其上时高亮为放置目标。
 */
export function FolderItem({
  folder,
  count,
  layout,
  dropTarget,
  renaming,
  actions,
}: {
  folder: Folder;
  /** 文件夹里（含子文件夹）的视频数。 */
  count: number;
  layout: "grid" | "list";
  dropTarget: boolean;
  renaming: boolean;
  actions: FolderActions;
}) {
  const { t } = useTranslation();
  const [menuOpen, setMenuOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  // 点菜单和「⋯」之外的任意位置即收起（与视频卡菜单同一做法）。
  useEffect(() => {
    if (!menuOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest("[data-folder-menu]")) return;
      setMenuOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [menuOpen]);
  const icon = (size: string) => (
    <FolderIcon
      aria-hidden="true"
      className={cn(size, "ca-folder-icon")}
      data-color={folder.color ?? undefined}
      style={colorStyle(folder.color)}
    />
  );
  const countText = t("folders.videoCount", { count });

  const body = renaming ? (
    <FolderRenameField folder={folder} onDone={actions.onFinishRename} />
  ) : layout === "grid" ? (
    <button
      type="button"
      className="block w-full text-left"
      aria-label={t("folders.open", { name: folder.name })}
      onClick={actions.onOpen}
    >
      <span className="ca-thumb ca-folder-thumb">{icon("h-11 w-11")}</span>
      <span className="ca-card-body">
        <span className="ca-card-title">{folder.name}</span>
        <span className="ca-card-meta">
          <span className="ca-meta-text">{countText}</span>
        </span>
      </span>
    </button>
  ) : (
    <button
      type="button"
      className="row-button"
      aria-label={t("folders.open", { name: folder.name })}
      onClick={actions.onOpen}
    >
      <span className="row-main">
        <span className="row-thumb ca-folder-thumb">{icon("h-5 w-5")}</span>
        <span className="row-name">
          <span className="t">{folder.name}</span>
          <span className="s">{countText}</span>
        </span>
      </span>
      <span className="c-progress">{countText}</span>
      <span className="c-dur" />
    </button>
  );

  return (
    <article
      className={cn(layout === "grid" ? "ca-card" : "ca-row", "ca-folder group relative")}
      data-drop-target={dropTarget || undefined}
    >
      {body}
      {!renaming && (
        <IconButton
          ref={triggerRef}
          type="button"
          aria-label={t("folders.actions")}
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          data-folder-menu
          className={cn(
            "ca-touch-44 ca-card-more absolute h-7 w-7 rounded-full",
            layout === "grid" ? "right-3 top-3" : "right-3 top-1/2 -translate-y-1/2",
          )}
          // 拖动传感器从 pointerdown 起算：从「⋯」起手不该拖动整个文件夹。
          onPointerDown={(event) => event.stopPropagation()}
          onClick={() => setMenuOpen((open) => !open)}
        >
          <MoreHorizontal className="h-3.5 w-3.5" />
        </IconButton>
      )}
      {menuOpen && (
        <Menu
          aria-label={t("folders.actions")}
          data-folder-menu
          className={cn("absolute right-3 z-10 w-48", layout === "grid" ? "top-12" : "top-full")}
          onClose={() => setMenuOpen(false)}
          triggerRef={triggerRef}
          onPointerDown={(event) => event.stopPropagation()}
        >
          <MenuItem
            className="ca-touch-44 flex items-center gap-2"
            onClick={() => {
              setMenuOpen(false);
              actions.onStartRename();
            }}
          >
            <Pencil aria-hidden="true" className="h-4 w-4 flex-none text-[var(--text-3)]" />
            {t("folders.rename")}
          </MenuItem>
          <ColorSwatches
            value={folder.color}
            onChange={(color) => {
              setMenuOpen(false);
              triggerRef.current?.focus();
              actions.onColor(color);
            }}
          />
          <MenuItem
            className="ca-touch-44 flex items-center gap-2"
            onClick={() => {
              setMenuOpen(false);
              actions.onMove();
            }}
          >
            <FolderInput aria-hidden="true" className="h-4 w-4 flex-none text-[var(--text-3)]" />
            {t("folders.moveTo")}
          </MenuItem>
          <MenuItem
            tone="danger"
            className="ca-touch-44 mt-1 flex items-center gap-2 border-t border-[var(--border-subtle)] pt-2.5"
            onClick={() => {
              setMenuOpen(false);
              actions.onDelete();
            }}
          >
            <Trash2 aria-hidden="true" className="h-4 w-4 flex-none" />
            {t("folders.delete")}
          </MenuItem>
        </Menu>
      )}
    </article>
  );
}

/** 就地改名框：Enter 保存、Esc 取消、失焦保存。空名不提交。 */
function FolderRenameField({
  folder,
  onDone,
}: {
  folder: Folder;
  onDone: (name: string | null) => void;
}) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState(folder.name);
  const settled = useRef(false);
  const finish = (name: string | null) => {
    if (settled.current) return;
    settled.current = true;
    onDone(name);
  };
  return (
    <div className="ca-folder-rename" role="group" aria-label={t("folders.rename")}>
      <input
        aria-label={t("folders.name")}
        autoFocus
        onFocus={(event) => event.currentTarget.select()}
        className="min-h-11 w-full rounded border border-[var(--accent-text)] bg-[var(--surface-input)] px-2 py-1.5 text-sm text-[var(--text-strong)] outline-none"
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={() => finish(draft.trim() || null)}
        onKeyDown={(event) => {
          if (event.key === "Enter") finish(draft.trim() || null);
          if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            finish(null);
          }
        }}
      />
      <div className="mt-2 flex justify-end gap-1">
        <button
          type="button"
          aria-label={t("home.cancelEdit")}
          className="ca-touch-44 flex h-7 w-7 items-center justify-center rounded text-[var(--text-muted)] hover:bg-[var(--surface-card-hover)]"
          // mousedown 先于输入框失焦：不拦的话失焦会先把草稿保存掉。
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => finish(null)}
        >
          <X className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          aria-label={t("home.saveTitle")}
          className="ca-touch-44 flex h-7 w-7 items-center justify-center rounded border border-[var(--border-subtle)] bg-[var(--surface-card)] text-[var(--text-strong)] hover:bg-[var(--surface-card-hover)] disabled:opacity-50"
          disabled={!draft.trim()}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => finish(draft.trim() || null)}
        >
          <Check className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );
}
