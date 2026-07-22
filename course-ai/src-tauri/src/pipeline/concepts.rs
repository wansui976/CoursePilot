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
    name.split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase()
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
            MergedConcept {
                name,
                occurrences: occ,
            }
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
        assert_eq!(
            got[0],
            RawConcept {
                name: "贝叶斯定理".into(),
                start_ms: 65_000
            }
        );
        assert_eq!(
            got[1],
            RawConcept {
                name: "极限".into(),
                start_ms: 3_600_000
            }
        );
        assert!(parse_concepts_json("not json").is_empty());
        assert!(parse_concepts_json(r#"{"name":"x"}"#).is_empty()); // 非数组
    }

    #[test]
    fn merge_by_name_merges_same_name_across_videos_and_ranks() {
        let raw = vec![
            (
                "v1".into(),
                RawConcept {
                    name: "光合作用".into(),
                    start_ms: 1000,
                },
            ),
            (
                "v2".into(),
                RawConcept {
                    name: " 光合作用 ".into(),
                    start_ms: 2000,
                },
            ),
            (
                "v1".into(),
                RawConcept {
                    name: "细胞呼吸".into(),
                    start_ms: 500,
                },
            ),
            (
                "v1".into(),
                RawConcept {
                    name: "光合作用".into(),
                    start_ms: 1000,
                },
            ), // 重复出现，去重
        ];
        let merged = merge_by_name(raw);
        assert_eq!(merged.len(), 2);
        // 光合作用出现两次（v1@1000, v2@2000，重复的被去重）排在前。
        assert_eq!(merged[0].name, "光合作用");
        assert_eq!(
            merged[0].occurrences,
            vec![("v1".into(), 1000), ("v2".into(), 2000)]
        );
        assert_eq!(merged[1].name, "细胞呼吸");
        assert_eq!(merged[1].occurrences, vec![("v1".into(), 500)]);
    }
}
