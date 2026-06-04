# ASR AI Transcript Correction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Automatically replace raw ASR transcript text with an AI-corrected transcript when a usable LLM profile exists, while silently falling back to the raw transcript and keeping a backend-only raw snapshot.

**Architecture:** Keep `transcripts` as the single source of truth for the current transcript seen by the UI and downstream AI features. Add a backend-only `transcript_backups` snapshot table, a focused `pipeline/transcript_correction.rs` module for prompt/parse/apply logic, and wire correction into the existing `asr` stage without adding a new top-level job stage.

**Tech Stack:** Tauri 2, Rust, SQLx + SQLite migrations, existing `Provider` LLM abstraction, Vitest-free Rust-first testing with `cargo test`

---

## File Structure

- Create: `src-tauri/migrations/0007_transcript_backups.sql`
  - Adds the raw-ASR snapshot table.
- Create: `src-tauri/src/pipeline/transcript_correction.rs`
  - Owns correction request batching, JSON parsing, timestamp validation, and transcript overwrite helpers.
- Modify: `src-tauri/src/pipeline/mod.rs`
  - Calls raw backup storage, optional correction, and final ASR status messaging.
- Modify: `src-tauri/src/pipeline/asr.rs`
  - Exposes raw transcript snapshot persistence helpers next to existing ASR storage logic.
- Modify: `src-tauri/src/commands/ai.rs`
  - Adds “first usable LLM profile” lookup for the auto-correction path.
- Modify: `src-tauri/src/llm/prompts.rs`
  - Adds the transcript-correction prompt and prompt-level regression tests.
- Modify: `src-tauri/src/pipeline/ai.rs`
  - Reuses existing transcript consumer tests to confirm corrected text is what downstream generators read.

### Task 1: Add Raw ASR Backup Persistence

**Files:**
- Create: `src-tauri/migrations/0007_transcript_backups.sql`
- Modify: `src-tauri/src/pipeline/asr.rs`
- Test: `src-tauri/src/pipeline/asr.rs`

- [ ] **Step 1: Write the failing storage tests**

```rust
#[tokio::test]
async fn store_raw_backup_persists_full_asr_snapshot() {
    let dir = tempdir().unwrap();
    let db = Db::connect_and_migrate(&dir.path().join("t.db")).await.unwrap();
    let json = WhisperJson {
        transcription: vec![WhisperSegment {
            text: " 原始结果 ".into(),
            offsets: Offsets { from: 0, to: 1200 },
            tokens: vec![TokenObj {
                text: "原始结果".into(),
                offsets: Offsets { from: 0, to: 1200 },
            }],
        }],
    };

    store_raw_transcript_backup(&db, "video-1", &json).await.unwrap();

    let row: (String, String) = sqlx::query_as(
        "SELECT source, segments_json FROM transcript_backups WHERE video_id=?",
    )
    .bind("video-1")
    .fetch_one(&db.pool)
    .await
    .unwrap();

    assert_eq!(row.0, "raw_asr");
    assert!(row.1.contains("\"start_ms\":0"));
    assert!(row.1.contains("\"text\":\"原始结果\""));
}
```

Run: `cd /Users/yulang/projects/ai 视频学习/course-ai/src-tauri && cargo test pipeline::asr::tests::store_raw_backup_persists_full_asr_snapshot -- --nocapture`  
Expected: FAIL with `no such table: transcript_backups` or missing function errors.

- [ ] **Step 2: Add the migration**

```sql
CREATE TABLE transcript_backups (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  video_id TEXT NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
  source TEXT NOT NULL CHECK (source IN ('raw_asr')),
  segments_json TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX idx_transcript_backups_video_created
  ON transcript_backups(video_id, created_at DESC);
```

- [ ] **Step 3: Implement snapshot serialization in `asr.rs`**

```rust
#[derive(Debug, Serialize, Deserialize)]
struct TranscriptBackupSegment {
    segment_idx: i64,
    start_ms: i64,
    end_ms: i64,
    text: String,
    words_json: String,
}

pub async fn store_raw_transcript_backup(
    db: &Db,
    video_id: &str,
    json: &WhisperJson,
) -> AppResult<()> {
    let segments = json
        .transcription
        .iter()
        .enumerate()
        .map(|(idx, segment)| TranscriptBackupSegment {
            segment_idx: idx as i64,
            start_ms: segment.offsets.from,
            end_ms: segment.offsets.to,
            text: segment.text.trim().to_string(),
            words_json: serde_json::to_string(&segment.tokens)?,
        })
        .collect::<AppResult<Vec<_>>>()?;

    sqlx::query(
        "INSERT INTO transcript_backups(video_id,source,segments_json,created_at)
         VALUES (?,?,?,?)",
    )
    .bind(video_id)
    .bind("raw_asr")
    .bind(serde_json::to_string(&segments)?)
    .bind(chrono::Utc::now().timestamp_millis())
    .execute(&db.pool)
    .await?;
    Ok(())
}
```

- [ ] **Step 4: Run the focused test and the existing ASR tests**

Run: `cd /Users/yulang/projects/ai 视频学习/course-ai/src-tauri && cargo test pipeline::asr::tests -- --nocapture`  
Expected: PASS, including the new backup test and existing `store_transcripts`-adjacent tests.

- [ ] **Step 5: Commit**

```bash
git -C /Users/yulang/projects/ai\ 视频学习/course-ai add \
  src-tauri/migrations/0007_transcript_backups.sql \
  src-tauri/src/pipeline/asr.rs
git -C /Users/yulang/projects/ai\ 视频学习/course-ai commit -m "feat(asr): back up raw transcript snapshots"
```

### Task 2: Add Transcript Correction Prompt, Parser, and Apply Logic

**Files:**
- Create: `src-tauri/src/pipeline/transcript_correction.rs`
- Modify: `src-tauri/src/pipeline/mod.rs`
- Modify: `src-tauri/src/llm/prompts.rs`
- Test: `src-tauri/src/pipeline/transcript_correction.rs`
- Test: `src-tauri/src/llm/prompts.rs`

- [ ] **Step 1: Write failing prompt and parser tests**

```rust
#[test]
fn transcript_correction_prompt_requires_compact_json_output() {
    let req = transcript_correction_request(
        "m",
        r#"[{"start_ms":0,"end_ms":1000,"text":"嗯 今天讲概率"}]"#,
    );
    let system = req.system.unwrap();
    let user = &req.messages[0].content;

    for required in ["只输出 JSON", "start_ms", "end_ms", "text", "不要补充新知识"] {
        assert!(
            system.contains(required) || user.contains(required),
            "correction prompt should mention {required}"
        );
    }
}

#[test]
fn parse_corrections_rejects_timestamp_drift() {
    let raw = vec![CorrectionSegment {
        start_ms: 0,
        end_ms: 1000,
        text: "原文".into(),
    }];

    let err = parse_corrections(
        &raw,
        r#"[{"start_ms":0,"end_ms":2000,"text":"纠正文"}]"#,
    )
    .unwrap_err();

    assert!(err.to_string().contains("timestamp mismatch"));
}
```

Run: `cd /Users/yulang/projects/ai 视频学习/course-ai/src-tauri && cargo test llm::prompts::tests::transcript_correction_prompt_requires_compact_json_output pipeline::transcript_correction::tests::parse_corrections_rejects_timestamp_drift -- --nocapture`  
Expected: FAIL with unresolved function/module errors.

- [ ] **Step 2: Add the correction module and prompt**

```rust
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct CorrectionSegment {
    pub start_ms: i64,
    pub end_ms: i64,
    pub text: String,
}

pub fn transcript_correction_request(model: &str, batch_json: &str) -> ChatRequest {
    ChatRequest {
        model: model.to_string(),
        system: Some(
            "你是课程字幕纠错助手。只输出 JSON 数组，不要任何解释、标题或代码围栏。\
             只修正识别错误、病句、断句、标点和少量口语赘词；不要补充视频里没说过的新知识。\
             输出每项必须只有 start_ms、end_ms、text 三个字段。"
                .into(),
        ),
        cacheable_context: None,
        messages: vec![ChatMessage {
            role: "user".into(),
            content: format!("按原顺序纠正这些分段，尽量保持时间戳不变：\n{batch_json}"),
        }],
        temperature: 0.1,
        max_tokens: 2048,
    }
}
```

- [ ] **Step 3: Implement parsing, batching, and transcript overwrite helpers**

```rust
pub fn parse_corrections(
    raw: &[CorrectionSegment],
    content: &str,
) -> AppResult<Vec<CorrectionSegment>> {
    let corrected: Vec<CorrectionSegment> =
        serde_json::from_str(crate::pipeline::ai::strip_code_fence(content))?;

    if corrected.len() != raw.len() {
        return Err(AppError::Other("segment count mismatch".into()));
    }

    for (expected, actual) in raw.iter().zip(&corrected) {
        if expected.start_ms != actual.start_ms || expected.end_ms != actual.end_ms {
            return Err(AppError::Other("timestamp mismatch".into()));
        }
        if actual.text.trim().is_empty() {
            return Err(AppError::Other("empty corrected transcript text".into()));
        }
    }

    Ok(corrected)
}

pub async fn overwrite_transcript_texts(
    db: &Db,
    video_id: &str,
    corrected: &[CorrectionSegment],
) -> AppResult<()> {
    let rows = crate::commands::transcripts::list_segments(db, video_id).await?;
    if rows.len() != corrected.len() {
        return Err(AppError::Other("transcript row count mismatch".into()));
    }
    for (row, segment) in rows.iter().zip(corrected) {
        sqlx::query("UPDATE transcripts SET text=? WHERE id=?")
            .bind(segment.text.trim())
            .bind(row.id)
            .execute(&db.pool)
            .await?;
    }
    Ok(())
}
```

- [ ] **Step 4: Add a focused async test that corrected text becomes the downstream transcript**

```rust
#[tokio::test]
async fn overwrite_transcript_texts_updates_transcript_text_reader() {
    let (db, vid, _d) = seed_video_with_transcript().await;
    overwrite_transcript_texts(
        &db,
        &vid,
        &[CorrectionSegment {
            start_ms: 0,
            end_ms: 5000,
            text: "纠正后的讲解第一部分".into(),
        }],
    )
    .await
    .unwrap();

    let joined = crate::pipeline::ai::transcript_text(&db, &vid).await.unwrap();
    assert!(joined.contains("纠正后的讲解第一部分"));
}
```

Run: `cd /Users/yulang/projects/ai 视频学习/course-ai/src-tauri && cargo test llm::prompts::tests::transcript_correction_prompt_requires_compact_json_output pipeline::transcript_correction::tests -- --nocapture`  
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git -C /Users/yulang/projects/ai\ 视频学习/course-ai add \
  src-tauri/src/llm/prompts.rs \
  src-tauri/src/pipeline/mod.rs \
  src-tauri/src/pipeline/transcript_correction.rs
git -C /Users/yulang/projects/ai\ 视频学习/course-ai commit -m "feat(ai): add transcript correction pipeline"
```

### Task 3: Resolve the First Usable LLM Profile and Wire Correction into the ASR Stage

**Files:**
- Modify: `src-tauri/src/commands/ai.rs`
- Modify: `src-tauri/src/pipeline/mod.rs`
- Test: `src-tauri/src/commands/ai.rs`
- Test: `src-tauri/src/pipeline/mod.rs`

- [ ] **Step 1: Write the failing provider-selection and fallback tests**

```rust
#[tokio::test]
async fn first_available_provider_skips_profiles_without_keys() {
    let dir = tempdir().unwrap();
    let db = crate::db::Db::connect_and_migrate(&dir.path().join("t.db")).await.unwrap();
    crate::commands::settings::set_setting(
        &db,
        "llm_profiles",
        r#"[
          {"id":"no-key","name":"A","kind":"openai","base_url":"https://api.openai.com/v1","model":"gpt-4o-mini"},
          {"id":"with-key","name":"B","kind":"openai","base_url":"https://api.openai.com/v1","model":"gpt-4o-mini"}
        ]"#,
    )
    .await
    .unwrap();
    crate::llm::keychain::set_api_key(&db, "with-key", "sk-test").await.unwrap();

    let (_, model) = first_available_provider_for_db(&db).await.unwrap().unwrap();
    assert_eq!(model, "gpt-4o-mini");
}
```

```rust
#[test]
fn asr_done_message_mentions_raw_transcript_when_no_provider_exists() {
    let msg = asr_done_message(12, TranscriptCorrectionOutcome::NoProvider);
    assert_eq!(msg, "12 segments；未配置大模型，当前为原始文稿");
}
```

Run: `cd /Users/yulang/projects/ai 视频学习/course-ai/src-tauri && cargo test commands::ai::tests::first_available_provider_skips_profiles_without_keys pipeline::tests::asr_done_message_mentions_raw_transcript_when_no_provider_exists -- --nocapture`  
Expected: FAIL with missing helper/test names.

- [ ] **Step 2: Implement first-usable-profile lookup in `commands/ai.rs`**

```rust
pub async fn first_available_provider_for_db(
    db: &crate::db::Db,
) -> AppResult<Option<(crate::llm::Provider, String)>> {
    let profiles = parse_profiles(get_setting(db, "llm_profiles").await?.as_deref())?;
    for profile in profiles {
        let Some(key) = keychain::get_api_key(db, &profile.id).await? else {
            continue;
        };
        return Ok(Some((build_provider(&profile, key), profile.model.clone())));
    }
    Ok(None)
}
```

```rust
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum TranscriptCorrectionOutcome {
    Applied,
    NoProvider,
    Failed,
}

fn asr_done_message(count: usize, outcome: TranscriptCorrectionOutcome) -> String {
    match outcome {
        TranscriptCorrectionOutcome::Applied => format!("{count} segments"),
        TranscriptCorrectionOutcome::NoProvider => {
            format!("{count} segments；未配置大模型，当前为原始文稿")
        }
        TranscriptCorrectionOutcome::Failed => {
            format!("{count} segments；AI 纠错失败，已保留原始文稿")
        }
    }
}
```

- [ ] **Step 3: Wire the correction attempt into the ASR success path**

```rust
emit_running_progress(&app, &db, &video_id, &asr_job.id, 0.92, "解析识别结果").await?;
asr::store_raw_transcript_backup(&db, &video_id, &json).await?;
emit_running_progress(&app, &db, &video_id, &asr_job.id, 0.95, "写入原始文稿").await?;
let count = asr::store_transcripts(&db, &video_id, &json).await?;

let final_message = match crate::commands::ai::first_available_provider_for_db(&db).await? {
    Some((provider, model)) => {
        emit_running_progress(&app, &db, &video_id, &asr_job.id, 0.98, "正在 AI 纠正文稿").await?;
        match crate::pipeline::transcript_correction::autocorrect_transcript(
            &db,
            &provider,
            &model,
            &video_id,
        )
        .await
        {
            Ok(()) => asr_done_message(count, TranscriptCorrectionOutcome::Applied),
            Err(error) => {
                eprintln!("transcript correction skipped after failure: {error}");
                asr_done_message(count, TranscriptCorrectionOutcome::Failed)
            }
        }
    }
    None => asr_done_message(count, TranscriptCorrectionOutcome::NoProvider),
};
```

- [ ] **Step 4: Run targeted tests plus the existing pipeline/AI suites**

Run: `cd /Users/yulang/projects/ai 视频学习/course-ai/src-tauri && cargo test commands::ai::tests pipeline::tests pipeline::asr::tests -- --nocapture`  
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git -C /Users/yulang/projects/ai\ 视频学习/course-ai add \
  src-tauri/src/commands/ai.rs \
  src-tauri/src/pipeline/mod.rs
git -C /Users/yulang/projects/ai\ 视频学习/course-ai commit -m "feat(pipeline): auto-correct ASR transcripts when llm is configured"
```

### Task 4: End-to-End Verification and Diff Hygiene

**Files:**
- Modify: none expected
- Test: `src-tauri/src/pipeline/asr.rs`
- Test: `src-tauri/src/pipeline/transcript_correction.rs`
- Test: `src-tauri/src/commands/ai.rs`
- Test: `src-tauri/src/pipeline/mod.rs`

- [ ] **Step 1: Run the full Rust test suite for touched areas**

Run:

```bash
cd /Users/yulang/projects/ai\ 视频学习/course-ai/src-tauri
cargo test pipeline::asr::tests -- --nocapture
cargo test pipeline::transcript_correction::tests -- --nocapture
cargo test commands::ai::tests -- --nocapture
cargo test pipeline::tests -- --nocapture
```

Expected: all targeted suites PASS.

- [ ] **Step 2: Run a broader regression sweep**

Run:

```bash
cd /Users/yulang/projects/ai\ 视频学习/course-ai/src-tauri
cargo test -- --nocapture
```

Expected: PASS, or only pre-existing environment skips such as missing local whisper fixtures.

- [ ] **Step 3: Check whitespace and isolate the intended diff**

Run:

```bash
git -C /Users/yulang/projects/ai\ 视频学习/course-ai diff --check
git -C /Users/yulang/projects/ai\ 视频学习/course-ai status --short
```

Expected:
- `git diff --check` prints nothing
- status shows only the planned Rust/migration/doc changes plus the user’s pre-existing `CaptionOverlay` edits

- [ ] **Step 4: Commit the final polish if verification changed code**

```bash
git -C /Users/yulang/projects/ai\ 视频学习/course-ai add \
  src-tauri/migrations/0007_transcript_backups.sql \
  src-tauri/src/commands/ai.rs \
  src-tauri/src/llm/prompts.rs \
  src-tauri/src/pipeline/asr.rs \
  src-tauri/src/pipeline/mod.rs \
  src-tauri/src/pipeline/transcript_correction.rs
git -C /Users/yulang/projects/ai\ 视频学习/course-ai commit -m "test: verify transcript auto-correction flow"
```

## Self-Review

- Spec coverage:
  - raw ASR backup storage: Task 1
  - compact correction prompt + JSON-only output: Task 2
  - keep `transcripts` as current transcript source: Tasks 2-3
  - first usable LLM profile auto-run: Task 3
  - correction failure falls back to raw transcript without failing pipeline: Task 3
  - downstream transcript consumers read corrected text: Tasks 2-3
  - verification and diff hygiene: Task 4
- Placeholder scan:
  - no `TODO`, `TBD`, or “handle later” markers remain
  - every code-changing step includes a concrete code block
- Type consistency:
  - correction payload uses `start_ms`, `end_ms`, `text` consistently across prompt, parser, and overwrite logic
  - provider helper is named `first_available_provider_for_db` consistently in tests and implementation

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-06-03-asr-ai-transcript-correction.md`. Two execution options:

**1. Subagent-Driven (recommended)** - I dispatch a fresh subagent per task, review between tasks, fast iteration

**2. Inline Execution** - Execute tasks in this session using executing-plans, batch execution with checkpoints

Which approach?
