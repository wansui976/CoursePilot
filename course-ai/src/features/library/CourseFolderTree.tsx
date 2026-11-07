import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { ChevronRight, Folder as FolderIcon } from "lucide-react";
import { queries } from "@/lib/queries";
import { cn } from "@/lib/utils";
import { colorStyle } from "./colorStyle";
import { childFolders } from "./folderTree";

/** 展开 / 收起的小箭头。占一个固定宽度的槽，没有子项时留空保持对齐。 */
export function Disclosure({
  label,
  expanded,
  onToggle,
}: {
  label: string;
  expanded: boolean;
  onToggle: () => void;
}) {
  const { t } = useTranslation();
  return (
    <button
      type="button"
      className="ca-nav-disclosure"
      aria-expanded={expanded}
      aria-label={expanded ? t("folders.collapse", { name: label }) : t("folders.expand", { name: label })}
      // 课程行可以拖动排序：从箭头起手不算拖。
      onMouseDown={(event) => event.stopPropagation()}
      onTouchStart={(event) => event.stopPropagation()}
      onClick={(event) => {
        event.stopPropagation();
        onToggle();
      }}
    >
      <ChevronRight className={cn("h-3.5 w-3.5 transition-transform", expanded && "rotate-90")} />
    </button>
  );
}

/** 课程下面的文件夹树（侧栏）。点文件夹即在课程页打开它。 */
export function CourseFolderTree({
  courseId,
  selectedFolderId,
  expanded,
  onToggle,
  onOpen,
}: {
  courseId: string;
  /** 课程页当前打开的文件夹（仅当这门课是选中课程时）。 */
  selectedFolderId: string | null;
  expanded: Set<string>;
  onToggle: (id: string) => void;
  onOpen: (folderId: string) => void;
}) {
  const { t } = useTranslation();
  const { data: folders = [] } = useQuery(queries.folders(courseId));

  function level(parentId: string | null, depth: number) {
    return childFolders(folders, parentId).map((folder) => {
      const hasChildren = folders.some((child) => child.parent_id === folder.id);
      const open = hasChildren && expanded.has(folder.id);
      const selected = folder.id === selectedFolderId;
      return (
        <li key={folder.id}>
          <div
            className={cn("ca-nav-item ca-nav-folder", selected && "active")}
            style={{ paddingLeft: depth * 14 }}
          >
            {hasChildren ? (
              <Disclosure label={folder.name} expanded={open} onToggle={() => onToggle(folder.id)} />
            ) : (
              <span className="ca-nav-disclosure" aria-hidden="true" />
            )}
            <button
              type="button"
              className="ca-nav-button"
              aria-current={selected ? "page" : undefined}
              onClick={() => onOpen(folder.id)}
            >
              <FolderIcon className="ic h-4 w-4" style={colorStyle(folder.color)} aria-hidden="true" />
              <span className="nm">{folder.name}</span>
            </button>
          </div>
          {open && <ul>{level(folder.id, depth + 1)}</ul>}
        </li>
      );
    });
  }

  return (
    <ul className="ca-nav-tree" aria-label={t("folders.treeLabel")}>
      {level(null, 1)}
    </ul>
  );
}
