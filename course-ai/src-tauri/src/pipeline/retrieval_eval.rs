//! 检索质量的评测集。
//!
//! 为什么要有这个文件：前面每一步改动（切词、课件进检索、词元加权、问题改写）我都只能
//! 论证「方向对」，给不出「好了多少」。没有评测的时候，人很容易验证到一个假的东西——
//! 这个仓库里就出现过：我写的两个测试都通过，但通过的原因是我挑的例句碰巧多命中了
//! 几个二字组，换成真正同分的例子立刻就红了。
//!
//! 这里放一份小而真实的讲稿 + 一组「问题 → 应该召回哪个时间点」的标注，把召回率算出来。
//! 它挡的是回归：以后再动检索，先看这张表有没有变差。
//!
//! **怎么加进你自己的课**：照 [`CASES`] 的样子写就行——问题一句、期望的时间点几个
//! （任一命中即算召回成功）。真实数据下召回率不会是 100%，那个数字本身才是有用的：
//! 改一版跑一次，就知道是真变好还是只是听起来变好。
//!
//! 只评「不调模型」的那条主路。问题改写要调模型，在 rag 的单元测试里用 Mock 单独测。
//!
//! 量的是**召回**：该找到的有没有找到、不该找到的有没有克制住。它量不到排序好坏——
//! 这份讲稿太短，几十段全都进得了预算，谁排前面看不出来。要量排序得用真实长课，
//! 那也正是你自己的数据才能提供的东西。

use super::*;

/// 一条评测样例。
struct Case {
    question: &'static str,
    /// 期望被召回的时间点（毫秒）；任一命中即算成功。`not_covered` 为真时必须为空。
    expect_ms: &'static [i64],
    /// 这节课确实没讲——必须一条都召不回。
    /// 这类样例和召回同等重要：把「没讲到」答成「讲过」，用户拿到的是一个有出处、
    /// 有时间戳、看起来很可信的错答案，比直接说不知道糟得多。
    not_covered: bool,
}

const fn hit(question: &'static str, expect_ms: &'static [i64]) -> Case {
    Case {
        question,
        expect_ms,
        not_covered: false,
    }
}

const fn miss(question: &'static str) -> Case {
    Case {
        question,
        expect_ms: &[],
        not_covered: true,
    }
}

const CASES: &[Case] = &[
    hit("什么是梯度下降", &[40_000, 48_000]),
    hit("学习率太大会怎么样", &[80_000]),
    hit("学习率太小呢", &[88_000]),
    hit("学习率该怎么调", &[96_000, 104_000, 112_000]),
    hit("损失函数是干什么用的", &[8_000, 16_000]),
    hit("反向传播是怎么算梯度的", &[192_000, 200_000]),
    hit("动量优化器有什么用", &[160_000, 168_000, 176_000]),
    hit("局部极小值是什么意思", &[128_000, 136_000]),
    hit("过拟合", &[232_000]),
    // 口语提问，但「不动」恰好和讲稿里的「走不动了」对上了——中文二字组的运气。
    hit("训练怎么老是不动了", &[136_000]),
    // 术语只写在课件上，老师一句没念——搜索早就能找到，问答曾经找不到。
    hit("鞍点", &[120_000]),
    // 公式只出现在课件画面里。
    hit("链式法则", &[184_000]),
    miss("宋词的平仄怎么分"),
    miss("红烧肉怎么做"),
];

/// 已知召不回的问题：口语说法与讲稿用词完全不沾，靠的是「请模型改写问题」那一级兜底。
/// 这里只报数不断言——列出来是为了诚实地记下当前的边界在哪。
const KNOWN_MISSES: &[&str] = &["为什么会卡住", "学得太慢了"];

/// 一节讲神经网络训练的课，约四分钟。段间隔 8 秒，和真实字幕的密度接近。
fn lecture() -> Vec<TranscriptSegment> {
    const LINES: &[&str] = &[
        "今天我们讲神经网络怎么训练",
        "先回顾一下上节课的损失函数",
        "损失函数衡量的是预测值和真实值的差距",
        "我们的目标就是让这个差距尽量小",
        "那怎么才能让它变小呢",
        "这就要用到梯度下降",
        "梯度下降的思路其实很简单",
        "沿着梯度的反方向走一小步",
        "每走一步损失就下降一点",
        "这一小步走多大由学习率决定",
        "学习率太大会在最低点附近来回震荡",
        "学习率太小又会收敛得非常慢",
        "所以学习率是最需要调的一个超参数",
        "实际中常用的做法是先大后小",
        "也就是所谓的学习率衰减",
        "接下来说一个训练时常见的麻烦",
        "梯度下降会陷入局部极小值",
        "到了那里梯度接近零就走不动了",
        "但它并不是我们要的全局最优解",
        "解决办法之一是换个初始点重新训练",
        "另一个办法是换成带动量的优化器",
        "动量会累积之前几步的更新方向",
        "这样就能冲过一些比较浅的坑",
        "我们再回来看反向传播",
        "反向传播是用链式法则算梯度",
        "从输出层一层一层往回推",
        "每一层都能拿到自己那些参数的梯度",
        "有了梯度就可以更新参数了",
        "这就是训练的完整一轮",
        "下节课我们讲过拟合和正则化",
    ];
    LINES
        .iter()
        .enumerate()
        .map(|(i, text)| TranscriptSegment {
            id: i as i64,
            video_id: "eval".into(),
            segment_idx: i as i64,
            start_ms: i as i64 * 8_000,
            end_ms: i as i64 * 8_000 + 5_000,
            text: (*text).into(),
        })
        .collect()
}

/// 三页课件。「鞍点」「链式法则」的公式只写在片子上，老师没念——这正是真实网课的常态。
fn slides() -> Vec<SlidePage> {
    [
        (1, 40_000, "梯度下降\nθ ← θ - η∇L(θ)\n沿负梯度方向迭代"),
        (
            2,
            120_000,
            "局部极小值 与 全局最优\n鞍点 saddle point\n梯度为零但不是极值",
        ),
        (
            3,
            184_000,
            "反向传播\n链式法则 ∂L/∂w = ∂L/∂y · ∂y/∂w\n逐层回传",
        ),
    ]
    .into_iter()
    .map(|(page_no, start_ms, ocr): (i64, i64, &str)| SlidePage {
        page_no,
        start_ms,
        end_ms: Some(start_ms + 30_000),
        image_path: format!("/tmp/eval-p{page_no}.jpg"),
        ocr_text: ocr.into(),
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

#[test]
fn retrieval_recalls_what_the_lecture_actually_says() {
    let segments = lecture();
    let pages = slides();
    let mut report = String::from("\n检索评测：\n");
    let mut failures: Vec<String> = Vec::new();

    for case in CASES {
        let retrieved = retrieve(&segments, &pages, case.question, &[]);
        let spans = recalled_spans(&retrieved);

        if case.not_covered {
            if retrieved.is_empty() {
                report.push_str(&format!("  ✓ 「{}」正确判定为没讲到\n", case.question));
            } else {
                report.push_str(&format!(
                    "  ✗ 「{}」这节课没讲，却召回了 {spans:?}\n",
                    case.question
                ));
                failures.push(format!(
                    "「{}」应判定为没讲到，实际召回 {spans:?}",
                    case.question
                ));
            }
            continue;
        }

        let recalled = case.expect_ms.iter().any(|at| covers(&spans, *at));
        if recalled {
            report.push_str(&format!("  ✓ 「{}」\n", case.question));
        } else {
            report.push_str(&format!(
                "  ✗ 「{}」期望 {:?}，实际召回 {spans:?}\n",
                case.question, case.expect_ms
            ));
            failures.push(format!(
                "「{}」期望召回 {:?}，实际 {spans:?}",
                case.question, case.expect_ms
            ));
        }
    }

    report.push_str("已知召不回（靠改写问题那一级兜底，此处不断言）：\n");
    for question in KNOWN_MISSES {
        let retrieved = retrieve(&segments, &pages, question, &[]);
        let mark = if retrieved.is_empty() {
            "仍然召不回"
        } else {
            "现在能召回了（可以升级成正式样例）"
        };
        report.push_str(&format!("  · 「{question}」{mark}\n"));
    }
    println!("{report}");

    assert!(
        failures.is_empty(),
        "{report}\n检索评测有 {} 条不达标：\n{}",
        failures.len(),
        failures.join("\n")
    );
}
