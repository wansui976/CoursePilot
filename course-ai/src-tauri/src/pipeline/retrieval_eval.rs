//! 检索质量的回归评测。
//!
//! 为什么要有这个文件：前面每一步改动（切词、课件进检索、词元加权、问题改写）我都只能
//! 论证「方向对」，给不出「好了多少」。没有评测的时候，人很容易验证到一个假的东西——
//! 这个仓库里就出现过：我写的两个测试都通过，但通过的原因是我挑的例句碰巧多命中了
//! 几个二字组，换成真正同分的例子立刻就红了。
//!
//! 评测集在 `tests/fixtures/retrieval/*.json`，一节课一个文件：讲稿、课件 OCR、
//! 一组「问题 → 应该召回哪几句」的标注，以及这节课没讲、必须召不回的问题。
//! 有两节：
//! - 短课（四分钟）：几十段全进得了预算，只量召回；
//! - 长课（七十分钟、五千多字）：讲稿超过 4000 字的窗口预算，「价格」「数量」到处都是，
//!   排序好坏在这里才分得出来。召回率本身量不到排序（一个问题命中的段落连上下文
//!   通常塞得进预算），所以另外量 MRR。
//!
//! 每次跑都和 `baseline.json` 比，三条红线：
//! 1. 基线里能召回的问题，现在召不回了；
//! 2. 基线里判对了「这节课没讲」的问题，现在被召回了（有出处、有时间戳的错答案，
//!    比说不知道糟得多）；
//! 3. 召回内容里离标注很远的部分（噪声）比基线多出 2 个百分点以上；
//! 4. 排序（MRR：第一个命中标注的窗口排第几）比基线低 0.01 以上。
//!
//! 基线里登记为不达标的样例是当前检索的真实边界，不是要绕过的测试。比如长课里
//! 「光合作用的原理是什么」会因为「不起作用」「实用的用处」里的二字组被召回——
//! 修好了它会在报告里显示为「现在通过了」。
//!
//! 变好了不会失败，只在报告里提示可以更新基线。改了样例或确实接受了变化，就重写基线：
//! `UPDATE_RETRIEVAL_BASELINE=1 cargo test --lib retrieval_eval`
//!
//! CI 里（build-check 的 iOS 任务）单独一步「检索评测」跑它，并设 `RETRIEVAL_EVAL_SUMMARY=1`：
//! 评测表写进这次运行的摘要页，每次推送都能看到数字，而不只是「测试过了」。
//! 其余地方（本机、Windows 任务里的全量单测）跑它只判过不过，不写摘要，免得同一张表出现两次。
//!
//! 只评「不调模型」的那条主路。问题改写要调模型，在 rag 的单元测试里用 Mock 单独测；
//! 向量检索要下模型，也不在这里。

use super::*;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

/// 噪声比基线多出这么多就算退步。
///
/// 评测完全确定（同样的代码每次跑出同样的数），容差只用来吸收基线文件里的两位小数舍入，
/// 所以可以很紧。试过：把词元权重反过来（越常见越重），长课 MRR 只从 0.85 掉到 0.83——
/// 相邻命中会合并成大窗口，排序差别被冲淡了，容差放宽到 0.05 就漏过去了。
const NOISE_TOLERANCE: f64 = 0.02;
/// 排序（MRR）比基线低这么多就算退步。
const MRR_TOLERANCE: f64 = 0.01;

#[derive(Deserialize)]
struct Fixture {
    name: String,
    interval_ms: i64,
    segment_ms: i64,
    lines: Vec<String>,
    #[serde(default)]
    slides: Vec<FixtureSlide>,
    cases: Vec<FixtureCase>,
    /// 已知召不回的问题：口语说法与讲稿用词完全不沾，靠「请模型改写问题」那一级兜底。
    /// 只报数不断言——列出来是为了诚实地记下当前的边界在哪。
    #[serde(default)]
    known_misses: Vec<String>,
}

#[derive(Deserialize)]
struct FixtureSlide {
    page_no: i64,
    at_line: i64,
    duration_ms: i64,
    ocr: String,
}

#[derive(Deserialize)]
struct FixtureCase {
    q: String,
    /// 期望被召回的句子（行号，从 0 起）；任一命中即算成功。
    #[serde(default)]
    lines: Vec<i64>,
    /// 这节课确实没讲——必须一条都召不回。
    #[serde(default)]
    not_covered: bool,
}

#[derive(Debug, Default, Clone, PartialEq, Serialize, Deserialize)]
struct BaselineEntry {
    /// 能召回（或正确判定为没讲到）的问题。
    passing: Vec<String>,
    /// 登记过、目前还不达标的问题。
    failing: Vec<String>,
    /// 召回内容里离标注很远那部分的平均占比。
    noise: f64,
    /// 排序：第一个命中标注的窗口排第几，取倒数再平均（MRR，1 = 每次都排第一）。
    #[serde(default)]
    mrr: f64,
}

/// 一节课的评测结果。
struct Outcome {
    name: String,
    file: String,
    recalled: usize,
    hit_cases: usize,
    abstained: usize,
    miss_cases: usize,
    noise: f64,
    mrr: f64,
    passing: Vec<String>,
    failing: Vec<String>,
    detail: String,
}

fn fixtures_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/retrieval")
}

fn load_fixtures() -> Vec<(String, Fixture)> {
    let mut files: Vec<PathBuf> = std::fs::read_dir(fixtures_dir())
        .expect("评测集目录 tests/fixtures/retrieval 不存在")
        .filter_map(|entry| entry.ok().map(|e| e.path()))
        .filter(|path| {
            path.extension().is_some_and(|ext| ext == "json")
                && path.file_name().is_some_and(|name| name != "baseline.json")
        })
        .collect();
    files.sort();
    files
        .into_iter()
        .map(|path| {
            let text = std::fs::read_to_string(&path).unwrap();
            let fixture: Fixture = serde_json::from_str(&text)
                .unwrap_or_else(|error| panic!("{} 解析失败：{error}", path.display()));
            let file = path.file_stem().unwrap().to_string_lossy().to_string();
            (file, fixture)
        })
        .collect()
}

fn segments(fixture: &Fixture) -> Vec<TranscriptSegment> {
    fixture
        .lines
        .iter()
        .enumerate()
        .map(|(i, text)| TranscriptSegment {
            id: i as i64,
            video_id: "eval".into(),
            segment_idx: i as i64,
            start_ms: i as i64 * fixture.interval_ms,
            end_ms: i as i64 * fixture.interval_ms + fixture.segment_ms,
            text: text.clone(),
        })
        .collect()
}

fn slide_pages(fixture: &Fixture) -> Vec<SlidePage> {
    fixture
        .slides
        .iter()
        .map(|slide| {
            let start_ms = slide.at_line * fixture.interval_ms;
            SlidePage {
                page_no: slide.page_no,
                start_ms,
                end_ms: Some(start_ms + slide.duration_ms),
                image_path: format!("/tmp/eval-p{}.jpg", slide.page_no),
                ocr_text: slide.ocr.clone(),
            }
        })
        .collect()
}

/// 召回的时间区间：讲稿窗口与课件页一视同仁，两者都是「这节课讲过」的证据。
fn recalled_spans(retrieved: &Retrieved) -> Vec<(i64, i64)> {
    retrieved
        .windows
        .iter()
        .map(|window| (window.start_ms, window.end_ms))
        .chain(
            retrieved
                .slides
                .iter()
                .map(|slide| (slide.start_ms, slide.end_ms)),
        )
        .collect()
}

fn covers(spans: &[(i64, i64)], at_ms: i64) -> bool {
    spans
        .iter()
        .any(|(start, end)| *start <= at_ms && at_ms <= *end)
}

/// 噪声：召回的讲稿窗口里，离任何一个标注点都超过一分钟的那部分时长占比。
/// 窗口本来就带着前后 30 秒的上下文，一分钟以内都算「在讲这件事」。
fn noise_of(retrieved: &Retrieved, expect_ms: &[i64]) -> f64 {
    const NEAR_MS: i64 = 60_000;
    let total: i64 = retrieved
        .windows
        .iter()
        .map(|w| (w.end_ms - w.start_ms).max(0))
        .sum();
    if total == 0 {
        return 0.0;
    }
    let far: i64 = retrieved
        .windows
        .iter()
        .filter(|w| {
            !expect_ms
                .iter()
                .any(|at| w.start_ms - NEAR_MS <= *at && *at <= w.end_ms + NEAR_MS)
        })
        .map(|w| (w.end_ms - w.start_ms).max(0))
        .sum();
    far as f64 / total as f64
}

/// 排序名次的倒数：讲稿窗口按分数从高到低，第一个盖住标注点的排第几。
/// 窗口都没盖住、只靠课件页召回的，算排第一（课件页另有名额，不和讲稿抢预算）。
///
/// 召回率量不到排序：一个问题命中的段落加上前后文通常不到 4000 字的预算，
/// 谁排前面都会被喂进去。但排序决定了预算吃紧时（大课、常见词）先留下谁，
/// 所以单独量。
fn reciprocal_rank(retrieved: &Retrieved, expect_ms: &[i64]) -> f64 {
    let mut windows: Vec<&Window> = retrieved.windows.iter().collect();
    windows.sort_by(|a, b| {
        b.score
            .total_cmp(&a.score)
            .then(a.start_ms.cmp(&b.start_ms))
    });
    match windows.iter().position(|w| {
        expect_ms
            .iter()
            .any(|at| w.start_ms <= *at && *at <= w.end_ms)
    }) {
        Some(index) => 1.0 / (index + 1) as f64,
        None => 1.0,
    }
}

fn evaluate(file: &str, fixture: &Fixture) -> Outcome {
    let segments = segments(fixture);
    let pages = slide_pages(fixture);
    let mut outcome = Outcome {
        name: fixture.name.clone(),
        file: file.to_string(),
        recalled: 0,
        hit_cases: 0,
        abstained: 0,
        miss_cases: 0,
        noise: 0.0,
        mrr: 0.0,
        passing: Vec::new(),
        failing: Vec::new(),
        detail: String::new(),
    };
    let mut rr_sum = 0.0;
    let mut noise_sum = 0.0;
    let mut noise_n = 0usize;

    for case in &fixture.cases {
        let retrieved = retrieve(&segments, &pages, &case.q, &[]);
        let spans = recalled_spans(&retrieved);
        if case.not_covered {
            outcome.miss_cases += 1;
            if retrieved.is_empty() {
                outcome.abstained += 1;
                outcome.passing.push(case.q.clone());
                outcome
                    .detail
                    .push_str(&format!("  ✓ 「{}」正确判定为没讲到\n", case.q));
            } else {
                outcome.failing.push(case.q.clone());
                outcome.detail.push_str(&format!(
                    "  ✗ 「{}」这节课没讲，却召回了 {spans:?}\n",
                    case.q
                ));
            }
            continue;
        }

        outcome.hit_cases += 1;
        let expect_ms: Vec<i64> = case
            .lines
            .iter()
            .map(|line| line * fixture.interval_ms)
            .collect();
        if expect_ms.iter().any(|at| covers(&spans, *at)) {
            outcome.recalled += 1;
            outcome.passing.push(case.q.clone());
            let noise = noise_of(&retrieved, &expect_ms);
            let rr = reciprocal_rank(&retrieved, &expect_ms);
            noise_sum += noise;
            rr_sum += rr;
            noise_n += 1;
            outcome.detail.push_str(&format!(
                "  ✓ 「{}」排第 {}，噪声 {:.0}%\n",
                case.q,
                (1.0 / rr).round(),
                noise * 100.0
            ));
        } else {
            outcome.failing.push(case.q.clone());
            outcome.detail.push_str(&format!(
                "  ✗ 「{}」期望第 {:?} 句，实际召回 {spans:?}\n",
                case.q, case.lines
            ));
        }
    }
    outcome.noise = if noise_n == 0 {
        0.0
    } else {
        noise_sum / noise_n as f64
    };
    // 召不回的问题按 0 计：MRR 同时反映召回和排序。
    outcome.mrr = if outcome.hit_cases == 0 {
        1.0
    } else {
        rr_sum / outcome.hit_cases as f64
    };

    if !fixture.known_misses.is_empty() {
        outcome
            .detail
            .push_str("  已知召不回（靠改写问题那一级兜底，此处不断言）：\n");
        for question in &fixture.known_misses {
            let mark = if retrieve(&segments, &pages, question, &[]).is_empty() {
                "仍然召不回"
            } else {
                "现在能召回了（可以升级成正式样例）"
            };
            outcome
                .detail
                .push_str(&format!("    · 「{question}」{mark}\n"));
        }
    }
    outcome
}

/// 和基线比，返回退步的条目（空 = 没退步）与「变好了」的提示。
fn compare(outcome: &Outcome, baseline: Option<&BaselineEntry>) -> (Vec<String>, Vec<String>) {
    let mut regressions = Vec::new();
    let mut improvements = Vec::new();
    let Some(base) = baseline else {
        regressions.push(format!(
            "评测集「{}」不在基线里：运行 UPDATE_RETRIEVAL_BASELINE=1 cargo test --lib retrieval_eval 登记",
            outcome.file
        ));
        return (regressions, improvements);
    };
    for question in &outcome.failing {
        if base.passing.contains(question) {
            regressions.push(format!("「{question}」基线里能通过，现在不行了"));
        } else if !base.failing.contains(question) {
            regressions.push(format!("「{question}」是新样例且没通过：先登记到基线"));
        }
    }
    for question in &outcome.passing {
        if base.failing.contains(question) {
            improvements.push(format!("「{question}」现在通过了"));
        } else if !base.passing.contains(question) {
            regressions.push(format!("「{question}」是新样例：先登记到基线"));
        }
    }
    if outcome.mrr + MRR_TOLERANCE < base.mrr {
        regressions.push(format!(
            "排序（MRR）从 {:.2} 降到 {:.2}",
            base.mrr, outcome.mrr
        ));
    } else if outcome.mrr > base.mrr + MRR_TOLERANCE {
        improvements.push(format!(
            "排序（MRR）从 {:.2} 升到 {:.2}",
            base.mrr, outcome.mrr
        ));
    }
    if outcome.noise > base.noise + NOISE_TOLERANCE {
        regressions.push(format!(
            "噪声从 {:.0}% 升到 {:.0}%",
            base.noise * 100.0,
            outcome.noise * 100.0
        ));
    } else if outcome.noise + NOISE_TOLERANCE < base.noise {
        improvements.push(format!(
            "噪声从 {:.0}% 降到 {:.0}%",
            base.noise * 100.0,
            outcome.noise * 100.0
        ));
    }
    (regressions, improvements)
}

fn pct(n: usize, d: usize) -> String {
    if d == 0 {
        "—".into()
    } else {
        format!("{}/{}（{:.0}%）", n, d, n as f64 * 100.0 / d as f64)
    }
}

fn markdown_summary(rows: &[(&Outcome, Option<&BaselineEntry>, usize)]) -> String {
    let mut md = String::from(
        "### 检索评测\n\n| 评测集 | 召回 | 没讲到判对 | 排序 MRR（基线） | 噪声（基线） | 退步 |\n|---|---|---|---|---|---|\n",
    );
    for (outcome, base, regressions) in rows {
        let base_noise = base
            .map(|b| format!("{:.0}%", b.noise * 100.0))
            .unwrap_or_else(|| "—".into());
        let base_mrr = base
            .map(|b| format!("{:.2}", b.mrr))
            .unwrap_or_else(|| "—".into());
        md.push_str(&format!(
            "| {} | {} | {} | {:.2}（{}） | {:.0}%（{}） | {} |\n",
            outcome.name,
            pct(outcome.recalled, outcome.hit_cases),
            pct(outcome.abstained, outcome.miss_cases),
            outcome.mrr,
            base_mrr,
            outcome.noise * 100.0,
            base_noise,
            if *regressions == 0 {
                "无".to_string()
            } else {
                format!("**{regressions} 条**")
            }
        ));
    }
    md.push('\n');
    md
}

#[test]
fn retrieval_matches_the_baseline() {
    let fixtures = load_fixtures();
    assert!(fixtures.len() >= 2, "评测集至少要有短课和长课两节");
    let baseline_path = fixtures_dir().join("baseline.json");
    let baseline: BTreeMap<String, BaselineEntry> = std::fs::read_to_string(&baseline_path)
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_default();

    let outcomes: Vec<Outcome> = fixtures
        .iter()
        .map(|(file, fixture)| evaluate(file, fixture))
        .collect();

    if std::env::var("UPDATE_RETRIEVAL_BASELINE").is_ok_and(|v| v == "1") {
        let fresh: BTreeMap<String, BaselineEntry> = outcomes
            .iter()
            .map(|o| {
                (
                    o.file.clone(),
                    BaselineEntry {
                        passing: o.passing.clone(),
                        failing: o.failing.clone(),
                        // 两位小数够用，基线文件改动时 diff 也好读。
                        noise: (o.noise * 100.0).round() / 100.0,
                        mrr: (o.mrr * 100.0).round() / 100.0,
                    },
                )
            })
            .collect();
        std::fs::write(
            &baseline_path,
            serde_json::to_string_pretty(&fresh).unwrap() + "\n",
        )
        .unwrap();
        println!("已重写检索评测基线：{}", baseline_path.display());
        return;
    }

    let mut report = String::from("\n检索评测：\n");
    let mut all_regressions = Vec::new();
    let mut rows = Vec::new();
    for outcome in &outcomes {
        let base = baseline.get(&outcome.file);
        let (regressions, improvements) = compare(outcome, base);
        report.push_str(&format!(
            "{}：召回 {}，没讲到判对 {}，排序 MRR {:.2}，噪声 {:.0}%\n{}",
            outcome.name,
            pct(outcome.recalled, outcome.hit_cases),
            pct(outcome.abstained, outcome.miss_cases),
            outcome.mrr,
            outcome.noise * 100.0,
            outcome.detail
        ));
        for line in &improvements {
            report.push_str(&format!("  ↑ {line}（可以更新基线）\n"));
        }
        rows.push((outcome, base, regressions.len()));
        all_regressions.extend(
            regressions
                .into_iter()
                .map(|line| format!("{}：{line}", outcome.name)),
        );
    }
    println!("{report}");

    let want_summary = std::env::var("RETRIEVAL_EVAL_SUMMARY").is_ok_and(|v| v == "1");
    if let (true, Ok(summary)) = (want_summary, std::env::var("GITHUB_STEP_SUMMARY")) {
        use std::io::Write as _;
        if let Ok(mut file) = std::fs::OpenOptions::new()
            .append(true)
            .create(true)
            .open(summary)
        {
            let _ = file.write_all(markdown_summary(&rows).as_bytes());
        }
    }

    assert!(
        all_regressions.is_empty(),
        "{report}\n检索评测比基线退步了 {} 处：\n{}\n\n确认是有意的变化，就运行 UPDATE_RETRIEVAL_BASELINE=1 cargo test --lib retrieval_eval 更新基线。",
        all_regressions.len(),
        all_regressions.join("\n")
    );
}

#[test]
fn the_long_lecture_actually_exceeds_the_window_budget() {
    // 长课要是塞得进预算，排序好坏就量不出来了。
    let fixtures = load_fixtures();
    let longest = fixtures
        .iter()
        .map(|(_, f)| f.lines.iter().map(|l| l.chars().count()).sum::<usize>())
        .max()
        .unwrap_or(0);
    assert!(
        longest > WINDOW_BUDGET_CHARS,
        "最长的评测讲稿只有 {longest} 字"
    );
}

#[test]
fn baseline_comparison_flags_regressions_and_new_cases() {
    let outcome = Outcome {
        name: "x".into(),
        file: "x".into(),
        recalled: 1,
        hit_cases: 2,
        abstained: 0,
        miss_cases: 0,
        noise: 0.30,
        mrr: 0.50,
        passing: vec!["a".into(), "new".into()],
        failing: vec!["b".into()],
        detail: String::new(),
    };
    let base = BaselineEntry {
        passing: vec!["b".into()],
        failing: vec!["a".into()],
        noise: 0.10,
        mrr: 0.80,
    };
    let (regressions, improvements) = compare(&outcome, Some(&base));
    assert!(regressions.iter().any(|r| r.contains("「b」基线里能通过")));
    assert!(regressions.iter().any(|r| r.contains("「new」是新样例")));
    assert!(regressions
        .iter()
        .any(|r| r.contains("噪声从 10% 升到 30%")));
    assert!(regressions
        .iter()
        .any(|r| r.contains("排序（MRR）从 0.80 降到 0.50")));
    assert!(improvements.iter().any(|r| r.contains("「a」现在通过了")));
    let (regressions, _) = compare(&outcome, None);
    assert_eq!(regressions.len(), 1);
}
