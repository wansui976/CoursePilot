# B站自带字幕导入 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 导入 B站视频时探测自带字幕与可选清晰度，让用户选清晰度、并可用自带字幕替代语音转写；字幕在现有流水线 ASR 阶段内消化，后续链路全部复用。

**Architecture:** 方案 A——把「选用的字幕」挂到 video 行（`subtitle_path`/`subtitle_lang`）。`run_all` 的 ASR 阶段先判断有无待用字幕：有则解析 SRT → 写文稿 → 跳过 whisper/云 ASR；无则维持现状。导入向导先引导 cookie，再用 `yt-dlp -J` 探测字幕轨 + 清晰度档位。

**Tech Stack:** Rust (Tauri 2, sqlx/SQLite, tokio, serde_json)、React 19 + TS、yt-dlp sidecar。

参考 spec：`docs/superpowers/specs/2026-06-04-bilibili-subtitle-import-design.md`

**命令速查：**
- Rust 测试：`cd src-tauri && CARGO_HOME=/home/node/.cargo cargo test --quiet <filter>`
- Rust 编译：`cd src-tauri && CARGO_HOME=/home/node/.cargo cargo build`
- 前端测试：`node_modules/.bin/vitest run <file>`
- 前端类型检查：`node_modules/.bin/tsc --noEmit`
- 本机真实验证用 cookie：`/workspace/course-ai/www.bilibili.com_cookies .txt`（已 gitignore，禁止提交）

---

## File Structure

**新建：**
- `src-tauri/migrations/0008_subtitle.sql` — videos 加 `subtitle_path`/`subtitle_lang` 列
- `src-tauri/src/pipeline/subtitle.rs` — SRT 解析 + 字幕入库消化（纯函数 + ingest）
- `src/components/BilibiliImportDialog.tsx` — 分步导入向导

**修改：**
- `src-tauri/src/commands/videos.rs` — Video 结构加两字段
- `src-tauri/src/pipeline/asr.rs` — 抽出通用 `store_segments`/`store_segments_backup`
- `src-tauri/src/pipeline/mod.rs` — 注册 `subtitle` 模块；ASR 阶段加字幕分支
- `src-tauri/src/pipeline/download.rs` — `build_ytdlp_args` 加清晰度/字幕参数；`probe`
- `src-tauri/src/commands/tools.rs` — `cmd_probe_bilibili`、改 `cmd_import_bilibili`、`cmd_set_bilibili_cookies`
- `src-tauri/src/lib.rs` — 注册新命令
- `src/lib/ipc.ts`、`src/lib/types.ts` — IPC 封装与类型
- `src/components/ImportVideoDialog.tsx` — 网络下载入口改为打开向导
- `src/components/SettingsDialog.tsx` — `subtitle_autocorrect` 开关

---

## Task 1: DB 迁移 + Video 结构加字段

**Files:**
- Create: `src-tauri/migrations/0008_subtitle.sql`
- Modify: `src-tauri/src/commands/videos.rs`（Video 结构 + 新增测试）

- [ ] **Step 1: 写迁移文件**

Create `src-tauri/migrations/0008_subtitle.sql`:

```sql
-- 待用的 B站自带字幕：导入时写入，ASR 阶段消化后将 path 置空、保留 lang 作来源展示。
ALTER TABLE videos ADD COLUMN subtitle_path TEXT;
ALTER TABLE videos ADD COLUMN subtitle_lang TEXT;
```

- [ ] **Step 2: Video 结构加字段**

In `src-tauri/src/commands/videos.rs`, add two fields to `pub struct Video` (after `processed_status`):

```rust
    pub processed_status: String,
    pub subtitle_path: Option<String>,
    pub subtitle_lang: Option<String>,
    pub created_at: i64,
```

- [ ] **Step 3: 写失败测试**

Add to the `tests` module in `src-tauri/src/commands/videos.rs`:

```rust
    #[tokio::test]
    async fn videos_table_has_subtitle_columns() {
        let dir = tempfile::tempdir().unwrap();
        let db = Db::connect_and_migrate(&dir.path().join("t.db"))
            .await
            .unwrap();
        let course = crate::commands::courses::create_course(
            &db, "c".into(), dir.path().to_string_lossy().into())
            .await.unwrap();
        let vpath = dir.path().join("v.mp4");
        std::fs::write(&vpath, b"x").unwrap();
        let video = add_local_video(&db, &course.id, vpath, None).await.unwrap();

        sqlx::query("UPDATE videos SET subtitle_path=?, subtitle_lang=? WHERE id=?")
            .bind("/tmp/x.ai-zh.srt").bind("ai-zh").bind(&video.id)
            .execute(&db.pool).await.unwrap();

        let got: Video = sqlx::query_as("SELECT * FROM videos WHERE id=?")
            .bind(&video.id).fetch_one(&db.pool).await.unwrap();
        assert_eq!(got.subtitle_lang.as_deref(), Some("ai-zh"));
        assert_eq!(got.subtitle_path.as_deref(), Some("/tmp/x.ai-zh.srt"));
    }
```

- [ ] **Step 4: 运行测试（先看它因结构/列缺失而失败或编译错，再补齐后通过）**

Run: `cd src-tauri && CARGO_HOME=/home/node/.cargo cargo test --quiet videos_table_has_subtitle_columns`
Expected: PASS（迁移与结构都到位后）。若 SELECT * 报列不匹配，确认 Step 2 字段名与列名一致。

- [ ] **Step 5: Commit**

```bash
git add src-tauri/migrations/0008_subtitle.sql src-tauri/src/commands/videos.rs
git commit -m "feat(db): add subtitle_path/subtitle_lang columns to videos"
```

---

## Task 2: SRT 解析器（`pipeline/subtitle.rs`）

**Files:**
- Create: `src-tauri/src/pipeline/subtitle.rs`
- Modify: `src-tauri/src/pipeline/mod.rs`（加 `pub mod subtitle;`）

- [ ] **Step 1: 注册模块**

In `src-tauri/src/pipeline/mod.rs`, add alongside the other `pub mod` lines (near line 2-13):

```rust
pub mod subtitle;
```

- [ ] **Step 2: 写解析器骨架 + 失败测试**

Create `src-tauri/src/pipeline/subtitle.rs`:

```rust
//! B站自带字幕（SRT）解析与入库消化。
//!
//! yt-dlp `--convert-subs srt` 落地的字幕统一为 SRT；这里解析为带毫秒时间轴的
//! 段落，复用 ASR 的写库逻辑写入 transcripts，使字幕成为「另一种来源的文稿」。

/// 一段字幕：时间轴（毫秒）+ 文本。
#[derive(Debug, Clone, PartialEq)]
pub struct SubSegment {
    pub start_ms: i64,
    pub end_ms: i64,
    pub text: String,
}

/// 把 `HH:MM:SS,mmm`（或 `.mmm`）解析为毫秒；不合法返回 None。
fn parse_srt_time(token: &str) -> Option<i64> {
    let token = token.trim().replace('.', ",");
    let (hms, millis) = token.split_once(',')?;
    let ms: i64 = millis.parse().ok()?;
    let mut parts = hms.split(':');
    let h: i64 = parts.next()?.parse().ok()?;
    let m: i64 = parts.next()?.parse().ok()?;
    let s: i64 = parts.next()?.parse().ok()?;
    if parts.next().is_some() {
        return None;
    }
    Some(((h * 60 + m) * 60 + s) * 1000 + ms)
}

/// 解析 SRT 文本为段落。容错：忽略空块、缺时间轴块；多行文本用空格拼接。
pub fn parse_srt(input: &str) -> Vec<SubSegment> {
    let mut out = Vec::new();
    // 按空行分块。
    for block in input.split("\n\n") {
        let lines: Vec<&str> = block.lines().map(str::trim).filter(|l| !l.is_empty()).collect();
        // 找到含 "-->" 的时间轴行，其后的行是文本。
        let Some(arrow_idx) = lines.iter().position(|l| l.contains("-->")) else {
            continue;
        };
        let (start_tok, end_tok) = match lines[arrow_idx].split_once("-->") {
            Some(pair) => pair,
            None => continue,
        };
        let (Some(start_ms), Some(end_ms)) =
            (parse_srt_time(start_tok), parse_srt_time(end_tok))
        else {
            continue;
        };
        let text = lines[arrow_idx + 1..].join(" ").trim().to_string();
        if text.is_empty() {
            continue;
        }
        out.push(SubSegment { start_ms, end_ms, text });
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_standard_srt() {
        let srt = "1\n00:00:01,200 --> 00:00:03,400\n你好世界\n\n2\n00:00:03,400 --> 00:00:05,000\n第二句";
        let segs = parse_srt(srt);
        assert_eq!(segs.len(), 2);
        assert_eq!(segs[0], SubSegment { start_ms: 1200, end_ms: 3400, text: "你好世界".into() });
        assert_eq!(segs[1].start_ms, 3400);
    }

    #[test]
    fn joins_multiline_and_skips_blank_blocks() {
        let srt = "1\n00:00:00,000 --> 00:00:02,000\n第一行\n第二行\n\n\n\n2\n00:00:02,000 --> 00:00:04,000\n下一段";
        let segs = parse_srt(srt);
        assert_eq!(segs.len(), 2);
        assert_eq!(segs[0].text, "第一行 第二行");
    }

    #[test]
    fn tolerates_dot_millis_and_drops_timeless_blocks() {
        let srt = "00:00:01.500 --> 00:00:02.500\nA\n\nnonsense block without arrow\n\n00:01:00,000 --> 00:01:01,000\nB";
        let segs = parse_srt(srt);
        assert_eq!(segs.len(), 2);
        assert_eq!(segs[0].start_ms, 1500);
        assert_eq!(segs[1].start_ms, 60_000);
    }
}
```

- [ ] **Step 3: 运行测试**

Run: `cd src-tauri && CARGO_HOME=/home/node/.cargo cargo test --quiet subtitle::`
Expected: PASS（3 tests）。

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/pipeline/subtitle.rs src-tauri/src/pipeline/mod.rs
git commit -m "feat(subtitle): add SRT parser"
```

---

## Task 3: 通用文稿写库（`pipeline/asr.rs`）

把现有 whisper 专用的写库抽成通用函数，供字幕复用（DRY）。

**Files:**
- Modify: `src-tauri/src/pipeline/asr.rs`

- [ ] **Step 1: 加通用结构与函数 + 失败测试**

In `src-tauri/src/pipeline/asr.rs`, add near the top (after the existing structs):

```rust
/// 通用文稿段：whisper 与字幕共用，写入 transcripts / transcript_backups。
pub struct StoredSegment {
    pub start_ms: i64,
    pub end_ms: i64,
    pub text: String,
    pub words_json: String,
}

/// 覆盖式写入 transcripts。
pub async fn store_segments(db: &Db, video_id: &str, segs: &[StoredSegment]) -> AppResult<usize> {
    sqlx::query("DELETE FROM transcripts WHERE video_id=?")
        .bind(video_id)
        .execute(&db.pool)
        .await?;
    for (idx, seg) in segs.iter().enumerate() {
        sqlx::query(
            "INSERT INTO transcripts(video_id,segment_idx,start_ms,end_ms,text,words_json)
             VALUES (?,?,?,?,?,?)",
        )
        .bind(video_id)
        .bind(idx as i64)
        .bind(seg.start_ms)
        .bind(seg.end_ms)
        .bind(seg.text.trim())
        .bind(&seg.words_json)
        .execute(&db.pool)
        .await?;
    }
    Ok(segs.len())
}

/// 存一份原始文稿快照到 transcript_backups，`source` 区分来源（raw_asr / bilibili_sub）。
pub async fn store_segments_backup(
    db: &Db,
    video_id: &str,
    source: &str,
    segs: &[StoredSegment],
) -> AppResult<()> {
    let backup: Vec<TranscriptBackupSegment> = segs
        .iter()
        .enumerate()
        .map(|(idx, seg)| TranscriptBackupSegment {
            segment_idx: idx as i64,
            start_ms: seg.start_ms,
            end_ms: seg.end_ms,
            text: seg.text.trim().to_string(),
            words_json: seg.words_json.clone(),
        })
        .collect();
    sqlx::query(
        "INSERT INTO transcript_backups(video_id,source,segments_json,created_at)
         VALUES (?,?,?,?)",
    )
    .bind(video_id)
    .bind(source)
    .bind(serde_json::to_string(&backup)?)
    .bind(chrono::Utc::now().timestamp_millis())
    .execute(&db.pool)
    .await?;
    Ok(())
}

/// 把 whisper JSON 转成通用段（words_json 由 tokens 序列化）。
fn whisper_to_segments(json: &WhisperJson) -> AppResult<Vec<StoredSegment>> {
    json.transcription
        .iter()
        .map(|segment| -> AppResult<StoredSegment> {
            let words_json = serde_json::to_string(
                &segment
                    .tokens
                    .iter()
                    .map(|token| {
                        serde_json::json!({
                            "text": token.text,
                            "from": token.offsets.from,
                            "to": token.offsets.to,
                        })
                    })
                    .collect::<Vec<_>>(),
            )?;
            Ok(StoredSegment {
                start_ms: segment.offsets.from,
                end_ms: segment.offsets.to,
                text: segment.text.trim().to_string(),
                words_json,
            })
        })
        .collect()
}
```

Then add a test in the `tests` module:

```rust
    #[tokio::test]
    async fn store_segments_writes_transcripts_and_backup() {
        let dir = tempdir().unwrap();
        let db = Db::connect_and_migrate(&dir.path().join("t.db")).await.unwrap();
        let course = create_course(&db, "c".into(), dir.path().to_string_lossy().into())
            .await.unwrap();
        let vpath = dir.path().join("v.mp4");
        std::fs::write(&vpath, b"x").unwrap();
        let video = add_local_video(&db, &course.id, vpath, None).await.unwrap();

        let segs = vec![StoredSegment {
            start_ms: 0, end_ms: 1200, text: " 字幕句 ".into(), words_json: "[]".into(),
        }];
        let n = store_segments(&db, &video.id, &segs).await.unwrap();
        store_segments_backup(&db, &video.id, "bilibili_sub", &segs).await.unwrap();
        assert_eq!(n, 1);

        let text: String = sqlx::query_scalar("SELECT text FROM transcripts WHERE video_id=?")
            .bind(&video.id).fetch_one(&db.pool).await.unwrap();
        assert_eq!(text, "字幕句");
        let source: String = sqlx::query_scalar("SELECT source FROM transcript_backups WHERE video_id=?")
            .bind(&video.id).fetch_one(&db.pool).await.unwrap();
        assert_eq!(source, "bilibili_sub");
    }
```

- [ ] **Step 2: 运行测试看通过**

Run: `cd src-tauri && CARGO_HOME=/home/node/.cargo cargo test --quiet store_segments_writes`
Expected: PASS

- [ ] **Step 3: 重构现有函数委托到通用层（DRY）**

Replace the body of `store_transcripts` to delegate:

```rust
pub async fn store_transcripts(db: &Db, video_id: &str, json: &WhisperJson) -> AppResult<usize> {
    let segs = whisper_to_segments(json)?;
    store_segments(db, video_id, &segs).await
}
```

Replace the body of `store_raw_transcript_backup` to delegate:

```rust
pub async fn store_raw_transcript_backup(
    db: &Db,
    video_id: &str,
    json: &WhisperJson,
) -> AppResult<()> {
    let segs = whisper_to_segments(json)?;
    store_segments_backup(db, video_id, "raw_asr", &segs).await
}
```

- [ ] **Step 4: 运行 asr 全部测试，确认重构无回归**

Run: `cd src-tauri && CARGO_HOME=/home/node/.cargo cargo test --quiet asr::`
Expected: PASS（含原有 `parses_minimal_whisper_json`、`store_raw_backup_persists_full_asr_snapshot` 等）。

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/pipeline/asr.rs
git commit -m "refactor(asr): extract generic store_segments shared by whisper and subtitles"
```

---

## Task 4: 字幕入库消化（`pipeline/subtitle.rs`）

**Files:**
- Modify: `src-tauri/src/pipeline/subtitle.rs`

- [ ] **Step 1: 加 ingest 函数 + 失败测试**

In `src-tauri/src/pipeline/subtitle.rs`, add imports at top and the function:

```rust
use crate::db::Db;
use crate::error::AppResult;
use crate::llm::Provider;
use crate::pipeline::asr::{store_segments, store_segments_backup, StoredSegment};
use crate::pipeline::transcript_correction;
```

```rust
/// 消化一份 SRT 字幕：解析 → 存原始快照(bilibili_sub) → 写文稿 →（可选）AI 纠错。
/// 返回写入的段数。
pub async fn ingest_subtitle(
    db: &Db,
    video_id: &str,
    srt_text: &str,
    correct: Option<(Provider, String)>,
) -> AppResult<usize> {
    let segs: Vec<StoredSegment> = parse_srt(srt_text)
        .into_iter()
        .map(|s| StoredSegment {
            start_ms: s.start_ms,
            end_ms: s.end_ms,
            text: s.text,
            words_json: "[]".into(),
        })
        .collect();
    store_segments_backup(db, video_id, "bilibili_sub", &segs).await?;
    let count = store_segments(db, video_id, &segs).await?;
    if let Some((provider, model)) = correct {
        transcript_correction::autocorrect_transcript(db, &provider, &model, video_id).await?;
    }
    Ok(count)
}
```

Add test (extend the `tests` module):

```rust
    #[tokio::test]
    async fn ingest_writes_segments_without_correction() {
        let dir = tempfile::tempdir().unwrap();
        let db = crate::db::Db::connect_and_migrate(&dir.path().join("t.db")).await.unwrap();
        let course = crate::commands::courses::create_course(
            &db, "c".into(), dir.path().to_string_lossy().into()).await.unwrap();
        let vpath = dir.path().join("v.mp4");
        std::fs::write(&vpath, b"x").unwrap();
        let video = crate::commands::videos::add_local_video(&db, &course.id, vpath, None)
            .await.unwrap();

        let srt = "1\n00:00:00,000 --> 00:00:01,000\n第一句\n\n2\n00:00:01,000 --> 00:00:02,000\n第二句";
        let n = ingest_subtitle(&db, &video.id, srt, None).await.unwrap();
        assert_eq!(n, 2);
        let cnt: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM transcripts WHERE video_id=?")
            .bind(&video.id).fetch_one(&db.pool).await.unwrap();
        assert_eq!(cnt, 2);
    }
```

- [ ] **Step 2: 运行测试**

Run: `cd src-tauri && CARGO_HOME=/home/node/.cargo cargo test --quiet subtitle::`
Expected: PASS（含解析 3 个 + ingest 1 个）。

- [ ] **Step 3: Commit**

```bash
git add src-tauri/src/pipeline/subtitle.rs
git commit -m "feat(subtitle): ingest SRT into transcripts with optional AI correction"
```

---

## Task 5: 流水线接入字幕分支（`pipeline/mod.rs`）

字幕分支是 AppHandle 胶水，不做单测（沙箱无 fixtures），靠编译 + 手动验证。逻辑主体已在 `ingest_subtitle`（Task 4 已测）。

**Files:**
- Modify: `src-tauri/src/pipeline/mod.rs`（ASR 阶段，约 158-301 行之间）

- [ ] **Step 1: 在 ASR 阶段开头插入字幕分支**

In `run_all`, immediately after `jobs::start(&db, &asr_job.id).await?;` and the first `emit_running_progress(... "准备识别引擎")` (around line 159), insert:

```rust
    // 若该视频带「待用 B站字幕」，直接用字幕作文稿，跳过语音转写。
    if let Some(sub_path) = video.subtitle_path.clone().filter(|p| std::path::Path::new(p).is_file()) {
        emit_running_progress(&app, &db, &video_id, &asr_job.id, 0.3, "导入 B站自带字幕").await?;
        let srt_text = tokio::fs::read_to_string(&sub_path).await?;

        // 是否对字幕走 AI 纠错：设置开关 + 有可用大模型。
        let autocorrect = sqlx::query_scalar::<_, String>(
            "SELECT value FROM settings WHERE key='subtitle_autocorrect'")
            .fetch_optional(&db.pool).await?
            .map(|v| v != "false")
            .unwrap_or(true);
        let correct = if autocorrect {
            crate::commands::ai::first_available_provider_for_db(&db).await?
        } else {
            None
        };
        if correct.is_some() {
            emit_running_progress(&app, &db, &video_id, &asr_job.id, 0.6, "正在 AI 纠正字幕").await?;
        }

        let count = subtitle::ingest_subtitle(&db, &video_id, &srt_text, correct).await?;

        // 消化完成：清空 path（保留 lang 作来源展示），标记完成。
        sqlx::query("UPDATE videos SET subtitle_path=NULL, processed_status='done' WHERE id=?")
            .bind(&video_id).execute(&db.pool).await?;
        let msg = format!("{count} segments（来源：B站字幕）");
        jobs::update_progress(&db, &asr_job.id, 1.0, Some(&msg)).await?;
        jobs::finish(&db, &asr_job.id).await?;
        emit_update(&app, JobEvent {
            video_id: video_id.clone(),
            job_id: asr_job.id.clone(),
            stage: "asr".into(),
            status: "done".into(),
            progress: 1.0,
            message: Some(msg),
        });
        run_ai_followups(&app, &db, &video_id, &jobs_list).await;
        return Ok(());
    }
```

Note: `subtitle` is reachable as `crate::pipeline::subtitle` within `mod.rs`; use `subtitle::ingest_subtitle` (the module is declared in this file). `video` is already loaded at the top of `run_all` via `SELECT * FROM videos`.

- [ ] **Step 2: 确认编译通过**

Run: `cd src-tauri && CARGO_HOME=/home/node/.cargo cargo build`
Expected: 编译通过（如报 `subtitle` 未解析，确认 Task 2 Step 1 的 `pub mod subtitle;` 已加）。

- [ ] **Step 3: 跑全部 pipeline 测试确认无回归**

Run: `cd src-tauri && CARGO_HOME=/home/node/.cargo cargo test --quiet pipeline`
Expected: PASS（沙箱会跳过需 whisper/ffmpeg fixture 的用例）。

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/pipeline/mod.rs
git commit -m "feat(pipeline): use Bilibili subtitle as transcript, skipping ASR when present"
```

---

## Task 6: yt-dlp 参数加清晰度 + 字幕（`pipeline/download.rs`）

**Files:**
- Modify: `src-tauri/src/pipeline/download.rs`

- [ ] **Step 1: 改 `build_ytdlp_args` 签名 + 失败测试**

Replace `build_ytdlp_args` with:

```rust
/// 构造 yt-dlp 参数：输出 mp4，可选 cookies、清晰度上限、字幕轨。
pub fn build_ytdlp_args(
    url: &str,
    out_template: &str,
    cookies: Option<&str>,
    max_height: Option<u32>,
    sub_lang: Option<&str>,
) -> Vec<String> {
    let mut args = vec![
        "-o".to_string(),
        out_template.to_string(),
        "--merge-output-format".to_string(),
        "mp4".to_string(),
        "--no-playlist".to_string(),
    ];
    if let Some(h) = max_height {
        args.push("-f".to_string());
        args.push(format!("bv*[height<={h}]+ba/b[height<={h}]"));
    }
    if let Some(lang) = sub_lang {
        if !lang.trim().is_empty() {
            args.push("--write-subs".to_string());
            args.push("--sub-langs".to_string());
            args.push(lang.to_string());
            args.push("--convert-subs".to_string());
            args.push("srt".to_string());
        }
    }
    if is_bilibili_url(url) {
        args.push("--user-agent".to_string());
        args.push(BROWSER_USER_AGENT.to_string());
        args.push("--referer".to_string());
        args.push(BILIBILI_REFERER.to_string());
    }
    if let Some(c) = cookies {
        if !c.trim().is_empty() {
            args.push("--cookies".to_string());
            args.push(c.to_string());
        }
    }
    args.push(url.to_string());
    args
}
```

Update the existing tests in the file to the new signature (add `None, None` where quality/sub were absent), and add two new tests:

```rust
    #[test]
    fn ytdlp_args_with_quality_and_subs() {
        let args = build_ytdlp_args("https://www.bilibili.com/video/BV1x", "t", None, Some(720), Some("ai-zh"));
        let f = args.iter().position(|a| a == "-f").unwrap();
        assert_eq!(args[f + 1], "bv*[height<=720]+ba/b[height<=720]");
        assert!(args.contains(&"--write-subs".to_string()));
        let sl = args.iter().position(|a| a == "--sub-langs").unwrap();
        assert_eq!(args[sl + 1], "ai-zh");
    }

    #[test]
    fn ytdlp_args_no_quality_no_subs() {
        let args = build_ytdlp_args("https://b23.tv/x", "t", None, None, None);
        assert!(!args.contains(&"-f".to_string()));
        assert!(!args.contains(&"--write-subs".to_string()));
    }
```

(Existing tests `ytdlp_args_basic`, `ytdlp_args_with_cookies`, `ytdlp_args_ignore_blank_cookies`, `ytdlp_args_add_bilibili_headers` must update their `build_ytdlp_args(...)` calls to pass the two new `None` args.)

- [ ] **Step 2: 改 `download` 透传新参数 + 返回字幕路径**

Replace `download` signature & body:

```rust
/// 下载结果：mp4 路径 + （若请求了字幕且落地）SRT 路径。
pub struct DownloadResult {
    pub video: PathBuf,
    pub subtitle: Option<PathBuf>,
}

/// 下载到 out_dir。max_height=None 取最高可用；sub_lang=Some 时一并下字幕。
pub async fn download(
    url: &str,
    out_dir: &Path,
    cookies: Option<&str>,
    max_height: Option<u32>,
    sub_lang: Option<&str>,
) -> AppResult<DownloadResult> {
    std::fs::create_dir_all(out_dir)?;
    let template = out_dir.join("%(title).80s.%(ext)s");
    let ytdlp = resolve(&YTDLP, None)?;
    let args = build_ytdlp_args(url, &template.to_string_lossy(), cookies, max_height, sub_lang);
    let output = Command::new(&ytdlp)
        .args(&args)
        .output()
        .await
        .map_err(|e| AppError::Pipeline(format!("yt-dlp spawn: {e}")))?;
    if !output.status.success() {
        return Err(AppError::Pipeline(format!(
            "yt-dlp failed: {}",
            String::from_utf8_lossy(&output.stderr)
        )));
    }
    let video = newest_with_ext(out_dir, "mp4")?
        .ok_or_else(|| AppError::Pipeline("yt-dlp produced no mp4".into()))?;
    let subtitle = if sub_lang.map(|l| !l.trim().is_empty()).unwrap_or(false) {
        newest_with_ext(out_dir, "srt")?
    } else {
        None
    };
    Ok(DownloadResult { video, subtitle })
}

/// 返回 out_dir 里扩展名为 ext 的最新文件。
fn newest_with_ext(out_dir: &Path, ext: &str) -> AppResult<Option<PathBuf>> {
    let mut newest: Option<(std::time::SystemTime, PathBuf)> = None;
    for entry in std::fs::read_dir(out_dir)? {
        let path = entry?.path();
        if path.extension().map(|e| e == ext).unwrap_or(false) {
            let mtime = path.metadata().and_then(|m| m.modified()).unwrap_or(std::time::UNIX_EPOCH);
            if newest.as_ref().map(|(t, _)| mtime > *t).unwrap_or(true) {
                newest = Some((mtime, path));
            }
        }
    }
    Ok(newest.map(|(_, p)| p))
}
```

- [ ] **Step 3: 运行 download 测试**

Run: `cd src-tauri && CARGO_HOME=/home/node/.cargo cargo test --quiet download::`
Expected: PASS（旧 4 个已更新签名 + 新 2 个）。

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/pipeline/download.rs
git commit -m "feat(download): yt-dlp quality selection + subtitle download"
```

---

## Task 7: 字幕轨 + 清晰度探测（`pipeline/download.rs`）

**Files:**
- Modify: `src-tauri/src/pipeline/download.rs`

- [ ] **Step 1: 加探测结构 + 纯解析函数 + 失败测试**

Add to `src-tauri/src/pipeline/download.rs` (top imports already have serde via crate? add `use serde::Serialize;`):

```rust
use serde::Serialize;

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct SubtitleTrack {
    pub lang: String,
    pub name: String,
    pub auto: bool, // ai-zh 等 AI 自动字幕为 true
}

#[derive(Debug, Clone, Serialize)]
pub struct ProbeResult {
    pub title: String,
    pub tracks: Vec<SubtitleTrack>,
    pub qualities: Vec<u32>, // 可选清晰度高度，降序去重
}

/// 解析 `yt-dlp -J` 输出：标题、字幕轨（subtitles map）、清晰度（formats.height）。
pub fn parse_probe_json(json: &str) -> AppResult<ProbeResult> {
    let v: serde_json::Value = serde_json::from_str(json).map_err(AppError::Json)?;
    let title = v.get("title").and_then(|t| t.as_str()).unwrap_or("video").to_string();

    let mut tracks = Vec::new();
    if let Some(subs) = v.get("subtitles").and_then(|s| s.as_object()) {
        for (lang, entries) in subs {
            // B站 AI 字幕语言码以 "ai-" 开头。
            let auto = lang.starts_with("ai-");
            let name = entries
                .as_array()
                .and_then(|a| a.first())
                .and_then(|e| e.get("name"))
                .and_then(|n| n.as_str())
                .unwrap_or(lang)
                .to_string();
            tracks.push(SubtitleTrack { lang: lang.clone(), name, auto });
        }
    }
    tracks.sort_by(|a, b| a.lang.cmp(&b.lang));

    let mut qualities: Vec<u32> = Vec::new();
    if let Some(formats) = v.get("formats").and_then(|f| f.as_array()) {
        for f in formats {
            if let Some(h) = f.get("height").and_then(|h| h.as_u64()) {
                if h > 0 {
                    qualities.push(h as u32);
                }
            }
        }
    }
    qualities.sort_unstable();
    qualities.dedup();
    qualities.reverse();

    Ok(ProbeResult { title, tracks, qualities })
}

/// 优选默认字幕轨：手打中文 CC > AI 中文 > 第一条。
pub fn pick_default_track(tracks: &[SubtitleTrack]) -> Option<&SubtitleTrack> {
    let manual_zh = tracks.iter().find(|t| {
        !t.auto && (t.lang.starts_with("zh") )
    });
    if manual_zh.is_some() {
        return manual_zh;
    }
    let ai_zh = tracks.iter().find(|t| t.lang == "ai-zh" || (t.auto && t.lang.contains("zh")));
    ai_zh.or_else(|| tracks.first())
}
```

Add tests:

```rust
    #[test]
    fn parse_probe_extracts_tracks_and_qualities() {
        let json = r#"{
            "title": "示例课程",
            "subtitles": {
                "ai-zh": [{"ext":"srt","name":"AI 中文"}],
                "zh-Hans": [{"ext":"srt","name":"中文（简体）"}]
            },
            "formats": [
                {"height": 360}, {"height": 720}, {"height": 720}, {"height": 1080}, {"height": 0}
            ]
        }"#;
        let r = parse_probe_json(json).unwrap();
        assert_eq!(r.title, "示例课程");
        assert_eq!(r.qualities, vec![1080, 720, 360]);
        assert_eq!(r.tracks.len(), 2);
        assert!(r.tracks.iter().any(|t| t.lang == "ai-zh" && t.auto));
        assert!(r.tracks.iter().any(|t| t.lang == "zh-Hans" && !t.auto));
    }

    #[test]
    fn parse_probe_no_subs() {
        let json = r#"{"title":"x","formats":[{"height":480}]}"#;
        let r = parse_probe_json(json).unwrap();
        assert!(r.tracks.is_empty());
        assert_eq!(r.qualities, vec![480]);
    }

    #[test]
    fn pick_default_prefers_manual_zh_then_ai() {
        let tracks = vec![
            SubtitleTrack { lang: "en".into(), name: "EN".into(), auto: false },
            SubtitleTrack { lang: "ai-zh".into(), name: "AI".into(), auto: true },
            SubtitleTrack { lang: "zh-Hans".into(), name: "CC".into(), auto: false },
        ];
        assert_eq!(pick_default_track(&tracks).unwrap().lang, "zh-Hans");

        let tracks2 = vec![
            SubtitleTrack { lang: "en".into(), name: "EN".into(), auto: false },
            SubtitleTrack { lang: "ai-zh".into(), name: "AI".into(), auto: true },
        ];
        assert_eq!(pick_default_track(&tracks2).unwrap().lang, "ai-zh");
    }
```

- [ ] **Step 2: 加 async `probe`**

```rust
/// 用 yt-dlp 探测视频元信息（字幕轨 + 清晰度）。
pub async fn probe(url: &str, cookies: Option<&str>) -> AppResult<ProbeResult> {
    let ytdlp = resolve(&YTDLP, None)?;
    let mut cmd = Command::new(&ytdlp);
    cmd.args(["-J", "--skip-download", "--no-playlist"]);
    if is_bilibili_url(url) {
        cmd.args(["--user-agent", BROWSER_USER_AGENT, "--referer", BILIBILI_REFERER]);
    }
    if let Some(c) = cookies {
        if !c.trim().is_empty() {
            cmd.args(["--cookies", c]);
        }
    }
    cmd.arg(url);
    let output = cmd
        .output()
        .await
        .map_err(|e| AppError::Pipeline(format!("yt-dlp spawn: {e}")))?;
    if !output.status.success() {
        return Err(AppError::Pipeline(format!(
            "yt-dlp probe failed: {}",
            String::from_utf8_lossy(&output.stderr)
        )));
    }
    parse_probe_json(&String::from_utf8_lossy(&output.stdout))
}
```

- [ ] **Step 3: 运行测试**

Run: `cd src-tauri && CARGO_HOME=/home/node/.cargo cargo test --quiet download::`
Expected: PASS（含 3 个新解析测试）。

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/pipeline/download.rs
git commit -m "feat(download): probe Bilibili subtitle tracks and qualities"
```

---

## Task 8: 命令层（`commands/tools.rs` + `lib.rs`）

**Files:**
- Modify: `src-tauri/src/commands/tools.rs`、`src-tauri/src/lib.rs`

- [ ] **Step 1: 改 `cmd_import_bilibili` 签名与实现**

Replace `cmd_import_bilibili` in `src-tauri/src/commands/tools.rs`:

```rust
/// 下载 B 站 / URL 视频到课程目录并登记。可选清晰度上限与字幕轨。
#[tauri::command]
pub async fn cmd_import_bilibili(
    state: State<'_, AppState>,
    course_id: String,
    url: String,
    max_height: Option<u32>,
    sub_lang: Option<String>,
) -> AppResult<Video> {
    let root_path: String = sqlx::query_scalar("SELECT root_path FROM courses WHERE id=?")
        .bind(&course_id)
        .fetch_one(&state.db.pool)
        .await?;
    let cookies = get_setting(&state.db, "bilibili_cookies").await?;
    let out_dir = PathBuf::from(&root_path);
    let result = download::download(
        &url,
        &out_dir,
        cookies.as_deref(),
        max_height,
        sub_lang.as_deref(),
    )
    .await?;
    let mut video = add_local_video(&state.db, &course_id, result.video, None).await?;
    sqlx::query("UPDATE videos SET source_type='bilibili', source_uri=? WHERE id=?")
        .bind(&url)
        .bind(&video.id)
        .execute(&state.db.pool)
        .await?;
    video.source_type = "bilibili".into();
    video.source_uri = Some(url);
    // 若下到了字幕，挂到 video 上供流水线消化。
    if let (Some(lang), Some(sub_path)) = (sub_lang.as_deref(), result.subtitle.as_ref()) {
        let p = sub_path.to_string_lossy().to_string();
        sqlx::query("UPDATE videos SET subtitle_path=?, subtitle_lang=? WHERE id=?")
            .bind(&p).bind(lang).bind(&video.id)
            .execute(&state.db.pool).await?;
        video.subtitle_path = Some(p);
        video.subtitle_lang = Some(lang.to_string());
    }
    Ok(video)
}
```

- [ ] **Step 2: 加 `cmd_probe_bilibili`**

```rust
/// 探测 B站视频的自带字幕轨与可选清晰度（带 cookie）。
#[tauri::command]
pub async fn cmd_probe_bilibili(
    state: State<'_, AppState>,
    url: String,
) -> AppResult<download::ProbeResult> {
    let cookies = get_setting(&state.db, "bilibili_cookies").await?;
    download::probe(&url, cookies.as_deref()).await
}
```

- [ ] **Step 3: 加 `cmd_set_bilibili_cookies`（复制 cookies.txt 进 appdata）**

```rust
/// 把用户选的 cookies.txt 复制进 appdata（稳定路径），写入 bilibili_cookies 设置。
#[tauri::command]
pub async fn cmd_set_bilibili_cookies(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    file_path: String,
) -> AppResult<()> {
    use tauri::Manager;
    let app_data = app
        .path()
        .app_data_dir()
        .map_err(|e| crate::error::AppError::Config(format!("app_data_dir: {e}")))?;
    let dest_dir = app_data.join("cookies");
    std::fs::create_dir_all(&dest_dir)?;
    let dest = dest_dir.join("bilibili.txt");
    std::fs::copy(&file_path, &dest)?;
    crate::commands::settings::set_setting(
        &state.db,
        "bilibili_cookies",
        &dest.to_string_lossy(),
    )
    .await
}
```

Add `use tauri::State;` already present; ensure `tauri::AppHandle`/`Manager` import compiles (use fully-qualified as above).

- [ ] **Step 4: 注册命令（`lib.rs`）**

In `src-tauri/src/lib.rs`, update the import (line ~31):

```rust
use crate::commands::tools::{
    cmd_import_bilibili, cmd_ocr_region, cmd_probe_bilibili, cmd_set_bilibili_cookies,
};
```

And add to `tauri::generate_handler![ ... ]` (near line 122-123, after `cmd_import_bilibili`):

```rust
            cmd_ocr_region,
            cmd_import_bilibili,
            cmd_probe_bilibili,
            cmd_set_bilibili_cookies
```

- [ ] **Step 5: 编译**

Run: `cd src-tauri && CARGO_HOME=/home/node/.cargo cargo build`
Expected: 编译通过。

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/commands/tools.rs src-tauri/src/lib.rs
git commit -m "feat(commands): probe/import Bilibili with subtitles + cookie import"
```

---

## Task 9: 前端 IPC 与类型（`ipc.ts` / `types.ts`）

**Files:**
- Modify: `src/lib/ipc.ts`、`src/lib/types.ts`

- [ ] **Step 1: 加类型**

In `src/lib/types.ts`, add:

```ts
export interface SubtitleTrack {
  lang: string;
  name: string;
  auto: boolean;
}

export interface ProbeResult {
  title: string;
  tracks: SubtitleTrack[];
  qualities: number[];
}
```

And add two optional fields to the existing `Video` interface (match backend):

```ts
  subtitle_path?: string | null;
  subtitle_lang?: string | null;
```

- [ ] **Step 2: 改/加 ipc.tools 封装**

In `src/lib/ipc.ts`, replace the `importBilibili` line and add new methods inside `tools`:

```ts
    importBilibili: (
      courseId: string,
      url: string,
      maxHeight?: number,
      subLang?: string,
    ): Promise<Video> =>
      invoke("cmd_import_bilibili", { courseId, url, maxHeight, subLang }),
    probeBilibili: (url: string): Promise<ProbeResult> =>
      invoke("cmd_probe_bilibili", { url }),
    setBilibiliCookies: (filePath: string): Promise<void> =>
      invoke("cmd_set_bilibili_cookies", { filePath }),
```

Ensure `ProbeResult` is imported in `ipc.ts`'s type import block from `@/lib/types`.

- [ ] **Step 3: 类型检查**

Run: `node_modules/.bin/tsc --noEmit`
Expected: 通过（BilibiliImportDialog 尚未引用，无未用报错）。

- [ ] **Step 4: Commit**

```bash
git add src/lib/ipc.ts src/lib/types.ts
git commit -m "feat(ipc): Bilibili probe/import/cookies bindings + types"
```

---

## Task 10: 导入向导（`BilibiliImportDialog.tsx`）

**Files:**
- Create: `src/components/BilibiliImportDialog.tsx`
- Modify: `src/components/ImportVideoDialog.tsx`（网络下载入口改为打开向导）

- [ ] **Step 1: 写向导组件**

Create `src/components/BilibiliImportDialog.tsx`:

```tsx
import { open } from "@tauri-apps/plugin-dialog";
import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { ipc } from "@/lib/ipc";
import type { ProbeResult } from "@/lib/types";

type Step = "url" | "cookie" | "probing" | "confirm";

export function BilibiliImportDialog({
  courseId,
  onClose,
}: {
  courseId: string;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [step, setStep] = useState<Step>("url");
  const [url, setUrl] = useState("");
  const [hasCookie, setHasCookie] = useState<boolean | null>(null);
  const [probe, setProbe] = useState<ProbeResult | null>(null);
  const [quality, setQuality] = useState<number | undefined>(undefined);
  const [subLang, setSubLang] = useState<string | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);

  const pickCookie = async () => {
    const file = await open({
      multiple: false,
      filters: [{ name: "cookies.txt", extensions: ["txt"] }],
    });
    if (!file || Array.isArray(file)) return;
    await ipc.tools.setBilibiliCookies(file);
    setHasCookie(true);
    void runProbe();
  };

  const runProbe = async () => {
    setError(null);
    setStep("probing");
    try {
      const r = await ipc.tools.probeBilibili(url.trim());
      setProbe(r);
      setQuality(r.qualities[0]);
      // 默认轨：手打中文 > ai-zh > 第一条
      const def =
        r.tracks.find((t) => !t.auto && t.lang.startsWith("zh")) ??
        r.tracks.find((t) => t.lang === "ai-zh") ??
        r.tracks[0];
      setSubLang(def?.lang);
      setStep("confirm");
    } catch (e) {
      setError(String(e));
      setStep("url");
    }
  };

  const startUrl = async () => {
    // 没 cookie 先引导，再探测。
    const cookie = await ipc.settings.get("bilibili_cookies");
    if (!cookie) {
      setHasCookie(false);
      setStep("cookie");
    } else {
      setHasCookie(true);
      void runProbe();
    }
  };

  const importMutation = useMutation({
    mutationFn: (useSub: boolean) =>
      ipc.tools.importBilibili(
        courseId,
        url.trim(),
        quality,
        useSub ? subLang : undefined,
      ),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["videos", courseId] });
      onClose();
    },
    onError: (e) => setError(String(e)),
  });

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={onClose}>
      <div
        className="w-[420px] rounded-2xl border border-[var(--border-subtle)] bg-[var(--surface-panel)] p-5 shadow-[var(--shadow-pop)]"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="mb-3 text-sm font-semibold text-[var(--text-strong)]">下载 B站视频</h2>

        {step === "url" && (
          <div className="space-y-3">
            <input
              aria-label="视频链接"
              className="w-full rounded-md border border-[var(--border-subtle)] bg-[var(--surface-input)] px-3 py-2 text-sm outline-none focus:border-primary/70"
              placeholder="B 站 / 视频链接…"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
            />
            {error && <p className="text-xs text-red-400">{error}</p>}
            <div className="flex justify-end gap-2">
              <Button size="sm" variant="outline" onClick={onClose}>取消</Button>
              <Button size="sm" disabled={!url.trim()} onClick={startUrl}>下一步</Button>
            </div>
          </div>
        )}

        {step === "cookie" && (
          <div className="space-y-3 text-sm text-[var(--text-muted)]">
            <p>
              B站自带字幕与高清晰度通常需要登录态。请用浏览器扩展
              <b className="text-[var(--text-strong)]"> Get cookies.txt LOCALLY </b>
              在 bilibili.com 导出 cookies.txt，然后选择它。
            </p>
            {error && <p className="text-xs text-red-400">{error}</p>}
            <div className="flex justify-end gap-2">
              <Button size="sm" variant="outline" onClick={() => setStep("url")}>返回</Button>
              <Button size="sm" onClick={pickCookie}>选择 cookies.txt</Button>
            </div>
          </div>
        )}

        {step === "probing" && (
          <p className="py-6 text-center text-sm text-[var(--text-muted)]">正在探测视频信息…</p>
        )}

        {step === "confirm" && probe && (
          <div className="space-y-4">
            <p className="text-xs text-[var(--text-faint)]">{probe.title}</p>

            <div>
              <div className="mb-1 text-xs font-medium text-[var(--text-muted)]">清晰度</div>
              <div className="flex flex-wrap gap-1.5">
                {probe.qualities.length === 0 && (
                  <span className="text-xs text-[var(--text-faint)]">用最高可用</span>
                )}
                {probe.qualities.map((q) => (
                  <button
                    key={q}
                    onClick={() => setQuality(q)}
                    className={`rounded px-2 py-1 text-xs ${quality === q ? "bg-primary/20 text-primary" : "bg-[var(--surface-card-hover)]"}`}
                  >
                    {q}P
                  </button>
                ))}
              </div>
            </div>

            {probe.tracks.length > 0 ? (
              <div>
                <div className="mb-1 text-xs font-medium text-[var(--text-muted)]">
                  检测到自带字幕，可用它替代 AI 转写
                </div>
                <select
                  className="w-full rounded-md border border-[var(--border-subtle)] bg-[var(--surface-input)] px-2 py-1.5 text-sm"
                  value={subLang}
                  onChange={(e) => setSubLang(e.target.value)}
                >
                  {probe.tracks.map((t) => (
                    <option key={t.lang} value={t.lang}>
                      {t.name}{t.auto ? "（AI）" : ""}
                    </option>
                  ))}
                </select>
              </div>
            ) : (
              <p className="text-xs text-[var(--text-faint)]">未检测到自带字幕，将用语音转写。</p>
            )}

            {error && <p className="text-xs text-red-400">{error}</p>}
            <div className="flex justify-end gap-2">
              {probe.tracks.length > 0 && (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={importMutation.isPending}
                  onClick={() => importMutation.mutate(false)}
                >
                  不用字幕
                </Button>
              )}
              <Button
                size="sm"
                disabled={importMutation.isPending}
                onClick={() => importMutation.mutate(probe.tracks.length > 0)}
              >
                {importMutation.isPending
                  ? "下载中…"
                  : probe.tracks.length > 0
                    ? "用所选字幕下载"
                    : "下载"}
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: 入口改为打开向导**

In `src/components/ImportVideoDialog.tsx`: remove the inline `network` mutation + URL input block, and instead render a button that opens `BilibiliImportDialog`. Concretely:

1. Add import: `import { BilibiliImportDialog } from "./BilibiliImportDialog";`
2. Add state: `const [showBili, setShowBili] = useState(false);`
3. Remove the `network` mutation (lines ~31-38) and the entire "下载网络视频" block (the `<div className="px-2.5 py-2">…</div>`), replacing it with:

```tsx
            <button
              onClick={() => {
                setMenuOpen(false);
                setShowBili(true);
              }}
              className="flex w-full items-start gap-2.5 rounded-lg px-2.5 py-2 text-left hover:bg-[var(--surface-card-hover)]"
            >
              <Download className="mt-0.5 h-4 w-4 flex-none text-primary" />
              <span className="min-w-0">
                <span className="block text-sm font-medium text-[var(--text-strong)]">
                  下载网络视频
                </span>
                <span className="block text-xs text-[var(--text-muted)]">
                  B 站 / 链接，可选清晰度与自带字幕
                </span>
              </span>
            </button>
```

4. After the menu `</div>` (before the component's closing `</div>`), render the dialog:

```tsx
      {showBili && (
        <BilibiliImportDialog courseId={courseId} onClose={() => setShowBili(false)} />
      )}
```

5. Remove now-unused `url`/`setUrl` state if no longer referenced.

- [ ] **Step 3: 加一个轻量渲染测试**

Create `src/components/BilibiliImportDialog.test.tsx`（沿用项目既有 render pattern，见 `src/components/VideoPlayer/CaptionOverlay.test.tsx`：`@testing-library/react` ^16.3.2 已装）：

```tsx
import "@testing-library/jest-dom/vitest";
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BilibiliImportDialog } from "./BilibiliImportDialog";

vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));
vi.mock("@/lib/ipc", () => ({ ipc: { tools: {}, settings: {} } }));

describe("BilibiliImportDialog", () => {
  it("starts at the URL step", () => {
    const qc = new QueryClient();
    render(
      <QueryClientProvider client={qc}>
        <BilibiliImportDialog courseId="c1" onClose={() => {}} />
      </QueryClientProvider>,
    );
    expect(screen.getByLabelText("视频链接")).toBeTruthy();
    expect(screen.getByText("下一步")).toBeTruthy();
  });
});
```

- [ ] **Step 4: 跑测试 + 类型检查**

Run: `node_modules/.bin/vitest run src/components/BilibiliImportDialog.test.tsx`
Run: `node_modules/.bin/tsc --noEmit`
Expected: PASS / 无类型错误。

- [ ] **Step 5: Commit**

```bash
git add src/components/BilibiliImportDialog.tsx src/components/BilibiliImportDialog.test.tsx src/components/ImportVideoDialog.tsx
git commit -m "feat(ui): Bilibili import wizard with quality + subtitle selection"
```

---

## Task 11: 字幕纠错开关（设置页）

**Files:**
- Modify: `src/components/SettingsDialog.tsx`

- [ ] **Step 1: 加开关**

In `src/components/SettingsDialog.tsx`, in the「转写 / 纠错」区（找到现有 `asr_language` / `asr_correction_concurrency` 设置项附近），加一个布尔开关，读写设置键 `subtitle_autocorrect`（默认 `true`，存 `"true"`/`"false"`）。沿用该文件已有的 setting 读写 pattern（`ipc.settings.get`/`ipc.settings.set` + 本地 state）。示例：

```tsx
// 读取（在初始化 effect 里，与其它设置一并）：
const v = await ipc.settings.get("subtitle_autocorrect");
setSubtitleAutocorrect(v !== "false");

// 写入（onChange）：
const onToggleSubtitleAutocorrect = async (next: boolean) => {
  setSubtitleAutocorrect(next);
  await ipc.settings.set("subtitle_autocorrect", next ? "true" : "false");
};
```

UI：一行 label「导入字幕后用 AI 纠错」+ 一个 checkbox/toggle，绑定 `subtitleAutocorrect` / `onToggleSubtitleAutocorrect`。

- [ ] **Step 2: 类型检查**

Run: `node_modules/.bin/tsc --noEmit`
Expected: 通过。

- [ ] **Step 3: Commit**

```bash
git add src/components/SettingsDialog.tsx
git commit -m "feat(settings): toggle for AI-correcting imported subtitles"
```

---

## Task 12: 本机真实联调（手动）

沙箱无 yt-dlp，此步在用户本机执行，用真实 cookie 验证 `-J` JSON 与下载落地命名。

- [ ] **Step 1: 验证探测 JSON 结构**

在装了 yt-dlp 的本机，对一个真实 B站视频跑：

```bash
yt-dlp -J --skip-download --cookies "/path/to/www.bilibili.com_cookies.txt" "<BV链接>" | python3 -m json.tool | less
```

确认 `subtitles` map 的 key 形如 `ai-zh` / `zh-Hans`，`formats[].height` 有多档。若 B站 AI 字幕实际落在 `automatic_captions` 而非 `subtitles`，则在 `parse_probe_json` 里同时合并解析 `automatic_captions`（追加一个分支，auto=true）。

- [ ] **Step 2: 验证字幕下载落地命名**

```bash
yt-dlp --write-subs --sub-langs ai-zh --convert-subs srt -o "test.%(ext)s" --cookies "<cookies>" "<BV链接>"
ls test*.srt   # 期望形如 test.ai-zh.srt
```

确认与 `newest_with_ext(out_dir, "srt")` 能匹配。若命名不同，调整定位逻辑。

- [ ] **Step 3: 端到端**

应用内：导入 B站链接 → 引导 cookie → 选清晰度 + 字幕 → 下载 → 文稿面板出现字幕内容、可点时间戳；不带字幕的链接走原 ASR 流程。

---

## 完成标准

- 探测能列出字幕轨与清晰度；选字幕后导入，文稿来自字幕、流水线跳过 ASR；不选则走原 ASR。
- 下载前可选清晰度（`-f bv*[height<=H]`）。
- cookie 经 Get cookies.txt LOCALLY 导出后一次配置、下载与探测共用。
- `subtitle_autocorrect` 开关控制字幕是否走 AI 纠错。
- 所有 Rust/前端单测通过；本机真实联调通过。
