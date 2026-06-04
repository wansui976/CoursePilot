//! 进程内 LLM 调试日志：记录「发给模型的请求」与「模型的回复」，供前端「开发控制台」
//! 查看，用来确认 AI 纠错等调用是否真的发生、结果是否被采用。
//!
//! 环形缓冲、仅存最近若干条、进程重启即清空；零持久化、开销很小。

use crate::error::AppResult;
use serde::Serialize;
use std::collections::VecDeque;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};

const MAX_ENTRIES: usize = 200;

#[derive(Debug, Clone, Serialize)]
pub struct DevLogEntry {
    pub id: u64,
    pub at_ms: i64,
    pub kind: String,
    pub video_id: String,
    pub request: String,
    pub response: String,
    pub status: String,
}

fn store() -> &'static Mutex<VecDeque<DevLogEntry>> {
    static STORE: OnceLock<Mutex<VecDeque<DevLogEntry>>> = OnceLock::new();
    STORE.get_or_init(|| Mutex::new(VecDeque::new()))
}

fn next_id() -> u64 {
    static COUNTER: AtomicU64 = AtomicU64::new(1);
    COUNTER.fetch_add(1, Ordering::Relaxed)
}

/// 记录一次 LLM 交互。`request` 是发出的内容，`response` 是模型回复，
/// `status` 描述结果（如「已应用」「解析失败: …」）。
pub fn record(kind: &str, video_id: &str, request: &str, response: &str, status: &str) {
    let entry = DevLogEntry {
        id: next_id(),
        at_ms: chrono::Utc::now().timestamp_millis(),
        kind: kind.into(),
        video_id: video_id.into(),
        request: request.into(),
        response: response.into(),
        status: status.into(),
    };
    let mut guard = store().lock().unwrap();
    guard.push_back(entry);
    while guard.len() > MAX_ENTRIES {
        guard.pop_front();
    }
}

/// 返回全部日志，最新的在前。
pub fn entries() -> Vec<DevLogEntry> {
    store().lock().unwrap().iter().rev().cloned().collect()
}

pub fn clear() {
    store().lock().unwrap().clear();
}

#[tauri::command]
pub async fn cmd_get_dev_logs() -> AppResult<Vec<DevLogEntry>> {
    Ok(entries())
}

#[tauri::command]
pub async fn cmd_clear_dev_logs() -> AppResult<()> {
    clear();
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn records_then_clears() {
        record("test", "vid", "REQ-MARKER-9z", "resp", "已应用");
        assert!(entries().iter().any(|e| e.request == "REQ-MARKER-9z"));
        clear();
        assert!(entries().iter().all(|e| e.request != "REQ-MARKER-9z"));
    }
}
