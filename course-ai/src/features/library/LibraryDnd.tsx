import {
  closestCenter,
  DndContext,
  PointerSensor,
  pointerWithin,
  TouchSensor,
  useDroppable,
  useSensor,
  useSensors,
  type CollisionDetection,
  type DragEndEvent,
  type DragOverEvent,
} from "@dnd-kit/core";
import {
  arrayMove,
  rectSortingStrategy,
  SortableContext,
  verticalListSortingStrategy,
  type SortingStrategy,
} from "@dnd-kit/sortable";
import { useMemo, useState, type ReactNode } from "react";
import type { ItemRef } from "@/lib/types";
import { cn } from "@/lib/utils";
import { folderKey, parseKey, videoKey } from "./folderTree";

/**
 * 课程页（某一层）的拖放：
 * - 文件夹与文件夹之间、视频与视频之间拖动 = 排序（只让同类让位，文件夹卡不会被视频挤走）；
 * - 拖着视频松在文件夹卡上 = 移进该文件夹；
 * - 拖着任何一项松在面包屑的某一级上 = 移到那一层（往上移）。
 */
export function LibraryDnd({
  folderIds,
  videoIds,
  layout,
  disabled,
  onReorder,
  onMove,
  onTargetChange,
  children,
}: {
  folderIds: string[];
  videoIds: string[];
  layout: "grid" | "list";
  disabled: boolean;
  /** 同类拖动后这一层的新顺序（文件夹、视频各一份）。 */
  onReorder: (folderIds: string[], videoIds: string[]) => void;
  /** 移到某个文件夹（null = 课程根目录）。 */
  onMove: (item: ItemRef, folderId: string | null) => void;
  /** 当前悬停的放置目标（文件夹卡或面包屑的键），用来高亮；null = 没有。 */
  onTargetChange?: (key: string | null) => void;
  children: ReactNode;
}) {
  const sensors = useSensors(
    // 位移 8px 才进入拖拽：保住单击「打开」和菜单点击。
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    // 触屏长按 250ms 触发：与滚动手势不冲突。
    useSensor(TouchSensor, { activationConstraint: { delay: 250, tolerance: 5 } }),
  );
  const items = useMemo(
    () => [...folderIds.map(folderKey), ...videoIds.map(videoKey)],
    [folderIds, videoIds],
  );

  // 只让与被拖项同类的项让位；落点是异类（视频悬在文件夹上）时谁都不动。
  const strategy = useMemo<SortingStrategy>(() => {
    const base = layout === "grid" ? rectSortingStrategy : verticalListSortingStrategy;
    const kind = (index: number) => items[index]?.slice(0, 2);
    return (args) => {
      if (kind(args.activeIndex) !== kind(args.overIndex)) return null;
      if (kind(args.index) !== kind(args.activeIndex)) return null;
      return base(args);
    };
  }, [items, layout]);

  const collision = useMemo<CollisionDetection>(
    () => (args) => {
      const activeId = String(args.active.id);
      const pick = (prefix: string) =>
        args.droppableContainers.filter((container) => String(container.id).startsWith(prefix));
      const crumb = pointerWithin({ ...args, droppableContainers: pick("c:") });
      if (crumb.length) return crumb;
      if (activeId.startsWith("v:")) {
        const folder = pointerWithin({ ...args, droppableContainers: pick("f:") });
        if (folder.length) return folder;
      }
      return closestCenter({ ...args, droppableContainers: pick(activeId.slice(0, 2)) });
    },
    [],
  );

  const [activeKind, setActiveKind] = useState<string | null>(null);
  function reportTarget(event: DragOverEvent | DragEndEvent | null) {
    if (!onTargetChange) return;
    const over = event?.over ? String(event.over.id) : null;
    const active = event ? String(event.active.id) : null;
    // 只有「移进去」的落点才高亮：同类之间是排序，不是放进去。
    const isTarget =
      over !== null &&
      active !== null &&
      (over.startsWith("c:") || (over.startsWith("f:") && active.startsWith("v:")));
    onTargetChange(isTarget ? over : null);
  }

  function handleDragEnd(event: DragEndEvent) {
    setActiveKind(null);
    reportTarget(null);
    const { active, over } = event;
    if (!over) return;
    const from = parseKey(String(active.id));
    const to = parseKey(String(over.id));
    if (!from || from.kind === "crumb" || !to) return;
    if (to.kind === "crumb") {
      onMove({ kind: from.kind, id: from.id }, to.folderId);
      return;
    }
    if (from.kind === "video" && to.kind === "folder") {
      onMove({ kind: "video", id: from.id }, to.id);
      return;
    }
    if (from.kind !== to.kind || from.id === to.id) return;
    if (from.kind === "folder") {
      const next = arrayMove(folderIds, folderIds.indexOf(from.id), folderIds.indexOf(to.id));
      onReorder(next, videoIds);
    } else {
      const next = arrayMove(videoIds, videoIds.indexOf(from.id), videoIds.indexOf(to.id));
      onReorder(folderIds, next);
    }
  }

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={collision}
      onDragStart={(event) => setActiveKind(String(event.active.id).slice(0, 2))}
      onDragOver={reportTarget}
      onDragCancel={() => {
        setActiveKind(null);
        reportTarget(null);
      }}
      onDragEnd={handleDragEnd}
    >
      <SortableContext items={items} strategy={strategy} disabled={disabled}>
        <div data-dragging={activeKind ?? undefined} className="contents">
          {children}
        </div>
      </SortableContext>
    </DndContext>
  );
}

/** 面包屑里可以接住拖放的一级（往上移到这一层）。 */
export function DroppableCrumb({
  id,
  highlighted,
  children,
}: {
  id: string;
  highlighted: boolean;
  children: ReactNode;
}) {
  const { setNodeRef } = useDroppable({ id });
  return (
    <span ref={setNodeRef} className={cn("ca-crumb-drop", highlighted && "on")}>
      {children}
    </span>
  );
}
