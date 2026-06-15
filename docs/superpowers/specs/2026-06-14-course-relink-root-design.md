# 课程「重新选择根目录」（重连视频文件）— 设计文档

**日期:** 2026-06-14
**应用:** course-ai（Tauri + React 前端 / Rust 后端）
**关联:** [[2026-06-14-homepage-cinematic-motion]] 等为官网；本设计是桌面/移动应用功能。

## 1. 背景与问题

每个视频在导入时把**绝对路径 `file_path`** 写进数据库（`videos.file_path`）。当用户把某课程目录下的视频移动到别处后，`file_path` 失效，`cmd_media_url` / 播放随之失败。课程本身有 `courses.root_path`（导入时选的文件夹）。

衍生数据 `videos.data_dir`：若设置了 `settings.default_storage_root` 则集中存放在应用数据区（稳定，不随视频移动失效）；否则默认是视频同级的 `.courseai/<video_id>`。本功能 **MVP 只解决「无法播放」**，即只修复 `file_path`，不处理 `data_dir`。

## 2. 目标 / 非目标

**目标：** 给课程提供「重新选择根目录」操作；选一个新文件夹后，按文件名把该课程下的视频重新对应到新位置，使其恢复播放，并把课程的 `root_path` 更新为新文件夹。

**非目标（MVP 不做）：**
- 单个视频「重新定位文件」（未来可加）。
- 恢复/重指 `data_dir` 等衍生数据（字幕、笔记、课件等）。
- 移动端文件夹选择的新交互（复用现有 `pickDirectoryPath`）。

## 3. 关键决策（已与用户确认）

| 决策点 | 选择 |
| --- | --- |
| 入口与粒度 | 按课程：课程「⋯」菜单加「重新选择根目录」 |
| 匹配方式 | 按**文件名**、在所选文件夹及其**子目录递归**查找 |
| 文件名比较 | **大小写不敏感**的 basename 相等 |
| 恢复范围 | 仅更新 `file_path`（恢复播放）；同时更新 `courses.root_path` |
| 同名多份 | 不改该视频，记为「歧义跳过」，在结果里列出 |
| 找不到 | 不改该视频，记为「缺失」，在结果里列出 |

## 4. 架构

一个新后端命令 + 课程菜单里的一个文件夹选择入口。**无数据库 schema 变更。**

```
课程「⋯」菜单 →「重新选择根目录」
  → pickDirectoryPath() 选新文件夹
  → ipc.courses.relinkRoot(courseId, newRoot)
  → cmd_relink_course_root（Rust）
       1. UPDATE courses SET root_path=?, updated_at=?
       2. 读取该课程未删除视频 (id,title,file_path)
       3. 递归扫描 newRoot，按 basename(大小写不敏感) 建索引
       4. 逐个视频匹配 → 唯一命中则 UPDATE videos.file_path
       5. 返回 { total, relinked, ambiguous[], missing[] }
  → 前端失效 ["videos",courseId] / ["courses"] / 媒体地址缓存
  → 弹出结果摘要
  → 重新打开视频 → cmd_media_url 解析到新路径 → 播放
```

## 5. 组件（单一职责）

### 5.1 纯匹配函数（Rust，可单测，不碰文件系统）
- **做什么：** 给定「视频列表（id/title/原 basename）」与「扫描到的文件绝对路径列表」，产出每个视频的匹配结果。
- **签名（示意）：**
  ```rust
  struct VideoKey { id: String, title: String, basename_lower: String }
  enum MatchOutcome { Relinked(String /*new abs path*/), Ambiguous, Missing }
  fn match_videos_to_files(videos: &[VideoKey], scanned: &[PathBuf])
      -> Vec<(String /*video id*/, MatchOutcome)>
  ```
- **规则：** 对每个扫描文件取 basename 转小写归入 `HashMap<String, Vec<PathBuf>>`；视频 basename_lower 命中 1 个→Relinked；命中 >1→Ambiguous；0→Missing。
- **依赖：** 仅标准库。

### 5.2 目录递归扫描（Rust）
- **做什么：** 递归遍历 `new_root`，返回所有普通文件的绝对路径（可只保留目标 basename 集合内的，做性能优化）。
- **约束：** `new_root` 不是可读目录 → 返回 `AppError`；跳过无权限的子项不致命（best-effort，但根目录不可读要报错）。

### 5.3 命令 `cmd_relink_course_root`（Rust，`commands/courses.rs`）
- **做什么：** 编排 5.1/5.2 + 数据库更新，返回结果摘要。
- **怎么用：** `invoke("cmd_relink_course_root", { courseId, newRoot })`。
- **返回：**
  ```rust
  #[derive(Serialize)]
  struct RelinkResult {
      total: usize,
      relinked: usize,
      ambiguous: Vec<String>, // 视频标题
      missing: Vec<String>,   // 视频标题
  }
  ```
- **事务：** root_path 更新与各 file_path 更新放在同一事务里，避免半更新。
- **注册：** 在 `lib.rs` 的 `invoke_handler` 注册。

### 5.4 ipc 封装（`src/lib/ipc.ts`）
- 新增 `courses.relinkRoot(courseId, newRoot): Promise<RelinkResult>` 与 `RelinkResult` 类型（字段同上）。

### 5.5 课程菜单入口（`src/components/CourseSidebar.tsx`）
- 在每个课程的「⋯」菜单（现有「重命名 / 删除」旁）加「重新选择根目录」。
- 点击：`pickDirectoryPath(["courses", course.name])`（与新建课程一致；返回 `null` 表示取消，则不动作）→ `useMutation` 调 `ipc.courses.relinkRoot`。
- 成功后：`invalidateQueries(["videos", courseId])`、`["courses"]`、媒体地址缓存 `["media-url"]`，并用对话框 `message()` 弹出摘要：「已重连 N 个；缺失 M 个；重名跳过 K 个」。
- 失败：复用现有 `ErrorNote` / 错误提示路径。

## 6. 数据流 / 状态

- 输入：courseId、用户所选 newRoot。
- 持久化：`courses.root_path`、命中的 `videos.file_path`（同一事务）。
- 前端缓存失效后，播放器的 `["media-url", videoId]` 重新查询 → 解析到新 `file_path`。
- 无新增全局状态。

## 7. 错误处理与边界

- `new_root` 不存在/不是目录/不可读 → `AppError`，前端提示。
- 0 命中 → 摘要显示「已重连 0」，并说明文件名未匹配（提示用户文件名是否被改过）。
- 同名多份 → 不改，列入 `ambiguous`（留给未来「单视频重定位」处理）。
- 命中文件存在但损坏 → 不在本功能范围（播放阶段另有处理）。
- 取消选择文件夹（picker 返回 null）→ 无操作。

## 8. 测试 / 验收

**Rust（`commands/courses.rs` 内 `#[cfg(test)]`）：**
1. `match_videos_to_files` 单测：构造 a.mp4 唯一命中→Relinked；b.mp4 无→Missing；c.mp4 两处同名→Ambiguous；大小写不同（A.MP4 vs a.mp4）应命中。
2. 集成测：用 `tempdir`（沿用 `db.rs` 既有模式）建库 + 课程 + 两个视频（basenames a.mp4/b.mp4），新建临时目录在**子文件夹**放 a.mp4；调用命令逻辑后断言：a 的 `file_path` 指向新子路径、b 记为缺失、`courses.root_path` 已更新、返回摘要 `relinked=1, missing=[b]`。

**前端（`CourseSidebar.test.tsx`）：**
3. 课程「⋯」菜单展开后存在「重新选择根目录」项。
4. 点击后调用 `pickDirectoryPath`，并以 `(courseId, 所选目录)` 调用 `ipc.courses.relinkRoot`；返回结果后触发查询失效（mock ipc 验证调用参数）。

**手动验收：** 移动某课程视频到新文件夹 → 菜单重选该文件夹 → 摘要显示重连数 → 打开视频可正常播放。

## 9. 文件清单

- `src-tauri/src/commands/courses.rs` — 匹配函数 + 扫描 + `cmd_relink_course_root` + `RelinkResult` + 测试。
- `src-tauri/src/lib.rs` — 注册命令。
- `src/lib/ipc.ts` — `courses.relinkRoot` + 类型。
- `src/components/CourseSidebar.tsx` — 菜单项 + mutation + 选择器 + 结果提示。
- `src/components/CourseSidebar.test.tsx` — 前端测试。

## 10. 后续（非本次）

- 单个视频「重新定位文件」（处理 ambiguous / 个别缺失）。
- 衍生数据 `data_dir` 跟随移动时的重指。
- 自动探测：打开课程时若大量 `file_path` 失效，主动提示「重新选择根目录」。
