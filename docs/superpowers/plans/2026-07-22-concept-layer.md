# 概念层地基（#1 P3）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给一门课的字幕打主题级概念标签，用户能「分析本课程概念」并在概念列表里点开看每个知识点在哪几节讲到、跨视频跳转。

**Architecture:** 后端逐视频让 LLM 抽「主题名+代表时间点」（长视频分块，复用 RAG 的 `split_by_chars`），本地按规范名合并，事务替换入库到新表 `concepts`/`concept_occurrences`；两个 Tauri 命令 analyze/list。前端在课程库屏加「知识点」面板。纯函数（parse/merge）与 DB 层（replace/list）单测，LLM 抽取 Mac 验。

**Tech Stack:** Rust + sqlx(SQLite) + Tauri v2；React 19 + TanStack Query + Zustand；vitest。

## Global Constraints

- 全本地、无遥测；数据进 SQLite，迁移顺延编号 `0015`。
- 运行时查询（非编译期 sqlx 宏），无 offline 元数据。
- 命令模式：纯 fn + `#[tauri::command] cmd_*` 包装 + 在 `commands/mod.rs` 和 `lib.rs` 的 `generate_handler!` 注册。Tauri v2 自动把 snake_case Rust 参数转 camelCase JS invoke 参数。
- 后端测试单线程跑（容器编 gtk 会 OOM）：`CARGO_BUILD_JOBS=1 cargo test --lib -j 1 <filter>`。
- **每个后端任务结束都要 `CARGO_BUILD_JOBS=1 cargo check --lib -j 1`**（非 test cfg＝桌面构建场景），防止只在桌面暴露的 cfg 门控问题。
- 前端：`pnpm vitest run --no-file-parallelism`、`pnpm tsc --noEmit`；Bash 工作目录每次重置，命令前先 `cd /workspace/course-ai`。
- 只 `git add` 本计划涉及的自己的文件，绝不 `git add -A`（宿主 Mac 侧有常驻未提交 WIP）。
- 提交信息结尾加 `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`。
- LLM 抽取效果与桌面交互需在 Mac 上验收，容器内不可跑。

---

### Task 1: 纯函数 —— parse_mmss / parse_concepts_json / merge_by_name

**Files:**
- Create: `src-tauri/src/pipeline/concepts.rs`
- Modify: `src-tauri/src/pipeline/mod.rs`（在 `pub mod audio;` 与 `pub mod crop_detect;` 之间加 `pub mod concepts;`）

**Interfaces:**
- Produces:
  - `pub struct RawConcept { pub name: String, pub start_ms: i64 }`
  - `pub struct MergedConcept { pub name: String, pub occurrences: Vec<(String, i64)> }`
  - `pub fn parse_mmss(s: &str) -> Option<i64>`
  - `pub fn parse_concepts_json(raw: &str) -> Vec<RawConcept>`
  - `pub fn merge_by_name(raw: Vec<(String, RawConcept)>) -> Vec<MergedConcept>`

- [ ] **Step 1: 建文件与模块声明，写纯函数实现**

在 `src-tauri/src/pipeline/mod.rs` 的 `pub mod audio;` 后一行插入：

```rust
pub mod concepts;
```

创建 `src-tauri/src/pipeline/concepts.rs`：

```rust
//! 主题级概念抽取（#1 P3 地基）：逐视频 LLM 抽取 + 本地按名合并 + 入库。
//! 本模块的解析/合并是纯函数（可单测）；抽取编排调 LLM（Mac 验）。

use serde_json::Value;

/// 一条抽取结果：主题名 + 代表时间点（毫秒，由 LLM 的 "at" 时间戳解析而来）。
#[derive(Debug, Clone, PartialEq)]
pub struct RawConcept {
    pub name: String,
    pub start_ms: i64,
}

/// 合并后的概念：规范展示名 + 各出现位置 (video_id, start_ms)。入库时再分配 id。
#[derive(Debug, Clone, PartialEq)]
pub struct MergedConcept {
    pub name: String,
    pub occurrences: Vec<(String, i64)>,
}

/// 解析 "mm:ss" / "h:mm:ss" / "hh:mm:ss" 为毫秒；容忍首尾方括号与空白；失败返回 None。
pub fn parse_mmss(s: &str) -> Option<i64> {
    let s = s.trim().trim_start_matches('[').trim_end_matches(']').trim();
    let parts: Vec<&str> = s.split(':').collect();
    if parts.len() < 2 || parts.len() > 3 {
        return None;
    }
    let mut nums: Vec<i64> = Vec::with_capacity(parts.len());
    for p in &parts {
        let n: i64 = p.trim().parse().ok()?;
        if n < 0 {
            return None;
        }
        nums.push(n);
    }
    let (h, m, sec) = match nums.as_slice() {
        [m, s] => (0, *m, *s),
        [h, m, s] => (*h, *m, *s),
        _ => return None,
    };
    if m >= 60 || sec >= 60 {
        return None;
    }
    Some((h * 3600 + m * 60 + sec) * 1000)
}

/// 容错解析 LLM 输出的 JSON 数组 `[{"name":"..","at":"mm:ss"}]`。
/// 非数组/非法 JSON → 空；缺 name 或 at 解析不出时间 → 跳过该条；多余字段忽略。
pub fn parse_concepts_json(raw: &str) -> Vec<RawConcept> {
    let Ok(Value::Array(items)) = serde_json::from_str::<Value>(raw) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for item in items {
        let name = item
            .get("name")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .trim()
            .to_string();
        if name.is_empty() {
            continue;
        }
        let at = item.get("at").and_then(|v| v.as_str()).unwrap_or("");
        let Some(start_ms) = parse_mmss(at) else {
            continue;
        };
        out.push(RawConcept { name, start_ms });
    }
    out
}

/// 规范化名：折叠内部空白 + ASCII 小写（中文不受影响），用于判同名。
fn normalize_name(name: &str) -> String {
    name.split_whitespace().collect::<Vec<_>>().join(" ").to_lowercase()
}

/// 把各视频的抽取结果按规范化名合并。展示名取该规范名首次出现的原始写法；
/// occurrences 去重（同 video+start_ms）；结果按出现次数降序、再按名升序。
pub fn merge_by_name(raw: Vec<(String, RawConcept)>) -> Vec<MergedConcept> {
    use std::collections::HashMap;
    let mut map: HashMap<String, (String, Vec<(String, i64)>)> = HashMap::new();
    let mut order: Vec<String> = Vec::new();
    for (video_id, rc) in raw {
        let norm = normalize_name(&rc.name);
        if norm.is_empty() {
            continue;
        }
        let entry = map.entry(norm.clone()).or_insert_with(|| {
            order.push(norm.clone());
            (rc.name.clone(), Vec::new())
        });
        let occ = (video_id, rc.start_ms);
        if !entry.1.contains(&occ) {
            entry.1.push(occ);
        }
    }
    let mut merged: Vec<MergedConcept> = order
        .into_iter()
        .map(|norm| {
            let (name, occ) = map.remove(&norm).unwrap();
            MergedConcept { name, occurrences: occ }
        })
        .collect();
    merged.sort_by(|a, b| {
        b.occurrences
            .len()
            .cmp(&a.occurrences.len())
            .then(a.name.cmp(&b.name))
    });
    merged
}
```

- [ ] **Step 2: 写失败测试**

在 `src-tauri/src/pipeline/concepts.rs` 末尾追加：

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_mmss_handles_mm_and_h_forms() {
        assert_eq!(parse_mmss("01:05"), Some(65_000));
        assert_eq!(parse_mmss("1:02:03"), Some(3_723_000));
        assert_eq!(parse_mmss("[00:00]"), Some(0));
        assert_eq!(parse_mmss("bad"), None);
        assert_eq!(parse_mmss("01:70"), None); // 秒越界
        assert_eq!(parse_mmss("12"), None); // 缺冒号
    }

    #[test]
    fn parse_concepts_json_parses_and_skips_bad_rows() {
        let raw = r#"[
            {"name":"贝叶斯定理","at":"01:05"},
            {"name":"  ","at":"00:10"},
            {"name":"参数方程","at":"nope"},
            {"name":"极限","at":"1:00:00","extra":1}
        ]"#;
        let got = parse_concepts_json(raw);
        assert_eq!(got.len(), 2);
        assert_eq!(got[0], RawConcept { name: "贝叶斯定理".into(), start_ms: 65_000 });
        assert_eq!(got[1], RawConcept { name: "极限".into(), start_ms: 3_600_000 });
        assert!(parse_concepts_json("not json").is_empty());
        assert!(parse_concepts_json(r#"{"name":"x"}"#).is_empty()); // 非数组
    }

    #[test]
    fn merge_by_name_merges_same_name_across_videos_and_ranks() {
        let raw = vec![
            ("v1".into(), RawConcept { name: "光合作用".into(), start_ms: 1000 }),
            ("v2".into(), RawConcept { name: " 光合作用 ".into(), start_ms: 2000 }),
            ("v1".into(), RawConcept { name: "细胞呼吸".into(), start_ms: 500 }),
            ("v1".into(), RawConcept { name: "光合作用".into(), start_ms: 1000 }), // 重复出现，去重
        ];
        let merged = merge_by_name(raw);
        assert_eq!(merged.len(), 2);
        // 光合作用出现两次（v1@1000, v2@2000，重复的被去重）排在前。
        assert_eq!(merged[0].name, "光合作用");
        assert_eq!(merged[0].occurrences, vec![("v1".into(), 1000), ("v2".into(), 2000)]);
        assert_eq!(merged[1].name, "细胞呼吸");
        assert_eq!(merged[1].occurrences, vec![("v1".into(), 500)]);
    }
}
```

- [ ] **Step 3: 跑测试确认通过（先编译再测）**

Run: `cd /workspace/course-ai/src-tauri && CARGO_BUILD_JOBS=1 cargo test --lib -j 1 pipeline::concepts::`
Expected: 3 个测试 PASS（`parse_mmss_handles_mm_and_h_forms`、`parse_concepts_json_parses_and_skips_bad_rows`、`merge_by_name_merges_same_name_across_videos_and_ranks`）。

- [ ] **Step 4: 桌面 cfg 校验**

Run: `cd /workspace/course-ai/src-tauri && CARGO_BUILD_JOBS=1 cargo check --lib -j 1`
Expected: `Finished`，0 error。

- [ ] **Step 5: 提交**

```bash
cd /workspace/course-ai && git add src-tauri/src/pipeline/concepts.rs src-tauri/src/pipeline/mod.rs && git commit -m "feat(course-ai): concept extraction pure fns — parse + merge (#1 P3)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: 迁移 0015 + DB 层 replace_course_concepts / list_course_concepts

**Files:**
- Create: `src-tauri/migrations/0015_concepts.sql`
- Modify: `src-tauri/src/pipeline/concepts.rs`（加 DB 结构体、两个 DB fn、DB 测试）

**Interfaces:**
- Consumes: `MergedConcept`（Task 1）
- Produces:
  - `pub struct ConceptOccurrence { pub video_id: String, pub video_title: String, pub start_ms: i64 }`
  - `pub struct CourseConcept { pub id: String, pub name: String, pub occurrences: Vec<ConceptOccurrence> }`
  - `pub async fn replace_course_concepts(db: &Db, course_id: &str, merged: &[MergedConcept]) -> AppResult<usize>`
  - `pub async fn list_course_concepts(db: &Db, course_id: &str) -> AppResult<Vec<CourseConcept>>`

- [ ] **Step 1: 建迁移**

创建 `src-tauri/migrations/0015_concepts.sql`：

```sql
CREATE TABLE concepts (
  id         TEXT PRIMARY KEY,
  course_id  TEXT NOT NULL,
  name       TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX ux_concepts_course_name ON concepts(course_id, name);
CREATE INDEX ix_concepts_course ON concepts(course_id);

CREATE TABLE concept_occurrences (
  concept_id TEXT NOT NULL,
  video_id   TEXT NOT NULL,
  start_ms   INTEGER NOT NULL,
  PRIMARY KEY (concept_id, video_id, start_ms)
);
CREATE INDEX ix_concept_occ_concept ON concept_occurrences(concept_id);
```

- [ ] **Step 2: 加 DB 结构体与函数**

在 `src-tauri/src/pipeline/concepts.rs` 顶部 `use serde_json::Value;` 下方补 use：

```rust
use crate::db::Db;
use crate::error::AppResult;
use serde::Serialize;
use uuid::Uuid;
```

在纯函数之后、`#[cfg(test)]` 之前插入：

```rust
/// 概念的一处出现（带视频标题，供列表点击跳转）。
#[derive(Debug, Clone, Serialize, sqlx::FromRow)]
pub struct ConceptOccurrence {
    pub video_id: String,
    pub video_title: String,
    pub start_ms: i64,
}

/// 课程里的一个概念及其全部出现位置。
#[derive(Debug, Clone, Serialize)]
pub struct CourseConcept {
    pub id: String,
    pub name: String,
    pub occurrences: Vec<ConceptOccurrence>,
}

/// 事务替换某课程的全部概念：删旧插新，为每个概念分配 uuid。返回入库概念数。
pub async fn replace_course_concepts(
    db: &Db,
    course_id: &str,
    merged: &[MergedConcept],
) -> AppResult<usize> {
    let now = chrono::Utc::now().timestamp_millis();
    let mut tx = db.pool.begin().await?;
    sqlx::query(
        "DELETE FROM concept_occurrences
         WHERE concept_id IN (SELECT id FROM concepts WHERE course_id=?)",
    )
    .bind(course_id)
    .execute(&mut *tx)
    .await?;
    sqlx::query("DELETE FROM concepts WHERE course_id=?")
        .bind(course_id)
        .execute(&mut *tx)
        .await?;
    for c in merged {
        let id = Uuid::new_v4().to_string();
        sqlx::query("INSERT INTO concepts(id,course_id,name,created_at) VALUES (?,?,?,?)")
            .bind(&id)
            .bind(course_id)
            .bind(&c.name)
            .bind(now)
            .execute(&mut *tx)
            .await?;
        for (video_id, start_ms) in &c.occurrences {
            sqlx::query(
                "INSERT OR IGNORE INTO concept_occurrences(concept_id,video_id,start_ms)
                 VALUES (?,?,?)",
            )
            .bind(&id)
            .bind(video_id)
            .bind(start_ms)
            .execute(&mut *tx)
            .await?;
        }
    }
    tx.commit().await?;
    Ok(merged.len())
}

/// 列出某课程的概念，每个带「在哪几节讲到」（join 存活视频标题）。
/// 概念按存活出现数降序、名升序；出现按 (视频 order_index, start_ms) 升序；
/// 全部出现都落在已删除视频上的概念不返回。
pub async fn list_course_concepts(db: &Db, course_id: &str) -> AppResult<Vec<CourseConcept>> {
    let rows: Vec<(String, String, String, String, i64)> = sqlx::query_as(
        "SELECT c.id, c.name, v.id, v.title, o.start_ms
         FROM concepts c
         JOIN concept_occurrences o ON o.concept_id = c.id
         JOIN videos v ON v.id = o.video_id AND v.deleted_at IS NULL
         WHERE c.course_id = ?
         ORDER BY v.order_index, o.start_ms",
    )
    .bind(course_id)
    .fetch_all(&db.pool)
    .await?;

    let mut out: Vec<CourseConcept> = Vec::new();
    let mut index: std::collections::HashMap<String, usize> = std::collections::HashMap::new();
    for (cid, cname, vid, vtitle, start_ms) in rows {
        let i = *index.entry(cid.clone()).or_insert_with(|| {
            out.push(CourseConcept {
                id: cid.clone(),
                name: cname.clone(),
                occurrences: Vec::new(),
            });
            out.len() - 1
        });
        out[i].occurrences.push(ConceptOccurrence {
            video_id: vid,
            video_title: vtitle,
            start_ms,
        });
    }
    out.sort_by(|a, b| {
        b.occurrences
            .len()
            .cmp(&a.occurrences.len())
            .then(a.name.cmp(&b.name))
    });
    Ok(out)
}
```

- [ ] **Step 3: 写失败测试**

在 `src-tauri/src/pipeline/concepts.rs` 的 `mod tests` 里追加（`use super::*;` 已有）：

```rust
    use crate::commands::courses::create_course;
    use crate::db::Db;

    async fn fresh_db() -> Db {
        let dir = std::env::temp_dir().join(format!("ca-concepts-{}.db", uuid::Uuid::new_v4()));
        Db::connect_and_migrate(&dir).await.unwrap()
    }

    async fn seed_video(db: &Db, course_id: &str, title: &str, order_index: i64) -> String {
        let vid = uuid::Uuid::new_v4().to_string();
        sqlx::query(
            "INSERT INTO videos(id,course_id,title,source_type,file_path,data_dir,created_at,order_index)
             VALUES (?,?,?,?,?,?,?,?)",
        )
        .bind(&vid)
        .bind(course_id)
        .bind(title)
        .bind("local")
        .bind("/tmp/v.mp4")
        .bind("/tmp/data")
        .bind(0i64)
        .bind(order_index)
        .execute(&db.pool)
        .await
        .unwrap();
        vid
    }

    #[tokio::test]
    async fn list_course_concepts_ranks_by_count_and_joins_titles() {
        let db = fresh_db().await;
        let course = create_course(&db, "c".into(), "/tmp/c".into()).await.unwrap();
        let v1 = seed_video(&db, &course.id, "第一讲", 0).await;
        let v2 = seed_video(&db, &course.id, "第二讲", 1).await;

        let merged = vec![
            MergedConcept { name: "甲概念".into(), occurrences: vec![(v1.clone(), 1000), (v2.clone(), 2000)] },
            MergedConcept { name: "乙概念".into(), occurrences: vec![(v1.clone(), 500)] },
        ];
        let n = replace_course_concepts(&db, &course.id, &merged).await.unwrap();
        assert_eq!(n, 2);

        let list = list_course_concepts(&db, &course.id).await.unwrap();
        assert_eq!(list.len(), 2);
        // 出现两次的「甲概念」排前，出现按 order_index 排（第一讲在前）。
        assert_eq!(list[0].name, "甲概念");
        assert_eq!(list[0].occurrences.len(), 2);
        assert_eq!(list[0].occurrences[0].video_title, "第一讲");
        assert_eq!(list[0].occurrences[1].video_title, "第二讲");
        assert_eq!(list[1].name, "乙概念");
    }

    #[tokio::test]
    async fn list_excludes_deleted_video_occurrences_and_replace_replaces() {
        let db = fresh_db().await;
        let course = create_course(&db, "c".into(), "/tmp/c".into()).await.unwrap();
        let v1 = seed_video(&db, &course.id, "第一讲", 0).await;
        let v2 = seed_video(&db, &course.id, "第二讲", 1).await;

        replace_course_concepts(
            &db,
            &course.id,
            &[MergedConcept { name: "甲概念".into(), occurrences: vec![(v1.clone(), 1000), (v2.clone(), 2000)] }],
        )
        .await
        .unwrap();

        // 删除第二讲：甲概念只剩第一讲那一处，仍在列表里。
        sqlx::query("UPDATE videos SET deleted_at=1 WHERE id=?")
            .bind(&v2)
            .execute(&db.pool)
            .await
            .unwrap();
        let list = list_course_concepts(&db, &course.id).await.unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].occurrences.len(), 1);
        assert_eq!(list[0].occurrences[0].video_id, v1);

        // 重跑替换：旧概念不残留，只剩新的。
        replace_course_concepts(
            &db,
            &course.id,
            &[MergedConcept { name: "丙概念".into(), occurrences: vec![(v1.clone(), 100)] }],
        )
        .await
        .unwrap();
        let list = list_course_concepts(&db, &course.id).await.unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].name, "丙概念");
    }
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd /workspace/course-ai/src-tauri && CARGO_BUILD_JOBS=1 cargo test --lib -j 1 pipeline::concepts::`
Expected: 5 个测试全 PASS（Task 1 的 3 个 + 本任务 2 个）。

- [ ] **Step 5: 桌面 cfg 校验**

Run: `cd /workspace/course-ai/src-tauri && CARGO_BUILD_JOBS=1 cargo check --lib -j 1`
Expected: `Finished`，0 error。

- [ ] **Step 6: 提交**

```bash
cd /workspace/course-ai && git add src-tauri/migrations/0015_concepts.sql src-tauri/src/pipeline/concepts.rs && git commit -m "feat(course-ai): concepts schema + DB layer (replace/list) (#1 P3)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: LLM 抽取编排 + 命令 + 注册

**Files:**
- Modify: `src-tauri/src/pipeline/rag.rs`（`fn split_by_chars` → `pub(crate) fn split_by_chars`）
- Modify: `src-tauri/src/pipeline/concepts.rs`（加 `analyze_course_concepts` + 相关 use/常量）
- Create: `src-tauri/src/commands/concepts.rs`
- Modify: `src-tauri/src/commands/mod.rs`（`pub mod clips;` 与 `pub mod courses;` 之间加 `pub mod concepts;`）
- Modify: `src-tauri/src/lib.rs`（加 use 与两个 handler 注册）

**Interfaces:**
- Consumes: `parse_concepts_json`、`merge_by_name`、`replace_course_concepts`、`list_course_concepts`（Task 1/2）；`rag::split_by_chars`
- Produces:
  - `pub async fn analyze_course_concepts(db: &Db, provider: &Provider, chat_model: &str, course_id: &str) -> AppResult<usize>`
  - `#[tauri::command] cmd_analyze_course_concepts(state, course_id: String) -> AppResult<usize>`
  - `#[tauri::command] cmd_list_course_concepts(state, course_id: String) -> AppResult<Vec<CourseConcept>>`

- [ ] **Step 1: 放开 split_by_chars 可见性**

`src-tauri/src/pipeline/rag.rs` 里：

```rust
/// 按行边界把长文稿切成不超过 `limit` 字符的若干段。
pub(crate) fn split_by_chars(text: &str, limit: usize) -> Vec<String> {
```
（只把 `fn split_by_chars` 改成 `pub(crate) fn split_by_chars`，函数体不变。）

- [ ] **Step 2: 加抽取编排**

`src-tauri/src/pipeline/concepts.rs` 顶部 use 区补：

```rust
use crate::llm::{ChatMessage, ChatRequest, Provider};
use crate::pipeline::ai::transcript_text;
use crate::pipeline::rag::split_by_chars;
```

在 `list_course_concepts` 之后、`#[cfg(test)]` 之前插入：

```rust
// 单次抽取喂给 LLM 的字幕字符上限；超过则分块逐块抽。
const CONCEPT_CHUNK_CHARS: usize = 12_000;

const CONCEPT_SYSTEM: &str = "你是课程知识点抽取助手。读这段课程字幕（每行以 [mm:ss] 开头），\
抽出其中讲到的主题级知识点（如「贝叶斯定理」「参数方程求导」这种可命名的概念，不要太碎的术语，也不要整章大块）。\
只输出 JSON 数组，每个元素形如 {\"name\":\"知识点名\",\"at\":\"mm:ss\"}：\
name 用该领域标准、规范的中文术语（同一知识点在不同处尽量用完全一致的名字，便于合并）；\
at 从本段字幕里照抄一个最能代表该知识点的行首时间点（只填 mm:ss，不带方括号）。\
没有明确知识点就只输出 []。不要输出 JSON 以外的任何文字。";

/// 分析整门课的概念：逐视频（长则分块）抽取 → 合并 → 事务替换入库。返回入库概念数。
/// 复用调用方给的 provider/model（命令层按 AiTask::Summary 解析）。无字幕的视频跳过。
pub async fn analyze_course_concepts(
    db: &Db,
    provider: &Provider,
    chat_model: &str,
    course_id: &str,
) -> AppResult<usize> {
    let videos: Vec<(String, String)> = sqlx::query_as(
        "SELECT id,title FROM videos WHERE course_id=? AND deleted_at IS NULL ORDER BY order_index",
    )
    .bind(course_id)
    .fetch_all(&db.pool)
    .await?;

    let mut raw: Vec<(String, RawConcept)> = Vec::new();
    for (vid, _title) in &videos {
        let transcript = transcript_text(db, vid).await?;
        if transcript.trim().is_empty() {
            continue;
        }
        for chunk in split_by_chars(&transcript, CONCEPT_CHUNK_CHARS) {
            let req = ChatRequest {
                model: chat_model.to_string(),
                system: Some(CONCEPT_SYSTEM.to_string()),
                cacheable_context: Some(format!("字幕片段：\n{chunk}")),
                messages: vec![ChatMessage {
                    role: "user".into(),
                    content: "抽取本段知识点。".into(),
                }],
                temperature: 0.1,
                max_tokens: 800,
            };
            let content = provider.complete(&req).await?.content;
            for rc in parse_concepts_json(&content) {
                raw.push((vid.clone(), rc));
            }
        }
    }

    let merged = merge_by_name(raw);
    replace_course_concepts(db, course_id, &merged).await
}
```

- [ ] **Step 3: 建命令文件**

创建 `src-tauri/src/commands/concepts.rs`：

```rust
use crate::commands::courses::AppState;
use crate::commands::settings::get_setting;
use crate::error::{AppError, AppResult};
use crate::llm::factory::build_provider;
use crate::llm::keychain;
use crate::llm::profiles::{parse_profiles, parse_routing, resolve_profile, AiTask};
use crate::pipeline::concepts::{self, CourseConcept};
use tauri::State;

/// 概念抽取用的 provider + chat 模型：复用「摘要」任务(AiTask::Summary)的 Profile 路由，
/// 不新增 task/设置项。未配置该 Profile 时报 Config 错误。
async fn concepts_provider(state: &AppState) -> AppResult<(crate::llm::Provider, String)> {
    let profiles = parse_profiles(get_setting(&state.db, "llm_profiles").await?.as_deref())?;
    let routing = parse_routing(get_setting(&state.db, "llm_task_routing").await?.as_deref())?;
    let profile = resolve_profile(&profiles, &routing, AiTask::Summary)
        .ok_or_else(|| AppError::Config("尚未配置任何 LLM Profile（设置 → LLM）".into()))?
        .clone();
    let key = keychain::get_api_key(&state.db, &profile.id)
        .await?
        .ok_or_else(|| AppError::Config(format!("Profile「{}」未设置 API Key", profile.name)))?;
    let chat_model = profile.model.clone();
    Ok((build_provider(&profile, key), chat_model))
}

/// 分析本课程概念（会调多次 LLM，耗时）。返回入库概念数。
#[tauri::command]
pub async fn cmd_analyze_course_concepts(
    state: State<'_, AppState>,
    course_id: String,
) -> AppResult<usize> {
    let (provider, chat_model) = concepts_provider(&state).await?;
    concepts::analyze_course_concepts(&state.db, &provider, &chat_model, &course_id).await
}

/// 列出本课程已抽取的概念（未分析则空表）。
#[tauri::command]
pub async fn cmd_list_course_concepts(
    state: State<'_, AppState>,
    course_id: String,
) -> AppResult<Vec<CourseConcept>> {
    concepts::list_course_concepts(&state.db, &course_id).await
}
```

- [ ] **Step 4: 注册模块与命令**

`src-tauri/src/commands/mod.rs`，在 `pub mod clips;` 后一行加：

```rust
pub mod concepts;
```

`src-tauri/src/lib.rs`，在 `use crate::commands::rag::{...}` 这组 use 附近加一行：

```rust
use crate::commands::concepts::{cmd_analyze_course_concepts, cmd_list_course_concepts};
```

在 `generate_handler!` 宏里、`cmd_course_totals,` 附近加两行：

```rust
            cmd_analyze_course_concepts,
            cmd_list_course_concepts,
```

- [ ] **Step 5: 全后端测试 + 桌面 cfg 校验**

Run: `cd /workspace/course-ai/src-tauri && CARGO_BUILD_JOBS=1 cargo test --lib -j 1 pipeline::concepts::`
Expected: 仍是 5 个测试 PASS（编排本身走 LLM，不新增单测）。

Run: `cd /workspace/course-ai/src-tauri && CARGO_BUILD_JOBS=1 cargo check --lib -j 1`
Expected: `Finished`，0 error（确认 analyze/命令/注册在桌面 cfg 下都编过）。

- [ ] **Step 6: 提交**

```bash
cd /workspace/course-ai && git add src-tauri/src/pipeline/rag.rs src-tauri/src/pipeline/concepts.rs src-tauri/src/commands/concepts.rs src-tauri/src/commands/mod.rs src-tauri/src/lib.rs && git commit -m "feat(course-ai): course concept extraction + commands (#1 P3)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: 前端 ConceptsPanel（含 ipc 接线）

**Files:**
- Modify: `src/lib/ipc.ts`（加 `ConceptOccurrence`/`CourseConcept` 类型 + `concepts.analyze/list`）
- Create: `src/components/ConceptsPanel.tsx`
- Create: `src/components/ConceptsPanel.test.tsx`

**Interfaces:**
- Consumes: 后端命令 `cmd_analyze_course_concepts`、`cmd_list_course_concepts`
- Produces: `export function ConceptsPanel({ courseId, courseName, onClose, onJump }): JSX`，其中 `onJump: (videoId: string, startMs: number) => void`

- [ ] **Step 1: ipc 接线**

`src/lib/ipc.ts`，在 `ContinueRow` 接口后（或类型区）加：

```ts
/** 概念的一处出现（带视频标题，供点击跳转）。 */
export interface ConceptOccurrence {
  video_id: string;
  video_title: string;
  start_ms: number;
}

/** 课程里的一个概念及其出现位置。 */
export interface CourseConcept {
  id: string;
  name: string;
  occurrences: ConceptOccurrence[];
}
```

在 `stats: { ... }` 块之后加一个 `concepts` 块：

```ts
  concepts: {
    // 分析本课程概念（会调多次 LLM，耗时），返回入库概念数。
    analyze: (courseId: string): Promise<number> =>
      invoke("cmd_analyze_course_concepts", { courseId }),
    // 列出本课程已抽取的概念（未分析则空表）。
    list: (courseId: string): Promise<CourseConcept[]> =>
      invoke("cmd_list_course_concepts", { courseId }),
  },
```

- [ ] **Step 2: 写失败测试**

创建 `src/components/ConceptsPanel.test.tsx`：

```tsx
import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ConceptsPanel } from "./ConceptsPanel";

const { list, analyze } = vi.hoisted(() => ({ list: vi.fn(), analyze: vi.fn() }));
vi.mock("@/lib/ipc", () => ({ ipc: { concepts: { list, analyze } } }));

function renderPanel(onJump = vi.fn(), onClose = vi.fn()) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <ConceptsPanel courseId="c1" courseName="申论" onClose={onClose} onJump={onJump} />
    </QueryClientProvider>,
  );
  return { onJump, onClose };
}

const concept = {
  id: "k1",
  name: "贝叶斯定理",
  occurrences: [
    { video_id: "v1", video_title: "第一讲", start_ms: 65000 },
    { video_id: "v2", video_title: "第二讲", start_ms: 5000 },
  ],
};

describe("ConceptsPanel", () => {
  beforeEach(() => {
    list.mockReset().mockResolvedValue([concept]);
    analyze.mockReset().mockResolvedValue(1);
  });

  it("lists concepts, expands occurrences, and jumps on click", async () => {
    const { onJump } = renderPanel();
    // 概念名 + 出现次数徽标。
    expect(await screen.findByText("贝叶斯定理")).toBeInTheDocument();
    expect(screen.getByText("2")).toBeInTheDocument();

    // 展开看在哪几节讲到。
    fireEvent.click(screen.getByText("贝叶斯定理"));
    const occ = await screen.findByText(/第一讲/);
    fireEvent.click(occ.closest("button")!);
    expect(onJump).toHaveBeenCalledWith("v1", 65000);
  });

  it("shows an analyze CTA when empty and reloads after analyzing", async () => {
    list.mockReset()
      .mockResolvedValueOnce([]) // 初次：空
      .mockResolvedValue([concept]); // 分析后重拉
    renderPanel();

    fireEvent.click(await screen.findByRole("button", { name: /分析本课程概念/ }));
    await waitFor(() => expect(analyze).toHaveBeenCalledWith("c1"));
    expect(await screen.findByText("贝叶斯定理")).toBeInTheDocument();
  });
});
```

- [ ] **Step 3: 跑测试确认失败**

Run: `cd /workspace/course-ai && pnpm vitest run --no-file-parallelism src/components/ConceptsPanel.test.tsx`
Expected: FAIL（`ConceptsPanel` 模块不存在 / 无法解析）。

- [ ] **Step 4: 写组件**

创建 `src/components/ConceptsPanel.tsx`：

```tsx
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronLeft, Lightbulb, Sparkles } from "lucide-react";
import { ipc } from "@/lib/ipc";
import { formatMs } from "@/lib/time";
import { ErrorNote } from "@/components/ui/ErrorNote";
import { Skeleton } from "@/components/ui/skeleton";

/** 课程级「知识点」面板：分析并浏览本课程概念，点出处跨视频跳转。 */
export function ConceptsPanel({
  courseId,
  courseName,
  onClose,
  onJump,
}: {
  courseId: string;
  courseName?: string;
  onClose: () => void;
  onJump: (videoId: string, startMs: number) => void;
}) {
  const queryClient = useQueryClient();
  const [expanded, setExpanded] = useState<string | null>(null);

  const { data: concepts = [], isLoading } = useQuery({
    queryKey: ["course-concepts", courseId],
    queryFn: () => ipc.concepts.list(courseId),
  });

  const analyze = useMutation({
    mutationFn: () => ipc.concepts.analyze(courseId),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: ["course-concepts", courseId] }),
  });

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col bg-[var(--surface-app)] text-[var(--text-normal)]">
      <header className="flex flex-none items-center gap-3 border-b border-[var(--border-subtle)] bg-[var(--surface-header)] px-7 py-4">
        <button aria-label="返回" onClick={onClose} className="ca-icon-btn ca-touch-44 ml-0">
          <ChevronLeft className="h-5 w-5" />
        </button>
        <h2 className="flex items-center gap-2 text-lg font-semibold text-[var(--text-strong)]">
          <Lightbulb className="h-4 w-4" />
          知识点{courseName ? ` · ${courseName}` : ""}
        </h2>
        {concepts.length > 0 && (
          <button
            onClick={() => analyze.mutate()}
            disabled={analyze.isPending}
            className="ca-touch-44 ml-auto rounded-lg border border-[var(--border-subtle)] px-3 py-1.5 text-xs font-medium text-[var(--text-normal)] transition hover:bg-[var(--surface-card-hover)] disabled:opacity-60"
          >
            {analyze.isPending ? "分析中…" : "重新分析"}
          </button>
        )}
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-7 py-6">
        <div className="mx-auto max-w-2xl space-y-3">
          {analyze.isError && (
            <ErrorNote error={analyze.error} onRetry={() => analyze.mutate()} />
          )}

          {isLoading ? (
            <>
              <Skeleton className="h-12 w-full" />
              <Skeleton className="h-12 w-full" />
              <Skeleton className="h-12 w-full" />
            </>
          ) : concepts.length === 0 ? (
            <div className="flex flex-col items-center gap-3 px-2 pt-10 text-center">
              <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-primary/12 text-primary">
                <Sparkles className="h-6 w-6" />
              </span>
              <p className="max-w-[320px] text-sm leading-relaxed text-[var(--text-muted)]">
                还没有分析过这门课的知识点。分析会读取各节字幕，用 AI 抽取主题级概念，
                可能需要一会儿。
              </p>
              <button
                onClick={() => analyze.mutate()}
                disabled={analyze.isPending}
                className="ca-touch-44 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white transition hover:opacity-90 disabled:opacity-60"
              >
                {analyze.isPending ? "分析中…" : "分析本课程概念"}
              </button>
            </div>
          ) : (
            <ul className="space-y-2">
              {concepts.map((c) => (
                <li
                  key={c.id}
                  className="overflow-hidden rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-card)]"
                >
                  <button
                    onClick={() => setExpanded((e) => (e === c.id ? null : c.id))}
                    aria-expanded={expanded === c.id}
                    className="flex w-full items-center gap-3 px-4 py-3 text-left transition hover:bg-[var(--surface-card-hover)]"
                  >
                    <span className="min-w-0 flex-1 truncate text-sm font-medium text-[var(--text-strong)]">
                      {c.name}
                    </span>
                    <span className="flex-none rounded-full bg-[var(--surface-card-active)] px-2 py-0.5 text-xs text-[var(--text-muted)]">
                      {c.occurrences.length}
                    </span>
                  </button>
                  {expanded === c.id && (
                    <div className="border-t border-[var(--border-subtle)] px-2 py-1.5">
                      {c.occurrences.map((o) => (
                        <button
                          key={`${o.video_id}-${o.start_ms}`}
                          onClick={() => onJump(o.video_id, o.start_ms)}
                          className="block w-full rounded px-2 py-1 text-left text-xs hover:bg-[var(--surface-card-hover)]"
                        >
                          <span className="mr-1.5 text-[var(--text-faint)]">{o.video_title} ·</span>
                          <span className="text-primary">{formatMs(o.start_ms)}</span>
                        </button>
                      ))}
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 5: 跑测试确认通过 + tsc**

Run: `cd /workspace/course-ai && pnpm vitest run --no-file-parallelism src/components/ConceptsPanel.test.tsx`
Expected: 2 个测试 PASS。

Run: `cd /workspace/course-ai && pnpm tsc --noEmit`
Expected: 无输出（通过）。

- [ ] **Step 6: 提交**

```bash
cd /workspace/course-ai && git add src/lib/ipc.ts src/components/ConceptsPanel.tsx src/components/ConceptsPanel.test.tsx && git commit -m "feat(course-ai): concepts panel — list/analyze/jump (#1 P3)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 5: Home 接线 —— 课程库屏「知识点」入口

**Files:**
- Modify: `src/pages/Home.tsx`

**Interfaces:**
- Consumes: `ConceptsPanel`（Task 4）；`usePlayer.requestOpenAt`；既有 `pendingSeek` 通路
- Produces: 课程库屏一个「知识点」按钮 + `showConcepts` 覆盖层

- [ ] **Step 1: 引入组件与状态**

`src/pages/Home.tsx` 顶部，靠近 `import { Dashboard } from "@/components/Dashboard";` 处加：

```tsx
import { ConceptsPanel } from "@/components/ConceptsPanel";
```

在其它 `useState` 附近（如 `const [showDashboard, setShowDashboard] = useState(false);` 旁）加：

```tsx
  const [showConcepts, setShowConcepts] = useState(false);
```

加一个续播式跳转 + 关面板的处理器，放在 `resumeStudy` 函数附近：

```tsx
  // 「知识点」出处点击：关面板、跳到该视频对应位置（同课程，pendingSeek 驱动开视频+seek）。
  function conceptJump(videoId: string, startMs: number) {
    setShowConcepts(false);
    usePlayer.getState().requestOpenAt(videoId, startMs);
  }
```

- [ ] **Step 2: 加「知识点」按钮**

在课程库屏（选中课程、显示视频列表那一屏）的头部工具栏（课程标题旁、与其它课程级操作同排的区域）加一个按钮。找到该屏渲染课程标题/操作的容器，插入：

```tsx
              <button
                onClick={() => setShowConcepts(true)}
                className="ca-touch-44 inline-flex items-center gap-1.5 rounded-lg border border-[var(--border-subtle)] px-3 py-1.5 text-sm text-[var(--text-normal)] transition hover:bg-[var(--surface-card-hover)]"
              >
                <Lightbulb className="h-4 w-4" />
                知识点
              </button>
```

若 `Lightbulb` 尚未从 `lucide-react` 引入，在 Home 顶部的 lucide 引入里补上 `Lightbulb`。

- [ ] **Step 3: 渲染覆盖层**

在课程库屏 JSX 里（视频列表容器之上或同层，能覆盖该区域处）加条件渲染：

```tsx
        {showConcepts && selectedCourseId && (
          <ConceptsPanel
            courseId={selectedCourseId}
            courseName={courses.find((c) => c.id === selectedCourseId)?.name}
            onClose={() => setShowConcepts(false)}
            onJump={conceptJump}
          />
        )}
```

（`courses` 为 Home 里已有的课程列表查询数据；若变量名不同，用 Home 现有的课程列表变量。）

- [ ] **Step 4: 全量前端校验**

Run: `cd /workspace/course-ai && pnpm tsc --noEmit`
Expected: 无输出。

Run: `cd /workspace/course-ai && pnpm vitest run --no-file-parallelism`
Expected: 全部测试 PASS（新增 ConceptsPanel 2 个，其余不回归）。

- [ ] **Step 5: 提交**

```bash
cd /workspace/course-ai && git add src/pages/Home.tsx && git commit -m "feat(course-ai): wire concepts panel into the course screen (#1 P3)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

- [ ] **Step 6: 交回 Mac 验收清单（不提交，只说明）**

在 Mac 上 `pnpm tauri dev` 后确认：选中一门有字幕的课 → 点「知识点」→「分析本课程概念」跑通并出概念列表 → 展开某概念点出处能跨视频跳转并 seek 到位；「重新分析」可替换结果；未配 LLM Profile 时报友好错误。

---

## Self-Review（作者自查，已完成）

- **Spec 覆盖**：schema(0015)→T2；纯抽取(parse/merge)→T1；课程级编排+命令→T3；概念列表面板+跳转+分析 CTA→T4；课程库屏入口→T5。测试项 spec 全部落到 T1/T2/T4。
- **占位符**：无 TBD/TODO；每步给出完整代码与命令。
- **类型一致**：`RawConcept`/`MergedConcept`/`CourseConcept`/`ConceptOccurrence` 跨任务签名一致；`onJump(videoId, startMs)` 组件与 Home 一致；命令名 `cmd_analyze_course_concepts`/`cmd_list_course_concepts` 前后端一致。
- **范围**：只做地基，#2/#5 接入不在本计划。
