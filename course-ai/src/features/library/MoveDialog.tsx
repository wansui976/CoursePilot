import { useQuery } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Folder as FolderIcon, FolderOpen, Loader2 } from "lucide-react";
import { queries } from "@/lib/queries";
import type { Folder, ItemRef } from "@/lib/types";
import { Modal } from "@/ui/dialog";
import { Button } from "@/ui/button";
import { Select } from "@/ui/select";
import { ErrorNote } from "@/ui/ErrorNote";
import { cn } from "@/lib/utils";
import { colorStyle } from "./colorStyle";
import { childFolders, subtreeFolderIds } from "./folderTree";

export type MoveTarget = { courseId: string; folderId: string | null };

/**
 * 「移动到…」：先选课程，再在它的文件夹树里选一层（课程根目录也算一层）。
 * 被移动的文件夹自己和它下面的层不能选（不能把文件夹放进自己里面）；当前所在层也不能选。
 */
export function MoveDialog({
  open,
  items,
  from,
  pending,
  error,
  onCancel,
  onConfirm,
}: {
  open: boolean;
  items: ItemRef[];
  from: MoveTarget;
  pending: boolean;
  error: unknown;
  onCancel: () => void;
  onConfirm: (target: MoveTarget) => void;
}) {
  const { t } = useTranslation();
  const { data: courses = [] } = useQuery(queries.courses());
  const [courseId, setCourseId] = useState(from.courseId);
  const [target, setTarget] = useState<MoveTarget | null>(null);
  const { data: folders = [], isPending } = useQuery(queries.folders(courseId));
  const { data: sourceFolders = [] } = useQuery(queries.folders(from.courseId));

  // 同课程时，被移动文件夹的整棵子树都不能作为目标。
  const blocked = new Set<string>();
  if (courseId === from.courseId) {
    for (const item of items) {
      if (item.kind === "folder") {
        for (const id of subtreeFolderIds(sourceFolders, item.id)) blocked.add(id);
      }
    }
  }
  const isCurrent = (folderId: string | null) =>
    courseId === from.courseId && folderId === from.folderId;
  const chosen = (folderId: string | null) =>
    target?.courseId === courseId && target.folderId === folderId;

  function renderLevel(parentId: string | null, depth: number): ReactNode {
    return childFolders(folders, parentId).map((folder: Folder) => {
      const disabled = blocked.has(folder.id);
      return (
        <li key={folder.id}>
          <button
            type="button"
            role="radio"
            aria-checked={chosen(folder.id)}
            disabled={disabled || isCurrent(folder.id)}
            className={cn("ca-move-option", chosen(folder.id) && "on")}
            style={{ paddingLeft: 12 + depth * 18 }}
            onClick={() => setTarget({ courseId, folderId: folder.id })}
          >
            <FolderIcon className="h-4 w-4 flex-none" style={colorStyle(folder.color)} aria-hidden="true" />
            <span className="truncate">{folder.name}</span>
            {isCurrent(folder.id) && <span className="ca-move-here">{t("folders.currentLevel")}</span>}
          </button>
          {!disabled && <ul>{renderLevel(folder.id, depth + 1)}</ul>}
        </li>
      );
    });
  }

  const count = items.length;
  return (
    <Modal
      open={open}
      onOpenChange={(next) => !next && onCancel()}
      locked={pending}
      title={t("folders.moveTitle", { count })}
      size="lg"
    >
      <div className="flex flex-col gap-3">
        <label className="flex items-center gap-2 text-sm text-[var(--text-2)]">
          <span className="flex-none">{t("folders.moveCourse")}</span>
          <Select
            aria-label={t("folders.moveCourse")}
            className="min-w-0 flex-1"
            value={courseId}
            onChange={(event) => {
              setCourseId(event.target.value);
              setTarget(null);
            }}
          >
            {courses.map((course) => (
              <option key={course.id} value={course.id}>
                {course.name}
              </option>
            ))}
          </Select>
        </label>
        <div
          role="radiogroup"
          aria-label={t("folders.moveDestination")}
          className="ca-move-tree max-h-[320px] overflow-y-auto rounded-md border border-[var(--border-subtle)] py-1"
        >
          <ul>
            <li>
              <button
                type="button"
                role="radio"
                aria-checked={chosen(null)}
                disabled={isCurrent(null)}
                className={cn("ca-move-option", chosen(null) && "on")}
                style={{ paddingLeft: 12 }}
                onClick={() => setTarget({ courseId, folderId: null })}
              >
                <FolderOpen className="h-4 w-4 flex-none" aria-hidden="true" />
                <span className="truncate">{t("folders.courseRoot")}</span>
                {isCurrent(null) && <span className="ca-move-here">{t("folders.currentLevel")}</span>}
              </button>
            </li>
            {isPending ? (
              <li className="flex justify-center py-3" aria-label={t("common.loading")}>
                <Loader2 className="h-4 w-4 animate-spin text-[var(--text-faint)]" />
              </li>
            ) : (
              renderLevel(null, 1)
            )}
          </ul>
        </div>
        {error != null && <ErrorNote error={error} />}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onCancel} disabled={pending}>
            {t("common.cancel")}
          </Button>
          <Button onClick={() => target && onConfirm(target)} disabled={!target || pending}>
            {pending && <Loader2 className="h-4 w-4 animate-spin" />}
            {t("folders.moveHere")}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
