//! 网盘上同步记录的压缩与清理。
//!
//! 每台设备只往自己的 `devices/<id>/batches/` 里追加批次，时间一长文件越来越多：新设备加入时
//! 要一个个读完，同一条记录（一份字幕重新识别了五次）也存了五份。压缩把一段批次折成一份
//! 「底稿」——每条记录只留这台设备写过的最新一份——再把折进去的批次删掉：
//!
//! ```text
//! devices/<id>/batches/base-000000000250.json   底稿清单：覆盖到第 250 批，由哪几份文件组成
//! devices/<id>/base/<内容哈希>.json              底稿的一份（信封数组）
//! devices/<id>/batches/000000000251.json         底稿之后的批次，照常追加
//! ```
//!
//! 为什么只留最新一份是对的：一台设备的批次里的信封全是它自己写的，同一条记录后写的版本号
//! 一定更大；合并律本来就允许中间版本不送到（出件箱合并式外发时就会跳过）。所以读底稿
//! 和读全部批次，最后并出来的状态一样。
//!
//! 底稿按记录类型 + 记录 id 的哈希分成若干份，文件名就是内容哈希：没变的那几份（比如早就
//! 识别好的字幕）下次压缩时名字不变，不用重传。清单最后写——读的一方只认清单里列出的文件，
//! 永远读不到半份底稿。
//!
//! 读的一方（别的设备）：游标落在底稿覆盖范围里、而中间的批次已经删了，就读底稿，游标跳到
//! 底稿末尾，再接着读后面的批次。
//!
//! 「移除设备」用的也是这一套：把那台设备的批次全部折进底稿、删掉它的设备信息、留一个
//! `retired.json` 标记。它写过的数据（只有它改过的笔记之类）留在底稿里，新设备照样能拿到；
//! 那台设备要是其实还在用，下次推送时会自己把标记删掉，重新出现在列表里。

use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::error::AppResult;
use crate::sync::envelope::SyncEnvelope;
use crate::sync::webdav::{Entry, WebDav};

/// 自己攒了多少个批次没压缩就压一次。看视频时进度一分半推一次，大约几个小时压一次。
pub const COMPACT_AFTER: u64 = if cfg!(test) { 3 } else { 100 };
/// 一次最多删多少个旧文件。坚果云按请求数限频，删不完的下一轮接着删。
pub const MAX_DELETES: usize = 100;
/// 底稿每份的大小上限，和批次一样。
const PART_MAX_BYTES: usize = 8 * 1024 * 1024;
pub const RETIRED_MARKER: &str = "retired.json";
const MANIFEST_PREFIX: &str = "base-";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Manifest {
    /// 底稿覆盖到第几批（含）。
    pub upto: u64,
    /// 组成底稿的文件（在 `base/` 下），按顺序读。
    pub parts: Vec<String>,
    pub created_at: i64,
}

pub fn batch_name(seq: u64) -> String {
    format!("{seq:012}.json")
}

pub fn manifest_name(upto: u64) -> String {
    format!("{MANIFEST_PREFIX}{upto:012}.json")
}

/// 批次文件名 → 序号。只认 12 位数字的名字，清单、标记、临时文件都不算。
pub fn batch_seq(name: &str) -> Option<u64> {
    let digits = name.strip_suffix(".json")?;
    (digits.len() == 12 && digits.bytes().all(|byte| byte.is_ascii_digit())).then(|| digits.parse().ok())?
}

fn manifest_upto(name: &str) -> Option<u64> {
    batch_seq(name.strip_prefix(MANIFEST_PREFIX)?)
}

/// 一台设备的 `batches/` 目录里有什么。
#[derive(Debug, Default, Clone)]
pub struct Listing {
    pub batches: BTreeMap<u64, String>,
    /// 底稿清单：覆盖到第几批 → 文件名。可能暂时有好几个（新的写好、旧的还没删）。
    pub manifests: BTreeMap<u64, String>,
    pub retired: bool,
}

impl Listing {
    pub fn parse(entries: &[Entry]) -> Self {
        let mut listing = Self::default();
        for entry in entries.iter().filter(|entry| !entry.is_dir) {
            if let Some(seq) = batch_seq(&entry.name) {
                listing.batches.insert(seq, entry.name.clone());
            } else if let Some(upto) = manifest_upto(&entry.name) {
                listing.manifests.insert(upto, entry.name.clone());
            } else if entry.name == RETIRED_MARKER {
                listing.retired = true;
            }
        }
        listing
    }

    pub fn latest_manifest(&self) -> Option<(u64, &str)> {
        self.manifests.iter().next_back().map(|(upto, name)| (*upto, name.as_str()))
    }

    /// 网盘上已经用过的最大序号（批次删了，底稿清单还记着覆盖到哪）。
    pub fn max_seq(&self) -> u64 {
        let batch = self.batches.keys().next_back().copied().unwrap_or(0);
        let base = self.latest_manifest().map(|(upto, _)| upto).unwrap_or(0);
        batch.max(base)
    }

    /// 从 `after` 之后读到 `upto`，中间的批次是不是都还在（在就直接读批次，比读整份底稿省）。
    pub fn has_all_between(&self, after: u64, upto: u64) -> bool {
        (after + 1..=upto).all(|seq| self.batches.contains_key(&seq))
    }

    /// 已经折进底稿、可以删的东西：最新底稿覆盖到的批次、旧的清单。
    fn stale_files(&self) -> Vec<String> {
        let Some((upto, _)) = self.latest_manifest() else { return Vec::new() };
        let batches = self.batches.range(..=upto).map(|(_, name)| name.clone());
        let manifests = self.manifests.range(..upto).map(|(_, name)| name.clone());
        batches.chain(manifests).collect()
    }
}

pub async fn list(dav: &WebDav, device_dir: &str) -> AppResult<Listing> {
    let entries = dav.list(&format!("{device_dir}batches/")).await?.unwrap_or_default();
    Ok(Listing::parse(&entries))
}

/// 读一份底稿。某一份文件不见了（另一台设备正好在重新压缩）返回 None，下一轮重新列目录再读。
pub async fn read_base(dav: &WebDav, device_dir: &str, manifest: &str) -> AppResult<Option<(Manifest, Vec<Vec<SyncEnvelope>>)>> {
    let Some(bytes) = dav.get_optional(&format!("{device_dir}batches/{manifest}")).await? else { return Ok(None) };
    let manifest: Manifest = serde_json::from_slice(&bytes)?;
    let mut parts = Vec::with_capacity(manifest.parts.len());
    for part in &manifest.parts {
        let Some(bytes) = dav.get_optional(&format!("{device_dir}base/{part}")).await? else { return Ok(None) };
        parts.push(serde_json::from_slice(&bytes)?);
    }
    Ok(Some((manifest, parts)))
}

/// 把旧底稿和之后的批次折成每条记录一份：后来的覆盖先前的。结果按（类型, id）排好。
pub fn fold(base: Vec<SyncEnvelope>, batches: Vec<Vec<SyncEnvelope>>) -> Vec<SyncEnvelope> {
    let mut latest: BTreeMap<(String, String), SyncEnvelope> = BTreeMap::new();
    for envelope in base.into_iter().chain(batches.into_iter().flatten()) {
        latest.insert((envelope.record_type.clone(), envelope.record_id.clone()), envelope);
    }
    latest.into_values().collect()
}

/// 分份：同一类记录按 id 的哈希分桶，字幕和生成内容分得细一些（它们又大又很少改）。
/// 同样的内容永远分出同样的文件、同样的文件名。
pub fn partition(envelopes: &[SyncEnvelope]) -> AppResult<Vec<(String, Vec<u8>)>> {
    let mut buckets: BTreeMap<(String, u8), Vec<&SyncEnvelope>> = BTreeMap::new();
    for envelope in envelopes {
        let spread: u8 = if crate::sync::content::is_content(&envelope.record_type) { 16 } else { 4 };
        let bucket = Sha256::digest(envelope.record_id.as_bytes())[0] % spread;
        buckets.entry((envelope.record_type.clone(), bucket)).or_default().push(envelope);
    }
    let mut parts = Vec::new();
    for (_, members) in buckets {
        let mut chunk: Vec<&SyncEnvelope> = Vec::new();
        let mut size = 0usize;
        for envelope in members {
            let bytes = serde_json::to_vec(envelope)?.len() + 1;
            if !chunk.is_empty() && size + bytes > PART_MAX_BYTES {
                parts.push(named_part(&chunk)?);
                chunk.clear();
                size = 0;
            }
            chunk.push(envelope);
            size += bytes;
        }
        if !chunk.is_empty() {
            parts.push(named_part(&chunk)?);
        }
    }
    Ok(parts)
}

fn named_part(chunk: &[&SyncEnvelope]) -> AppResult<(String, Vec<u8>)> {
    let bytes = serde_json::to_vec(chunk)?;
    let digest = Sha256::digest(&bytes);
    let name: String = digest[..12].iter().map(|byte| format!("{byte:02x}")).collect();
    Ok((format!("{name}.json"), bytes))
}

#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct Outcome {
    /// 现在最新的底稿覆盖到第几批（没有底稿是 0）。
    pub base_upto: u64,
    /// 这次新折进去了几个批次。
    pub folded: usize,
    /// 这次传了几份底稿文件（没变的不传）。
    pub uploaded_parts: usize,
    pub deleted: usize,
    /// 还剩多少旧文件没删（下一轮接着删）。
    pub remaining: usize,
}

/// 本地缓存（只有压缩自己的批次时有）：推送时顺手留的批次副本、上次写的底稿，省得再下载一遍。
pub struct Cache<'a> {
    pub root: &'a Path,
}

impl Cache<'_> {
    fn batch_path(&self, name: &str) -> std::path::PathBuf {
        self.root.join("batches").join(name)
    }

    fn part_path(&self, name: &str) -> std::path::PathBuf {
        self.root.join("base").join(name)
    }

    pub fn store_batch(&self, name: &str, bytes: &[u8]) -> AppResult<()> {
        write_atomic(&self.batch_path(name), bytes)
    }

    fn read(path: &Path) -> Option<Vec<u8>> {
        std::fs::read(path).ok()
    }

    /// 底稿换代之后：缓存里只留新底稿的文件、新底稿之后的批次。
    fn retain(&self, manifest: &Manifest, parts: &[(String, Vec<u8>)]) -> AppResult<()> {
        for (name, bytes) in parts {
            if !self.part_path(name).exists() {
                write_atomic(&self.part_path(name), bytes)?;
            }
        }
        let keep: BTreeSet<&str> = manifest.parts.iter().map(String::as_str).collect();
        remove_files_where(&self.root.join("base"), |name| !keep.contains(name))?;
        remove_files_where(&self.root.join("batches"), |name| batch_seq(name).is_some_and(|seq| seq <= manifest.upto))?;
        Ok(())
    }
}

fn write_atomic(path: &Path, bytes: &[u8]) -> AppResult<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let temporary = path.with_extension("tmp");
    std::fs::write(&temporary, bytes)?;
    std::fs::rename(&temporary, path)?;
    Ok(())
}

fn remove_files_where(dir: &Path, remove: impl Fn(&str) -> bool) -> AppResult<()> {
    let Ok(entries) = std::fs::read_dir(dir) else { return Ok(()) };
    for entry in entries.flatten() {
        if entry.file_name().to_str().is_some_and(&remove) {
            let _ = std::fs::remove_file(entry.path());
        }
    }
    Ok(())
}

/// 压缩一台设备的批次：把最新底稿之后的批次全部折进一份新底稿，然后清掉折进去的旧文件。
/// 没有新批次时只做清理（上一轮没删完的）。`cache` 只在压缩自己的批次时传。
pub async fn compact(dav: &WebDav, device_dir: &str, cache: Option<&Cache<'_>>) -> AppResult<Outcome> {
    let listing = list(dav, device_dir).await?;
    let previous = listing.latest_manifest().map(|(upto, name)| (upto, name.to_string()));
    let previous_upto = previous.as_ref().map(|(upto, _)| *upto).unwrap_or(0);
    let pending: Vec<(u64, String)> =
        listing.batches.range(previous_upto + 1..).map(|(seq, name)| (*seq, name.clone())).collect();

    let mut outcome = Outcome { base_upto: previous_upto, ..Outcome::default() };
    let mut current: Option<Manifest> = match &previous {
        Some((_, name)) => Some(serde_json::from_slice(&dav.get(&format!("{device_dir}batches/{name}")).await?)?),
        None => None,
    };
    let mut listing = listing;
    if let Some(&(upto, _)) = pending.last() {
        // 旧底稿：先看本地缓存，缺哪份再下载。
        let mut base = Vec::new();
        let mut old_parts: BTreeSet<String> = BTreeSet::new();
        if let Some(manifest) = &current {
            for part in &manifest.parts {
                let bytes = match cache.and_then(|cache| Cache::read(&cache.part_path(part))) {
                    Some(bytes) => bytes,
                    None => dav.get(&format!("{device_dir}base/{part}")).await?,
                };
                base.extend(serde_json::from_slice::<Vec<SyncEnvelope>>(&bytes)?);
                old_parts.insert(part.clone());
            }
        }
        let mut batches = Vec::with_capacity(pending.len());
        for (_, name) in &pending {
            let bytes = match cache.and_then(|cache| Cache::read(&cache.batch_path(name))) {
                Some(bytes) => bytes,
                None => dav.get(&format!("{device_dir}batches/{name}")).await?,
            };
            batches.push(serde_json::from_slice::<Vec<SyncEnvelope>>(&bytes)?);
        }
        let folded = fold(base, batches);
        let parts = partition(&folded)?;
        dav.ensure_dir(&format!("{device_dir}base/")).await?;
        for (name, bytes) in &parts {
            if !old_parts.contains(name) {
                dav.put(&format!("{device_dir}base/{name}"), bytes.clone()).await?;
                outcome.uploaded_parts += 1;
            }
        }
        let manifest = Manifest {
            upto,
            parts: parts.iter().map(|(name, _)| name.clone()).collect(),
            created_at: chrono::Utc::now().timestamp_millis(),
        };
        dav.put(&format!("{device_dir}batches/{}", manifest_name(upto)), serde_json::to_vec(&manifest)?).await?;
        if let Some(cache) = cache {
            cache.retain(&manifest, &parts)?;
        }
        listing.manifests.insert(upto, manifest_name(upto));
        current = Some(manifest);
        outcome.base_upto = upto;
        outcome.folded = pending.len();
    }

    // 清理：折进底稿的批次、旧清单，以及不再被最新清单引用的底稿文件。
    let mut stale: Vec<String> = listing.stale_files().into_iter().map(|name| format!("{device_dir}batches/{name}")).collect();
    if let Some(manifest) = &current {
        let keep: BTreeSet<&str> = manifest.parts.iter().map(String::as_str).collect();
        let parts = dav.list(&format!("{device_dir}base/")).await?.unwrap_or_default();
        stale.extend(
            parts
                .iter()
                .filter(|entry| !entry.is_dir && !keep.contains(entry.name.as_str()))
                .map(|entry| format!("{device_dir}base/{}", entry.name)),
        );
    }
    for path in stale.iter().take(MAX_DELETES) {
        dav.delete(path).await?;
        outcome.deleted += 1;
    }
    outcome.remaining = stale.len() - outcome.deleted;
    Ok(outcome)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sync::envelope::{SyncOperation, SyncVersion};

    fn envelope(record_type: &str, id: &str, counter: i64, text: &str) -> SyncEnvelope {
        SyncEnvelope::new(
            record_type.into(),
            id.into(),
            SyncOperation::Save,
            SyncVersion { counter, device: "pc".into() },
            counter,
            serde_json::json!({ "text": text }),
        )
    }

    #[test]
    fn names_are_recognised_strictly() {
        assert_eq!(batch_seq("000000000017.json"), Some(17));
        assert_eq!(batch_seq("base-000000000017.json"), None);
        assert_eq!(batch_seq("17.json"), None);
        assert_eq!(batch_seq(".000000000017.json.tmp"), None);
        assert_eq!(manifest_upto("base-000000000250.json"), Some(250));
        assert_eq!(manifest_upto(RETIRED_MARKER), None);
    }

    #[test]
    fn folding_keeps_only_the_latest_copy_of_each_record() {
        let base = vec![envelope("Note", "a", 1, "old"), envelope("Note", "b", 2, "b")];
        let batches = vec![vec![envelope("Note", "a", 3, "newer")], vec![envelope("Note", "a", 4, "newest")]];
        let folded = fold(base, batches);
        assert_eq!(folded.len(), 2);
        assert_eq!(folded[0].payload["text"], "newest");
        assert_eq!(folded[1].payload["text"], "b");
    }

    #[test]
    fn unchanged_records_keep_the_same_part_names() {
        let transcripts: Vec<_> = (0..40).map(|i| envelope("Transcript", &format!("v{i}"), i, "字幕")).collect();
        let mut before = transcripts.clone();
        before.push(envelope("VideoProgress", "v1", 100, "10s"));
        let mut after = transcripts;
        after.push(envelope("VideoProgress", "v1", 101, "20s"));
        let names = |envelopes: &[SyncEnvelope]| -> BTreeSet<String> {
            partition(envelopes).unwrap().into_iter().map(|(name, _)| name).collect()
        };
        let (before, after) = (names(&before), names(&after));
        // 只有进度那一份变了：字幕那些份名字不变，下次压缩不用重传。
        assert_eq!(before.difference(&after).count(), 1);
        assert_eq!(after.difference(&before).count(), 1);
    }

    #[test]
    fn listing_knows_what_is_already_covered() {
        let entries: Vec<Entry> = ["000000000001.json", "000000000002.json", "000000000003.json", "base-000000000002.json", RETIRED_MARKER]
            .iter()
            .map(|name| Entry { name: (*name).into(), is_dir: false, size: None })
            .collect();
        let listing = Listing::parse(&entries);
        assert_eq!(listing.latest_manifest(), Some((2, "base-000000000002.json")));
        assert_eq!(listing.max_seq(), 3);
        assert!(listing.retired);
        assert_eq!(listing.stale_files(), ["000000000001.json", "000000000002.json"]);
        assert!(listing.has_all_between(0, 3));
        let mut gap = listing.clone();
        gap.batches.remove(&1);
        assert!(!gap.has_all_between(0, 2));
        assert!(gap.has_all_between(2, 3));
    }
}
