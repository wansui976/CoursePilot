//! 大资料库下的耗时基准（手动跑，不进常规测试）：
//!
//! ```text
//! cargo test --release --lib perf_bench -- --ignored --nocapture
//! ```
//!
//! 造一个「用了一学期」的库：一门 400 个视频的大课 + 两门 60 个视频的课，每个视频
//! 约 700 句文稿（45 分钟一讲）、一篇笔记、播放进度、看课记录，然后给首页、课程页、
//! 搜索和助手检索这些常用路径各计时几次。

use std::time::{Duration, Instant};

use crate::db::Db;

const BIG_COURSE_VIDEOS: usize = 400;
const SMALL_COURSE_VIDEOS: usize = 60;
const SEGMENTS_PER_VIDEO: usize = 700;

/// 不引入随机数依赖的确定性伪随机（xorshift）。
struct Rng(u64);
impl Rng {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        self.0
    }
    fn pick<'a>(&mut self, items: &'a [&'a str]) -> &'a str {
        items[(self.next() % items.len() as u64) as usize]
    }
}

const TERMS: &[&str] = &[
    "梯度下降",
    "学习率",
    "损失函数",
    "过拟合",
    "正则化",
    "反向传播",
    "卷积",
    "池化",
    "注意力",
    "特征值",
    "矩阵分解",
    "概率分布",
    "最大似然",
    "贝叶斯",
    "交叉熵",
    "激活函数",
    "批归一化",
    "随机森林",
    "支持向量机",
    "核函数",
    "聚类",
    "降维",
    "主成分分析",
    "马尔可夫",
    "强化学习",
    "策略梯度",
    "价值函数",
    "收敛",
    "泛化",
    "偏差",
    "方差",
    "验证集",
    "超参数",
    "动量",
    "残差",
];
const FILLERS: &[&str] = &[
    "我们来看一下",
    "这里要注意",
    "所以说",
    "大家可以想一想",
    "换句话说",
    "这个地方",
    "比如说",
    "其实就是",
    "接下来",
    "回到刚才的例子",
    "你会发现",
    "也就是",
];

fn sentence(rng: &mut Rng) -> String {
    format!(
        "{}{}的{}和{}有关，{}",
        rng.pick(FILLERS),
        rng.pick(TERMS),
        rng.pick(&["定义", "推导", "性质", "直觉", "计算"]),
        rng.pick(TERMS),
        rng.pick(FILLERS)
    )
}

async fn seed(db: &Db) -> (Vec<String>, Vec<(String, String)>) {
    let mut rng = Rng(0x9E37_79B9_7F4A_7C15);
    let mut courses = Vec::new();
    let mut big_videos = Vec::new();
    let now = chrono::Utc::now().timestamp_millis();
    for (c, count) in [BIG_COURSE_VIDEOS, SMALL_COURSE_VIDEOS, SMALL_COURSE_VIDEOS]
        .into_iter()
        .enumerate()
    {
        let course =
            crate::commands::courses::create_course(db, format!("课程 {c}"), String::new())
                .await
                .unwrap();
        let mut tx = db.pool.begin().await.unwrap();
        for v in 0..count {
            let id = uuid::Uuid::new_v4().to_string();
            let title = format!("第{}讲 {}", v + 1, rng.pick(TERMS));
            sqlx::query(
                "INSERT INTO videos(id,course_id,title,source_type,file_path,data_dir,created_at,order_index,duration_ms)
                 VALUES (?,?,?,'local','/x.mp4','/d',?,?,?)",
            )
            .bind(&id)
            .bind(&course.id)
            .bind(&title)
            .bind(now - (count - v) as i64 * 86_400_000)
            .bind(v as i64)
            .bind(2_700_000i64)
            .execute(&mut *tx)
            .await
            .unwrap();
            for s in 0..SEGMENTS_PER_VIDEO {
                sqlx::query(
                    "INSERT INTO transcripts(video_id,segment_idx,start_ms,end_ms,text) VALUES (?,?,?,?,?)",
                )
                .bind(&id)
                .bind(s as i64)
                .bind(s as i64 * 3_800)
                .bind(s as i64 * 3_800 + 3_600)
                .bind(sentence(&mut rng))
                .execute(&mut *tx)
                .await
                .unwrap();
            }
            let note: String = (0..30)
                .map(|_| format!("- {}\n", sentence(&mut rng)))
                .collect();
            sqlx::query("INSERT INTO notes(video_id, content_md) VALUES (?,?)")
                .bind(&id)
                .bind(format!("## 要点\n{note}"))
                .execute(&mut *tx)
                .await
                .unwrap();
            sqlx::query(
                "INSERT INTO video_progress(video_id,position_ms,duration_ms,updated_at) VALUES (?,?,?,?)",
            )
            .bind(&id)
            .bind((rng.next() % 2_700_000) as i64)
            .bind(2_700_000i64)
            .bind(now - (rng.next() % 1_000_000_000) as i64)
            .execute(&mut *tx)
            .await
            .unwrap();
            if c == 0 {
                big_videos.push((id.clone(), title.clone()));
            }
        }
        tx.commit().await.unwrap();
        courses.push(course.id);
    }
    // 看课记录：一学期每天几条。
    let ids: Vec<String> = big_videos.iter().map(|(id, _)| id.clone()).collect();
    for day in 0..120i64 {
        for k in 0..6 {
            let video = &ids[(rng.next() % ids.len() as u64) as usize];
            let _ = crate::commands::stats::log_watch(db, video, 600_000 + k).await;
            let _ = day;
        }
    }
    (courses, big_videos)
}

async fn time<F, Fut, T>(label: &str, runs: usize, mut f: F)
where
    F: FnMut() -> Fut,
    Fut: std::future::Future<Output = T>,
{
    let mut samples = Vec::with_capacity(runs);
    for _ in 0..runs {
        let started = Instant::now();
        let _ = f().await;
        samples.push(started.elapsed());
    }
    // 第一次单独报：讲稿缓存是空的，就是用户打开应用后第一次搜的耗时。
    let first = samples[0];
    samples.sort();
    let median = samples[samples.len() / 2];
    println!(
        "{label:<44} 首次 {:>8.1} ms   中位 {:>8.1} ms",
        ms(first),
        ms(median)
    );
}

fn ms(d: Duration) -> f64 {
    d.as_secs_f64() * 1000.0
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "性能基准，手动跑"]
async fn perf_bench() {
    let dir = tempfile::tempdir().unwrap();
    let db = Db::connect_and_migrate(&dir.path().join("bench.db"))
        .await
        .unwrap();
    let started = Instant::now();
    let (courses, big) = seed(&db).await;
    println!(
        "造库：{} 门课、{} 个视频、{} 句文稿，用了 {:.1} s",
        courses.len(),
        BIG_COURSE_VIDEOS + 2 * SMALL_COURSE_VIDEOS,
        (BIG_COURSE_VIDEOS + 2 * SMALL_COURSE_VIDEOS) * SEGMENTS_PER_VIDEO,
        started.elapsed().as_secs_f64()
    );
    let big_course = courses[0].clone();
    let one_video = vec![big[0].clone()];
    let now = chrono::Utc::now().timestamp_millis();

    println!("\n—— 首页 / 课桌 ——");
    time("list_courses", 7, || {
        crate::commands::courses::list_courses(&db)
    })
    .await;
    time("course_totals", 7, || {
        crate::commands::stats::course_totals(&db)
    })
    .await;
    time("continue_rows", 7, || {
        crate::commands::stats::continue_rows(&db)
    })
    .await;
    time("video_progress", 7, || {
        crate::commands::stats::video_progress(&db)
    })
    .await;
    time("course_video_ids", 7, || {
        crate::commands::stats::course_video_ids(&db)
    })
    .await;
    time("daily_totals（一年）", 7, || {
        crate::commands::stats::daily_totals(&db, now - 365 * 86_400_000, now)
    })
    .await;
    time("due_cards", 7, || {
        crate::commands::srs::due_cards(&db, now, 50)
    })
    .await;

    println!("\n—— 课程页 ——");
    time("list_videos_for_ui（400 个视频）", 7, || {
        crate::commands::videos::list_videos_for_ui(&db, &big_course)
    })
    .await;
    time("list_videos（400 个视频）", 7, || {
        crate::commands::videos::list_videos(&db, &big_course)
    })
    .await;

    println!("\n—— 搜索 ——");
    time("search_course 标题+笔记", 5, || {
        crate::commands::search::search_course(&db, &big_course, None, "梯度下降", false)
    })
    .await;
    time("search_course 含文稿", 5, || {
        crate::commands::search::search_course(&db, &big_course, None, "梯度下降", true)
    })
    .await;
    time("search_course 含文稿·无命中", 5, || {
        crate::commands::search::search_course(&db, &big_course, None, "傅里叶变换", true)
    })
    .await;
    time("transcript_search 单视频", 7, || {
        crate::pipeline::rag::transcript_search(&db, &one_video, "学习率", 50)
    })
    .await;

    println!("\n—— 助手检索（整门课 400 个视频） ——");
    time("keyword_search_scope_scored", 5, || {
        crate::pipeline::rag::keyword_search_scope_scored(&db, &big, "学习率太大为什么会震荡", 50)
    })
    .await;
    time("hybrid_search_scope（无语义）", 5, || {
        crate::pipeline::rag::hybrid_search_scope(&db, &big, "学习率太大为什么会震荡", 8, true)
    })
    .await;
    time("transcript_search 整门课", 5, || {
        crate::pipeline::rag::transcript_search(&db, &big, "学习率", 50)
    })
    .await;
    time("list_segments 单视频", 9, || {
        crate::commands::transcripts::list_segments(&db, &big[0].0)
    })
    .await;
}
