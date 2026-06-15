# 课程「重新选择根目录」实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给课程加「重新选择根目录」操作：选一个新文件夹后，按文件名（大小写不敏感、递归子目录）把该课程下的视频重新对应到新位置并更新 `courses.root_path`，使移动过的视频恢复播放。

**Architecture:** 新增一个 Rust 命令 `cmd_relink_course_root`（纯匹配函数 + 递归扫描 + 同事务更新 DB，返回摘要），前端在课程「⋯」菜单加入口，选目录后调用并刷新缓存、弹摘要。无数据库 schema 变更。

**Tech Stack:** Rust（tauri command、sqlx、tokio test、tempfile）、React + TypeScript（@tanstack/react-query、@tauri-apps/plugin-dialog、vitest + testing-library）。

---

## 不可破坏的约束

- 所有路径相对仓库根 `/workspace`。课程应用在 `course-ai/`。
- 前端测试可运行（本会话已把 rollup/esbuild 的 linux-arm64 原生二进制装进 `course-ai/node_modules`）。命令：`cd /workspace/course-ai && pnpm exec vitest run <file>`。
- Rust 测试命令：`cargo test --manifest-path course-ai/src-tauri/Cargo.toml courses`（首次编译 tauri 依赖较慢，属正常）。
- Tauri v2 会把前端 invoke 的 camelCase 键映射到 Rust 的 snake_case 参数（例：`courseId`→`course_id`），沿用现有 `cmd_create_course`（`rootPath`→`root_path`）惯例。
- 不改 schema，不动 `data_dir`/衍生数据（MVP 仅恢复播放）。

## 文件结构

- **Modify** `course-ai/src-tauri/src/commands/courses.rs` — 新增 `RelinkResult`、`VideoKey`、`MatchOutcome`、`match_videos_to_files`（纯函数）、`scan_files_recursive`、`relink_course_root`（核心）、`cmd_relink_course_root`（命令）+ 测试。
- **Modify** `course-ai/src-tauri/src/lib.rs` — 注册新命令。
- **Modify** `course-ai/src/lib/types.ts` — 新增 `RelinkResult` 类型。
- **Modify** `course-ai/src/lib/ipc.ts` — 新增 `courses.relinkRoot`。
- **Modify** `course-ai/src/components/CourseSidebar.tsx` — 菜单项 + mutation + 选择器 + 结果提示。
- **Modify** `course-ai/src/components/CourseSidebar.test.tsx` — 前端测试 + mock 扩展。

---

### Task 1: Rust 纯匹配函数 `match_videos_to_files`

**Files:**
- Modify: `course-ai/src-tauri/src/commands/courses.rs`（在 `#[cfg(test)] mod tests` 之前加类型与函数；在 `mod tests` 内加单测）

- [ ] **Step 1: 加类型与纯函数**

在 `courses.rs` 顶部 `use` 区补充（与现有 `use` 并列）：

```rust
use std::collections::HashMap;
use std::path::{Path, PathBuf};
```

在文件中（`rename_course` 之后、`#[tauri::command]` 包装之前的位置）加入：

```rust
#[derive(Debug, Clone, Serialize)]
pub struct RelinkResult {
    pub total: usize,
    pub relinked: usize,
    pub ambiguous: Vec<String>,
    pub missing: Vec<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub enum MatchOutcome {
    Relinked(PathBuf),
    Ambiguous,
    Missing,
}

pub struct VideoKey {
    pub id: String,
    pub title: String,
    pub basename_lower: String,
}

/// 按文件名（大小写不敏感）把视频对应到扫描出的文件：
/// 唯一命中 → Relinked(新绝对路径)；命中多份 → Ambiguous；没命中 → Missing。
pub fn match_videos_to_files(
    videos: &[VideoKey],
    scanned: &[PathBuf],
) -> Vec<(String, MatchOutcome)> {
    let mut by_name: HashMap<String, Vec<PathBuf>> = HashMap::new();
    for path in scanned {
        if let Some(name) = path.file_name().and_then(|n| n.to_str()) {
            by_name
                .entry(name.to_lowercase())
                .or_default()
                .push(path.clone());
        }
    }
    videos
        .iter()
        .map(|v| {
            let outcome = match by_name.get(&v.basename_lower) {
                Some(paths) if paths.len() == 1 => MatchOutcome::Relinked(paths[0].clone()),
                Some(_) => MatchOutcome::Ambiguous,
                None => MatchOutcome::Missing,
            };
            (v.id.clone(), outcome)
        })
        .collect()
}
```

- [ ] **Step 2: 写单测**

在 `courses.rs` 的 `#[cfg(test)] mod tests { ... }` 内追加：

```rust
    #[test]
    fn matcher_handles_unique_missing_ambiguous_and_case() {
        let videos = vec![
            VideoKey { id: "u".into(), title: "u".into(), basename_lower: "a.mp4".into() },
            VideoKey { id: "m".into(), title: "m".into(), basename_lower: "b.mp4".into() },
            VideoKey { id: "d".into(), title: "d".into(), basename_lower: "c.mp4".into() },
            VideoKey { id: "ci".into(), title: "ci".into(), basename_lower: "e.mp4".into() },
        ];
        let scanned = vec![
            PathBuf::from("/x/a.mp4"),
            PathBuf::from("/x/c.mp4"),
            PathBuf::from("/y/c.mp4"),
            PathBuf::from("/z/E.MP4"),
        ];
        let out = match_videos_to_files(&videos, &scanned);
        let get = |id: &str| out.iter().find(|(i, _)| i == id).unwrap().1.clone();
        assert_eq!(get("u"), MatchOutcome::Relinked(PathBuf::from("/x/a.mp4")));
        assert_eq!(get("m"), MatchOutcome::Missing);
        assert_eq!(get("d"), MatchOutcome::Ambiguous);
        assert_eq!(get("ci"), MatchOutcome::Relinked(PathBuf::from("/z/E.MP4")));
    }
```

- [ ] **Step 3: 运行单测，应通过**

Run: `cargo test --manifest-path course-ai/src-tauri/Cargo.toml courses::tests::matcher_handles`
Expected: `test ... matcher_handles_unique_missing_ambiguous_and_case ... ok`

- [ ] **Step 4: Commit**

```bash
git add course-ai/src-tauri/src/commands/courses.rs
git commit -m "feat(course-ai): add filename matcher for course relink"
```

---

### Task 2: Rust 递归扫描 + 核心 `relink_course_root`

**Files:**
- Modify: `course-ai/src-tauri/src/commands/courses.rs`（加 `scan_files_recursive`、`relink_course_root`；在 `mod tests` 加集成测）
- 依赖：`use crate::error::AppError;`（若文件未引入则补上）

- [ ] **Step 1: 确认 AppError 已可用**

`courses.rs` 顶部已 `use crate::error::AppResult;`。补充错误类型导入（与之并列）：

```rust
use crate::error::AppError;
```

- [ ] **Step 2: 加递归扫描与核心函数**

在 `match_videos_to_files` 之后加入：

```rust
/// 递归收集 root 下所有普通文件的绝对路径。root 不是可读目录 → 报错；
/// 子目录读不动则跳过（best-effort），不影响整体。
fn scan_files_recursive(root: &Path) -> AppResult<Vec<PathBuf>> {
    if !root.is_dir() {
        return Err(AppError::NotFound(format!(
            "不是有效目录: {}",
            root.display()
        )));
    }
    let mut out = Vec::new();
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                stack.push(path);
            } else if path.is_file() {
                out.push(path);
            }
        }
    }
    Ok(out)
}

/// 把课程根目录改到 new_root，并按文件名把该课程下的视频重连到新位置。
/// root_path 与命中的 file_path 在同一事务里更新。
pub async fn relink_course_root(
    db: &Db,
    course_id: &str,
    new_root: String,
) -> AppResult<RelinkResult> {
    let root = PathBuf::from(&new_root);
    let scanned = scan_files_recursive(&root)?;

    let videos: Vec<(String, String, String)> = sqlx::query_as(
        "SELECT id, title, file_path FROM videos
         WHERE course_id=? AND deleted_at IS NULL",
    )
    .bind(course_id)
    .fetch_all(&db.pool)
    .await?;

    let keys: Vec<VideoKey> = videos
        .iter()
        .map(|(id, title, fp)| VideoKey {
            id: id.clone(),
            title: title.clone(),
            basename_lower: Path::new(fp)
                .file_name()
                .and_then(|n| n.to_str())
                .map(|s| s.to_lowercase())
                .unwrap_or_default(),
        })
        .collect();

    let outcomes = match_videos_to_files(&keys, &scanned);
    let title_of: HashMap<&str, &str> =
        videos.iter().map(|(id, t, _)| (id.as_str(), t.as_str())).collect();

    let now = Utc::now().timestamp_millis();
    let mut tx = db.pool.begin().await?;
    sqlx::query("UPDATE courses SET root_path=?, updated_at=? WHERE id=?")
        .bind(&new_root)
        .bind(now)
        .bind(course_id)
        .execute(&mut *tx)
        .await?;

    let mut relinked = 0usize;
    let mut ambiguous = Vec::new();
    let mut missing = Vec::new();
    for (id, outcome) in &outcomes {
        match outcome {
            MatchOutcome::Relinked(path) => {
                sqlx::query("UPDATE videos SET file_path=? WHERE id=?")
                    .bind(path.to_string_lossy().to_string())
                    .bind(id)
                    .execute(&mut *tx)
                    .await?;
                relinked += 1;
            }
            MatchOutcome::Ambiguous => {
                ambiguous.push(title_of.get(id.as_str()).copied().unwrap_or("").to_string());
            }
            MatchOutcome::Missing => {
                missing.push(title_of.get(id.as_str()).copied().unwrap_or("").to_string());
            }
        }
    }
    tx.commit().await?;

    Ok(RelinkResult {
        total: outcomes.len(),
        relinked,
        ambiguous,
        missing,
    })
}
```

- [ ] **Step 3: 写集成测**

在 `mod tests` 内追加：

```rust
    #[tokio::test]
    async fn relink_updates_matched_paths_and_root() {
        let db = fresh_db().await;
        let course = create_course(&db, "ml".into(), "/old".into()).await.unwrap();
        for (vid, fp) in [("v1", "/old/a.mp4"), ("v2", "/old/b.mp4")] {
            sqlx::query(
                "INSERT INTO videos (id,course_id,title,source_type,file_path,data_dir,created_at)
                 VALUES (?,?,?,?,?,?,?)",
            )
            .bind(vid)
            .bind(&course.id)
            .bind(vid)
            .bind("local")
            .bind(fp)
            .bind("/old/.courseai")
            .bind(0i64)
            .execute(&db.pool)
            .await
            .unwrap();
        }

        let tmp = tempfile::tempdir().unwrap();
        let sub = tmp.path().join("sub");
        std::fs::create_dir_all(&sub).unwrap();
        std::fs::write(sub.join("a.mp4"), b"x").unwrap();

        let res = relink_course_root(
            &db,
            &course.id,
            tmp.path().to_string_lossy().to_string(),
        )
        .await
        .unwrap();

        assert_eq!(res.total, 2);
        assert_eq!(res.relinked, 1);
        assert_eq!(res.missing, vec!["v2".to_string()]);

        let a_path: String = sqlx::query_scalar("SELECT file_path FROM videos WHERE id='v1'")
            .fetch_one(&db.pool)
            .await
            .unwrap();
        assert_eq!(a_path, sub.join("a.mp4").to_string_lossy());

        let root: String = sqlx::query_scalar("SELECT root_path FROM courses WHERE id=?")
            .bind(&course.id)
            .fetch_one(&db.pool)
            .await
            .unwrap();
        assert_eq!(root, tmp.path().to_string_lossy());
    }
```

- [ ] **Step 4: 运行测试，应通过**

Run: `cargo test --manifest-path course-ai/src-tauri/Cargo.toml courses`
Expected: `relink_updates_matched_paths_and_root ... ok` 且 `matcher_handles_... ok`，其余 courses 测试不回归。

- [ ] **Step 5: Commit**

```bash
git add course-ai/src-tauri/src/commands/courses.rs
git commit -m "feat(course-ai): relink course videos by scanning a new root dir"
```

---

### Task 3: Rust 命令包装 + 注册

**Files:**
- Modify: `course-ai/src-tauri/src/commands/courses.rs`（加 `cmd_relink_course_root`）
- Modify: `course-ai/src-tauri/src/lib.rs`（导入 + 注册）

- [ ] **Step 1: 加命令包装**

在 `courses.rs` 的 `cmd_rename_course` 之后加入：

```rust
#[tauri::command]
pub async fn cmd_relink_course_root(
    state: State<'_, AppState>,
    course_id: String,
    new_root: String,
) -> AppResult<RelinkResult> {
    relink_course_root(&state.db, &course_id, new_root).await
}
```

- [ ] **Step 2: 在 lib.rs 导入命令**

`course-ai/src-tauri/src/lib.rs` 第 20 行当前为：

```rust
    cmd_create_course, cmd_delete_course, cmd_list_courses, cmd_rename_course, AppState,
```

改为：

```rust
    cmd_create_course, cmd_delete_course, cmd_list_courses, cmd_relink_course_root,
    cmd_rename_course, AppState,
```

- [ ] **Step 3: 在 invoke_handler 注册**

`lib.rs` 中 `tauri::generate_handler![` 列表里、`cmd_rename_course,`（第 81 行附近）之后加一行：

```rust
            cmd_relink_course_root,
```

- [ ] **Step 4: 编译并跑既有测试，确认无回归**

Run: `cargo test --manifest-path course-ai/src-tauri/Cargo.toml courses`
Expected: 全部通过（命令已能编译进 handler）。

- [ ] **Step 5: Commit**

```bash
git add course-ai/src-tauri/src/commands/courses.rs course-ai/src-tauri/src/lib.rs
git commit -m "feat(course-ai): register cmd_relink_course_root"
```

---

### Task 4: 前端 ipc 封装与类型

**Files:**
- Modify: `course-ai/src/lib/types.ts`（加 `RelinkResult`）
- Modify: `course-ai/src/lib/ipc.ts`（加 `courses.relinkRoot` + 导入类型）

- [ ] **Step 1: 加类型**

在 `course-ai/src/lib/types.ts` 末尾追加：

```ts
export interface RelinkResult {
  total: number;
  relinked: number;
  ambiguous: string[];
  missing: string[];
}
```

- [ ] **Step 2: ipc 导入类型**

`course-ai/src/lib/ipc.ts` 顶部的 `import type { ... } from "./types";` 列表里加入 `RelinkResult`（按字母位置插入，例如 `RagAnswer,` 之后）：

```ts
  RagAnswer,
  RelinkResult,
  Screenshot,
```

- [ ] **Step 3: 加 courses.relinkRoot**

`ipc.ts` 中 `courses: { ... }` 对象内、`rename:` 之后加入：

```ts
    relinkRoot: (courseId: string, newRoot: string): Promise<RelinkResult> =>
      invoke("cmd_relink_course_root", { courseId, newRoot }),
```

- [ ] **Step 4: 类型检查通过**

Run: `cd /workspace/course-ai && pnpm exec tsc --noEmit`
Expected: 无报错（无新增类型错误）。

- [ ] **Step 5: Commit**

```bash
git add course-ai/src/lib/types.ts course-ai/src/lib/ipc.ts
git commit -m "feat(course-ai): add courses.relinkRoot ipc binding"
```

---

### Task 5: 课程菜单入口 + 结果提示（含前端测试）

**Files:**
- Modify: `course-ai/src/components/CourseSidebar.tsx`
- Modify: `course-ai/src/components/CourseSidebar.test.tsx`

- [ ] **Step 1: 写失败的前端测试**

先扩展 `CourseSidebar.test.tsx` 的 mock：把 `mockIpc.courses` 里加 `relinkRoot: vi.fn()`，并把 plugin-dialog mock 加上 `message`。

在 `vi.hoisted(() => ({ mockIpc: { courses: { ... } } }))` 的 courses 对象里加一行 `relinkRoot: vi.fn(),`（与 list/create/rename/delete 并列）。

把第 22 行的 plugin-dialog mock：

```ts
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn(), confirm: vi.fn() }));
```

改为：

```ts
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn(), confirm: vi.fn(), message: vi.fn() }));
```

在 `beforeEach` 里补一条默认返回：

```ts
    mockIpc.courses.relinkRoot.mockResolvedValue({
      total: 2,
      relinked: 1,
      ambiguous: [],
      missing: ["b"],
    });
```

在 `describe` 末尾追加测试：

```tsx
  it("relinks a course root through the directory picker", async () => {
    mockIpc.courses.list.mockResolvedValue([{ id: "c1", name: "线性代数" }]);
    pickDirectoryPathMock.mockResolvedValue("/new/root");
    renderSidebar({ onToggleQueue: () => undefined });

    await screen.findByRole("button", { name: "线性代数" });
    fireEvent.click(screen.getByRole("button", { name: "课程操作" }));
    fireEvent.click(screen.getByRole("button", { name: "重新选择根目录" }));

    await waitFor(() =>
      expect(pickDirectoryPathMock).toHaveBeenCalledWith(["courses", "线性代数"]),
    );
    await waitFor(() =>
      expect(mockIpc.courses.relinkRoot).toHaveBeenCalledWith("c1", "/new/root"),
    );
  });
```

- [ ] **Step 2: 运行，确认新测试失败**

Run: `cd /workspace/course-ai && pnpm exec vitest run src/components/CourseSidebar.test.tsx`
Expected: 新用例失败（菜单里还没有「重新选择根目录」按钮 → `getByRole` 找不到）。

- [ ] **Step 3: 实现菜单项与 mutation**

`CourseSidebar.tsx` 第 1 行的 import：

```ts
import { confirm as confirmDialog } from "@tauri-apps/plugin-dialog";
```

改为：

```ts
import { confirm as confirmDialog, message as messageDialog } from "@tauri-apps/plugin-dialog";
```

在组件内（`remove` mutation 之后）加 mutation：

```tsx
  const relink = useMutation({
    mutationFn: ({ id, root }: { id: string; root: string }) =>
      ipc.courses.relinkRoot(id, root),
    onSuccess: async (res, { id }) => {
      await queryClient.invalidateQueries({ queryKey: ["courses"] });
      await queryClient.invalidateQueries({ queryKey: ["videos", id] });
      await queryClient.invalidateQueries({ queryKey: ["media-url"] });
      const lines = [`已重连 ${res.relinked}/${res.total} 个视频`];
      if (res.missing.length) lines.push(`缺失 ${res.missing.length} 个：${res.missing.join("、")}`);
      if (res.ambiguous.length)
        lines.push(`重名跳过 ${res.ambiguous.length} 个：${res.ambiguous.join("、")}`);
      await messageDialog(lines.join("\n"), { title: "重新选择根目录" });
    },
  });
```

在 `confirmDelete` 函数之后加处理函数：

```tsx
  async function handleRelinkRoot(id: string, name: string) {
    closeMenu();
    const dir = await pickDirectoryPath(["courses", name]);
    if (!dir) return;
    relink.mutate({ id, root: dir });
  }
```

在课程「⋯」下拉菜单里（`startRename` 的「重命名」按钮与「删除」按钮之间）插入：

```tsx
                  <button
                    onClick={() => void handleRelinkRoot(course.id, course.name)}
                    className="ca-touch-44 flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm text-[var(--text-normal)] hover:bg-[var(--surface-card-hover)]"
                  >
                    <FolderOpen className="h-3.5 w-3.5" />
                    重新选择根目录
                  </button>
```

（`FolderOpen` 已在第 4 行的 lucide-react import 中，无需新增。）

- [ ] **Step 4: 运行测试，应通过**

Run: `cd /workspace/course-ai && pnpm exec vitest run src/components/CourseSidebar.test.tsx`
Expected: 全部通过（含新用例）。

- [ ] **Step 5: 类型检查**

Run: `cd /workspace/course-ai && pnpm exec tsc --noEmit`
Expected: 无报错。

- [ ] **Step 6: Commit**

```bash
git add course-ai/src/components/CourseSidebar.tsx course-ai/src/components/CourseSidebar.test.tsx
git commit -m "feat(course-ai): add '重新选择根目录' menu action to relink moved videos"
```

---

## Self-Review 记录

- **Spec 覆盖：** §5.1 纯匹配→Task 1；§5.2 扫描 + §5.3 命令核心/事务/RelinkResult→Task 2/3；§5.4 ipc→Task 4；§5.5 菜单入口/picker/失效/摘要→Task 5；§8 测试→Task 1(单测)/2(集成)/5(前端)；§7 错误（非目录报错、缺失、歧义、取消）→Task 2(scan 报错、missing/ambiguous)、Task 5(picker 取消 `if (!dir) return`)。
- **Placeholder 扫描：** 无 TODO/TBD；每个代码步骤含完整代码。
- **命名一致：** `RelinkResult{total,relinked,ambiguous,missing}`、`MatchOutcome::{Relinked,Ambiguous,Missing}`、`VideoKey{id,title,basename_lower}`、`match_videos_to_files`、`scan_files_recursive`、`relink_course_root`、`cmd_relink_course_root`、`courses.relinkRoot`、`handleRelinkRoot`、菜单文案「重新选择根目录」在前后端一致；invoke 键 `courseId`/`newRoot` ↔ Rust `course_id`/`new_root` 与现有惯例一致。
- **YAGNI：** 不做单视频重定位、不动 data_dir（spec §2/§10）。
