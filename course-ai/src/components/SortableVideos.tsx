import {
  closestCenter,
  DndContext,
  PointerSensor,
  TouchSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  arrayMove,
  rectSortingStrategy,
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { ReactNode } from "react";

/** 计算拖放后的新顺序；没有实际移动或 id 不在列表里时返回 null（调用方跳过持久化）。 */
export function nextOrder(
  ids: string[],
  activeId: string,
  overId: string,
): string[] | null {
  if (activeId === overId) return null;
  const from = ids.indexOf(activeId);
  const to = ids.indexOf(overId);
  if (from < 0 || to < 0) return null;
  return arrayMove(ids, from, to);
}

/**
 * 视频库手动排序容器：网格 / 列表两种布局通用。
 * 拖放结束时回调该课程全部视频 id 的新顺序（后端要求完整列表，防过期覆盖）。
 */
export function SortableVideos({
  ids,
  layout,
  disabled = false,
  onReorder,
  children,
}: {
  ids: string[];
  layout: "grid" | "list";
  disabled?: boolean;
  onReorder: (orderedIds: string[]) => void;
  children: ReactNode;
}) {
  const sensors = useSensors(
    // 位移 8px 才进入拖拽：保住单击「打开视频」和菜单点击。
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    // 触屏长按 250ms 触发：与滚动手势不冲突。
    useSensor(TouchSensor, { activationConstraint: { delay: 250, tolerance: 5 } }),
  );

  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over) return;
    const ordered = nextOrder(ids, String(active.id), String(over.id));
    if (ordered) onReorder(ordered);
  }

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      onDragEnd={handleDragEnd}
    >
      <SortableContext
        items={ids}
        strategy={layout === "grid" ? rectSortingStrategy : verticalListSortingStrategy}
        disabled={disabled}
      >
        {children}
      </SortableContext>
    </DndContext>
  );
}

/** 单个可拖拽项：包住原有卡片/行，不改其内部结构。整卡即拖拽把手。 */
export function SortableVideoItem({
  id,
  children,
}: {
  id: string;
  children: ReactNode;
}) {
  const { listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id });
  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      // 拖动中的原位残影压暗提层，落点空隙由其余项的 transform 让出。
      className={isDragging ? "relative z-10 opacity-60" : undefined}
      {...listeners}
    >
      {children}
    </div>
  );
}
