# 视频拖拽排序 + 清空回收站 设计

日期：2026-07-10 · 状态：已批准

## 背景

- `videos.order_index` 已存在，`list_videos` 按其 ASC 排序，新导入取 MAX+1，但没有任何调整顺序的 UI。
- 回收站只有单条「彻底删除」（`purge_video`），没有批量清空。

## 功能一：视频拖拽排序

范围：课程视频库的网格视图与列表视图都可拖拽，含触屏（长按触发）。

### 技术选型

引入 `@dnd-kit/core` + `@dnd-kit/sortable`（原生 HTML5 drag 触屏不工作，手写 pointer 事件成本过高）。

### 后端

新增命令 `cmd_reorder_videos(course_id: String, ordered_ids: Vec<String>) -> AppResult<()>`：

- 事务内校验：`ordered_ids` 必须与该课程未删除视频的 id 集合完全一致（数量相同且全部匹配），否则报错回滚——防止并发导入/删除后按旧列表覆盖。
- 按数组顺序重写 `order_index = 0,1,2…`。
- `list_videos` 不变。

### 前端

- `ipc.videos.reorder(courseId, orderedIds)`。
- Home.tsx 视频容器包 `DndContext` + `SortableContext`；网格 `rectSortingStrategy`，列表 `verticalListSortingStrategy`。
- 卡片/行整体为拖拽把手：PointerSensor 位移 8px 激活（不干扰单击打开视频），TouchSensor 长按 250ms 激活（不与滚动冲突）。
- `onDragEnd`：乐观更新 `["videos", courseId]` 缓存顺序 → 调 reorder → 失败 invalidate 回滚并提示。
- 拖动中用 dnd-kit 默认浮影 + 空隙占位。

## 功能二：清空回收站

### 后端

新增 `cmd_purge_trash() -> AppResult<u64>`：查出全部 `deleted_at IS NOT NULL` 的视频，逐个执行现有 purge 逻辑（删数据目录 + 删行），返回清除数量。

### 前端

- `ipc.trash.purgeAll()`。
- RecycleBin header 右侧加「清空回收站」按钮（危险色、列表为空时不渲染）。
- 点击弹确认框：「清空回收站？共 N 个视频，此操作无法撤销。」确认后调用并刷新 trash/courses/videos 查询。

## 测试

- Rust：reorder 持久化新顺序；ordered_ids 不匹配时报错且顺序不变；purge_trash 清空全部并返回数量。
- 前端 vitest：拖放结束调用 reorder 且缓存顺序更新；清空按钮空列表不渲染、确认后调用 purgeAll。
