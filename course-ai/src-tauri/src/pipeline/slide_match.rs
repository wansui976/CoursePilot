//! 用户贴来的截图 ↔ 已抽取的课件页：按画面比对，找出是哪一页、什么时候出现。
//!
//! 为什么不靠文字：大量课件页没做过 OCR（或者 OCR 只认出零星几个字），模型只能拿截图里的字
//! 去搜字幕，命中的是老师「念到这句话」的时刻，和这页课件出现在画面上的时刻差好几秒。
//! 直接比画面不依赖 OCR，给出的就是这一页出现的时刻。
//!
//! 做法：灰度化 → 切掉四周近乎纯色的边（播放器黑边、截图带进来的窗口边框）→ 缩到 32×18
//! → 去均值、归一化，比对用归一化互相关（两向量点积，1 = 完全一致）。对亮度/对比度变化、
//! 缩放、JPEG 压缩都不敏感；只截了一页的一小块时比不出来，这种情况交回给文字搜索。

use std::collections::HashMap;
use std::path::Path;
use std::sync::{LazyLock, Mutex};
use std::time::SystemTime;

use base64::Engine;
use image::imageops::FilterType;
use image::GrayImage;

/// 存下来的特征分辨率：比比对用的大一倍，留出对齐搜索时裁切重采样的余地。
const STORE_W: usize = 96;
const STORE_H: usize = 54;
/// 实际比对的分辨率。
const CMP_W: usize = 48;
const CMP_H: usize = 27;
/// 边缘一行/一列的亮度标准差低于它就当纯色边切掉。
const FLAT_EDGE_STD: f32 = 6.0;
/// 每一边最多切掉多少比例，免得把整页内容当成边切光。
const MAX_TRIM_SHARE: f32 = 0.3;
/// 缩小比对前先把大图降到这个宽度附近，后面的修边和缩放都在小图上做，快得多。
const WORK_WIDTH: u32 = 320;

/// 一张图的画面特征：修边后缩到 96×54 的灰度值。按字节存：整门课几千页都缓存着也只占十几 MB。
#[derive(Debug, Clone)]
pub struct Signature(Vec<u8>);

/// 归一化坐标下的矩形 (x, y, w, h)。
type Rect = (f32, f32, f32, f32);
const FULL: Rect = (0.0, 0.0, 1.0, 1.0);

/// 对齐搜索的候选裁切。截图和课件页的取景很少完全一致：用户可能只框了画面中间
/// （截图 = 课件的一部分），也可能连播放器的控制条一起截了（截图比课件多一圈）。
/// 几档等比缩放 × 九宫格位置，再加两档只在竖直方向收的（顶部标题栏/底部进度条）。
fn crop_hypotheses() -> Vec<Rect> {
    let mut rects = Vec::new();
    for scale in [0.94_f32, 0.88, 0.82] {
        let slack = 1.0 - scale;
        for fy in [0.0, 0.5, 1.0] {
            for fx in [0.0, 0.5, 1.0] {
                rects.push((slack * fx, slack * fy, scale, scale));
            }
        }
    }
    for scale in [0.92_f32, 0.85] {
        for fy in [0.0, 1.0] {
            rects.push((0.0, (1.0 - scale) * fy, 1.0, scale));
        }
    }
    rects
}

/// 从 96×54 的特征图里按矩形双线性采样出 48×27。
fn sample<T: Copy + Into<f32>>(values: &[T], rect: Rect) -> Vec<f32> {
    let (rx, ry, rw, rh) = rect;
    let mut out = Vec::with_capacity(CMP_W * CMP_H);
    for j in 0..CMP_H {
        let fy = ((ry + rh * (j as f32 + 0.5) / CMP_H as f32) * STORE_H as f32 - 0.5)
            .clamp(0.0, (STORE_H - 1) as f32);
        let y0 = fy.floor() as usize;
        let y1 = (y0 + 1).min(STORE_H - 1);
        let ty = fy - y0 as f32;
        for i in 0..CMP_W {
            let fx = ((rx + rw * (i as f32 + 0.5) / CMP_W as f32) * STORE_W as f32 - 0.5)
                .clamp(0.0, (STORE_W - 1) as f32);
            let x0 = fx.floor() as usize;
            let x1 = (x0 + 1).min(STORE_W - 1);
            let tx = fx - x0 as f32;
            let at = |x: usize, y: usize| -> f32 { values[y * STORE_W + x].into() };
            let top = at(x0, y0) * (1.0 - tx) + at(x1, y0) * tx;
            let bottom = at(x0, y1) * (1.0 - tx) + at(x1, y1) * tx;
            out.push(top * (1.0 - ty) + bottom * ty);
        }
    }
    out
}

/// 局部稳健比对的格子：48×27 切成 8 列 × 3 行。
const CELL_COLS: usize = 8;
const CELL_ROWS: usize = 3;
/// 差异最大的这么多格不计分。
const DROP_WORST_CELLS: f32 = 0.3;

fn zscore(values: &[f32]) -> Option<Vec<f32>> {
    let n = values.len().max(1) as f32;
    let mean = values.iter().sum::<f32>() / n;
    let std = (values.iter().map(|v| (v - mean).powi(2)).sum::<f32>() / n).sqrt();
    (std > 1e-3).then(|| values.iter().map(|v| (v - mean) / std).collect())
}

/// 局部稳健相似度，范围约 [-1, 1]，和 NCC 同一量纲。
///
/// 整张图直接算相关，画面里每一处变化都同等计分。可同一页课件在停留期间会变：角落的讲师
/// 摄像头里人一直在动（面积大、对比度高，一动就把分数拉下去），老师边讲边往上写字。真正
/// 区分页面的印刷文字反而只占一点权重。所以把画面切成格子逐格比，丢掉差异最大的那几格
/// （多半就是摄像头和新写上去的批注），只按剩下的格子打分。
fn robust_similarity(a: &[f32], b: &[f32]) -> f32 {
    match (zscore(a), zscore(b)) {
        (Some(a), Some(b)) => robust_similarity_z(&a, &b),
        _ => 0.0,
    }
}

/// 同上，两边都已经 z 归一化。比对时截图那一侧只归一化一次，整门课几千页都复用。
fn robust_similarity_z(a: &[f32], b: &[f32]) -> f32 {
    let cell_w = CMP_W / CELL_COLS;
    let cell_h = CMP_H / CELL_ROWS;
    let mut cells: Vec<f32> = Vec::with_capacity(CELL_COLS * CELL_ROWS);
    for cy in 0..CELL_ROWS {
        for cx in 0..CELL_COLS {
            let mut sum = 0.0;
            for y in cy * cell_h..(cy + 1) * cell_h {
                for x in cx * cell_w..(cx + 1) * cell_w {
                    let d = a[y * CMP_W + x] - b[y * CMP_W + x];
                    sum += d * d;
                }
            }
            cells.push(sum / (cell_w * cell_h) as f32);
        }
    }
    cells.sort_by(|x, y| x.total_cmp(y));
    let keep = ((cells.len() as f32) * (1.0 - DROP_WORST_CELLS)).round().max(1.0) as usize;
    let mse = cells[..keep].iter().sum::<f32>() / keep as f32;
    // 单位方差的两组数：均方差 = 2(1 - 相关系数)。
    1.0 - mse / 2.0
}

impl Signature {
    /// 两张图直接比（不做对齐搜索）的局部稳健相似度。
    pub fn similarity(&self, other: &Signature) -> f32 {
        robust_similarity(&sample(&self.0, FULL), &sample(&other.0, FULL))
    }
}

/// 在一批课件页里给截图排序，返回 (下标, 分数)，分数降序。
///
/// 每一页都做对齐搜索：截图当作课件的一部分（裁课件去对截图）和课件当作截图的一部分
/// （裁截图去对课件）两个方向，取对得最好的那种裁法的分数。
///
/// 试过先减掉这批候选的平均画面（去掉页眉、摄像头这些每页都有的部分）再比：对齐搜索
/// 加上局部稳健相似度之后，它在真实课件上没有带来提升，反而在候选少时把差异也减没了，删了。
pub fn rank(query: &Signature, candidates: &[Option<Signature>]) -> Vec<(usize, f32)> {
    let rects = crop_hypotheses();
    let z = |v: Vec<f32>| zscore(&v);
    let query_full = z(sample(&query.0, FULL));
    let query_crops: Vec<Option<Vec<f32>>> = rects.iter().map(|r| z(sample(&query.0, *r))).collect();
    let score = |a: &Option<Vec<f32>>, b: &Option<Vec<f32>>| match (a, b) {
        (Some(a), Some(b)) => robust_similarity_z(a, b),
        _ => 0.0,
    };
    let mut scored: Vec<(usize, f32)> = candidates
        .iter()
        .enumerate()
        .filter_map(|(index, candidate)| {
            let candidate = candidate.as_ref()?;
            let candidate_full = z(sample(&candidate.0, FULL));
            let mut best = score(&query_full, &candidate_full);
            for (k, rect) in rects.iter().enumerate() {
                best = best.max(score(&query_full, &z(sample(&candidate.0, *rect))));
                best = best.max(score(&query_crops[k], &candidate_full));
            }
            Some((index, best))
        })
        .collect();
    scored.sort_by(|a, b| b.1.total_cmp(&a.1));
    scored
}

/// 从图片字节算特征。解不出、或整张图几乎是纯色（没有可比的内容）时返回 None。
pub fn signature_from_bytes(bytes: &[u8]) -> Option<Signature> {
    signature_from_image(image::load_from_memory(bytes).ok()?)
}

/// 截图和课件页必须走同一条处理路径（同样先降到工作宽度再修边、缩放），
/// 否则修边的判断在不同分辨率下不一致，同一张图都对不齐。
pub fn signature_from_image(image: image::DynamicImage) -> Option<Signature> {
    let work = if image.width() > WORK_WIDTH {
        let height = (image.height() as u64 * WORK_WIDTH as u64 / image.width() as u64).max(1);
        image.resize_exact(WORK_WIDTH, height as u32, FilterType::Triangle)
    } else {
        image
    };
    signature_from_gray(&work.to_luma8())
}

pub fn signature_from_file(path: &Path) -> Option<Signature> {
    signature_from_bytes(&std::fs::read(path).ok()?)
}

/// `data:image/...;base64,...` → 图片字节。
pub fn decode_data_url(url: &str) -> Option<Vec<u8>> {
    let (_, data) = url.split_once(";base64,")?;
    base64::engine::general_purpose::STANDARD.decode(data).ok()
}

fn signature_from_gray(gray: &GrayImage) -> Option<Signature> {
    let (x0, y0, x1, y1) = content_bounds(gray);
    let cropped = image::imageops::crop_imm(gray, x0, y0, x1 - x0, y1 - y0).to_image();
    let small =
        image::imageops::resize(&cropped, STORE_W as u32, STORE_H as u32, FilterType::Triangle);
    let values: Vec<u8> = small.pixels().map(|p| p.0[0]).collect();
    let mean = values.iter().map(|&v| f32::from(v)).sum::<f32>() / values.len() as f32;
    let spread = (values.iter().map(|&v| (f32::from(v) - mean).powi(2)).sum::<f32>()
        / values.len() as f32)
        .sqrt();
    // 纯色图（黑屏、白屏）没有可比的内容：和谁比都会是噪声。
    if spread < 1.0 {
        return None;
    }
    Some(Signature(values))
}

/// 贴边的窗口条（截图带进来的标题栏、播放器控制条）最多多厚，按边长的比例。
const MAX_CHROME_SHARE: f32 = 0.08;
/// 窗口条后面要跟着至少这么厚的纯色带，才认为前面那条是窗口条而不是课件内容。
const MIN_BAND_SHARE: f32 = 0.02;

/// 纯色带的亮度低于它才算播放器黑边（课件里的留白是亮的，不算）。
const DARK_BAND_LUMA: f32 = 60.0;

/// 这一行（列）是不是暗色纯色带（播放器黑边）。
fn is_dark_band(values: impl Iterator<Item = u8>) -> bool {
    let values: Vec<f32> = values.map(f32::from).collect();
    let n = values.len().max(1) as f32;
    let mean = values.iter().sum::<f32>() / n;
    let std = (values.iter().map(|v| (v - mean).powi(2)).sum::<f32>() / n).sqrt();
    std < FLAT_EDGE_STD && mean < DARK_BAND_LUMA
}

/// 从一条边往里，算该切掉多少行（列）。`line(k)` = 离这条边第 k 行的统计。
///
/// 先切掉贴边的暗色纯色带（播放器黑边）；切不动时再看一眼：要是前面只是一条薄薄的有内容的带子，
/// 后面紧跟一段**暗色**纯色带，那条带子多半是截图带进来的标题栏或控制条（后面是播放器的黑边），
/// 连同黑边一起切掉。只认暗色带：课件里「一行标题 + 下面一片留白」的留白是亮的，不能误切。
fn trim_from_edge(len: u32, dark: impl Fn(u32) -> bool) -> u32 {
    let max_trim = (len as f32 * MAX_TRIM_SHARE) as u32;
    let max_chrome = (len as f32 * MAX_CHROME_SHARE) as u32;
    let min_band = ((len as f32 * MIN_BAND_SHARE) as u32).max(1);
    let mut cut = 0;
    loop {
        // 只切暗色纯色带。课件四周的白色留白是课件的一部分，截图里也会有；切它的话，
        // 截图里有黑边时能切的额度被黑边占掉，两边切掉的留白不一样多，画面就对不齐了。
        while cut < max_trim && dark(cut) {
            cut += 1;
        }
        let limit = (cut + max_chrome).min(max_trim);
        let Some(band_start) = (cut..limit).find(|&k| dark(k)) else {
            return cut;
        };
        let band_len = (band_start..max_trim).take_while(|&k| dark(k)).count() as u32;
        if band_len < min_band {
            return cut;
        }
        cut = band_start;
    }
}

/// 切掉四周的黑边和带进来的窗口条，返回内容区 [x0, x1) × [y0, y1)。
fn content_bounds(gray: &GrayImage) -> (u32, u32, u32, u32) {
    let (w, h) = gray.dimensions();
    let row = |y: u32| is_dark_band((0..w).map(|x| gray.get_pixel(x, y).0[0]));
    let col = |x: u32| is_dark_band((0..h).map(|y| gray.get_pixel(x, y).0[0]));
    let top = trim_from_edge(h, row);
    let bottom = trim_from_edge(h, |k| row(h - 1 - k));
    let left = trim_from_edge(w, col);
    let right = trim_from_edge(w, |k| col(w - 1 - k));
    let (y0, y1) = if top + bottom + 2 <= h { (top, h - bottom) } else { (0, h) };
    let (x0, x1) = if left + right + 2 <= w { (left, w - right) } else { (0, w) };
    (x0, y0, x1, y1)
}

/// 课件页图片的特征缓存：按路径 + 修改时间。同一个视频第二次比对不用再解一遍图。
type SignatureCache = HashMap<String, (Option<SystemTime>, Option<Signature>)>;
static SLIDE_SIGNATURES: LazyLock<Mutex<SignatureCache>> = LazyLock::new(Default::default);

/// 批量取课件页特征（命中缓存的直接用，其余多线程解码）。顺序与输入一致，解不出的为 None。
pub fn slide_signatures(paths: &[String]) -> Vec<Option<Signature>> {
    let mtime = |path: &str| std::fs::metadata(path).and_then(|m| m.modified()).ok();
    let mut out: Vec<Option<Option<Signature>>> = vec![None; paths.len()];
    let mut missing: Vec<usize> = Vec::new();
    {
        let cache = SLIDE_SIGNATURES.lock().ok();
        for (index, path) in paths.iter().enumerate() {
            match cache.as_ref().and_then(|c| c.get(path)) {
                Some((cached_at, signature)) if *cached_at == mtime(path) => {
                    out[index] = Some(signature.clone());
                }
                _ => missing.push(index),
            }
        }
    }
    if !missing.is_empty() {
        let threads = std::thread::available_parallelism()
            .map(|n| n.get())
            .unwrap_or(4)
            .clamp(1, 8);
        let chunk = missing.len().div_ceil(threads);
        let computed: Vec<(usize, Option<SystemTime>, Option<Signature>)> =
            std::thread::scope(|scope| {
                let handles: Vec<_> = missing
                    .chunks(chunk.max(1))
                    .map(|indexes| {
                        scope.spawn(move || {
                            indexes
                                .iter()
                                .map(|&i| {
                                    let path = &paths[i];
                                    (i, mtime(path), signature_from_file(Path::new(path)))
                                })
                                .collect::<Vec<_>>()
                        })
                    })
                    .collect();
                handles
                    .into_iter()
                    .flat_map(|handle| handle.join().unwrap_or_default())
                    .collect()
            });
        let mut cache = SLIDE_SIGNATURES.lock().ok();
        for (index, modified, signature) in computed {
            if let Some(cache) = cache.as_mut() {
                cache.insert(paths[index].clone(), (modified, signature.clone()));
            }
            out[index] = Some(signature);
        }
    }
    out.into_iter().map(Option::flatten).collect()
}

// ---------- 给助手用：查库、比对、写成一段说明 ----------

/// 高于它算「就是这一页」。同一位老师、同一套模板的不同视频之间，错配的最高分实测到 0.92；
/// 正确页几乎都在 0.97 以上。
const CONFIDENT_SCORE: f32 = 0.93;
/// 高于它算「可能是」，列出来让模型再用文字核对；再低就说对不上。
const POSSIBLE_SCORE: f32 = 0.85;
/// 和最高分差不到这么多的页当作同一页的不同状态（老师边讲边写、逐行出现的动画）：
/// 画面几乎一样，分不出是哪一刻，报出现的时间范围。
const SAME_PAGE_MARGIN: f32 = 0.01;
/// 课程范围最多比这么多页：第一次要解码所有课件图，太多会让用户干等。
const MAX_COURSE_SLIDES: i64 = 3000;
/// 同一页课件的多次出现最多列几个。老师翻回去重讲是常事，画面一模一样，
/// 分不出截图是哪一次，只能都列出来让用户挑。
const MAX_REPORTED_PAGES: usize = 8;

#[derive(Debug, Clone)]
struct SlideRow {
    video_id: String,
    video_title: String,
    page_no: i64,
    start_ms: i64,
    end_ms: Option<i64>,
    image_path: String,
}

async fn load_slides(
    db: &crate::db::Db,
    video_id: Option<&str>,
    course_id: Option<&str>,
) -> Vec<SlideRow> {
    type Row = (String, String, i64, i64, Option<i64>, String);
    let rows: Result<Vec<Row>, _> = match (video_id, course_id) {
        (Some(video), _) => {
            sqlx::query_as(
                "SELECT s.video_id, v.title, s.page_no, s.start_ms, s.end_ms, s.image_path
                 FROM slides s JOIN videos v ON v.id = s.video_id
                 WHERE s.video_id = ? ORDER BY s.page_no",
            )
            .bind(video)
            .fetch_all(&db.pool)
            .await
        }
        (None, Some(course)) => {
            sqlx::query_as(
                "SELECT s.video_id, v.title, s.page_no, s.start_ms, s.end_ms, s.image_path
                 FROM slides s JOIN videos v ON v.id = s.video_id
                 WHERE v.course_id = ? AND v.deleted_at IS NULL
                 ORDER BY v.order_index, s.page_no LIMIT ?",
            )
            .bind(course)
            .bind(MAX_COURSE_SLIDES)
            .fetch_all(&db.pool)
            .await
        }
        (None, None) => Ok(Vec::new()),
    };
    rows.unwrap_or_default()
        .into_iter()
        .map(|(video_id, video_title, page_no, start_ms, end_ms, image_path)| SlideRow {
            video_id,
            video_title,
            page_no,
            start_ms,
            end_ms,
            image_path,
        })
        .collect()
}

enum Verdict {
    /// 确定是这一页（或同一页的几个状态，按出现先后）。
    Found(Vec<usize>),
    /// 可能是这几页，分数不够高。
    Possible(Vec<usize>),
    None,
}

fn judge(ranked: &[(usize, f32)]) -> Verdict {
    let Some(&(_, best)) = ranked.first() else {
        return Verdict::None;
    };
    if best >= CONFIDENT_SCORE {
        let mut same: Vec<usize> = ranked
            .iter()
            .take_while(|(_, score)| best - score <= SAME_PAGE_MARGIN)
            .map(|(i, _)| *i)
            .take(MAX_REPORTED_PAGES)
            .collect();
        same.sort_unstable();
        Verdict::Found(same)
    } else if best >= POSSIBLE_SCORE {
        Verdict::Possible(
            ranked
                .iter()
                .take_while(|(_, score)| *score >= POSSIBLE_SCORE)
                .map(|(i, _)| *i)
                .take(3)
                .collect(),
        )
    } else {
        Verdict::None
    }
}

fn describe_page(slide: &SlideRow, with_video: bool) -> String {
    let mmss = crate::pipeline::rag::mmss;
    let until = slide
        .end_ms
        .map(|end| format!("，停留到 {}", mmss(end)))
        .unwrap_or_default();
    let video = if with_video {
        format!("《{}》", slide.video_title)
    } else {
        String::new()
    };
    format!(
        "{video}课件第 {} 页，出现于 {}{until}（video_id={}）",
        slide.page_no + 1,
        mmss(slide.start_ms),
        slide.video_id
    )
}

/// 截图各自比对，写成一段给模型看的说明；没有任何课件页可比时返回说明原因的一句话。
///
/// 先只在当前视频里找（最常见：正在看的这一节截的图），找不到再扩到当前课程。
pub async fn describe_matches(
    db: &crate::db::Db,
    images: &[String],
    video_id: Option<&str>,
    course_id: Option<&str>,
) -> Option<String> {
    if images.is_empty() {
        return None;
    }
    let queries: Vec<Option<Signature>> = {
        let images = images.to_vec();
        tokio::task::spawn_blocking(move || {
            images
                .iter()
                .map(|url| decode_data_url(url).and_then(|bytes| signature_from_bytes(&bytes)))
                .collect()
        })
        .await
        .ok()?
    };

    let video_slides = load_slides(db, video_id, None).await;
    let mut ranked_in_video = rank_all(&queries, &video_slides).await;
    let need_course = ranked_in_video
        .iter()
        .any(|ranked| !matches!(judge(ranked), Verdict::Found(_)));
    let (course_slides, ranked_in_course) = if need_course && course_id.is_some() {
        let slides = load_slides(db, None, course_id).await;
        let ranked = rank_all(&queries, &slides).await;
        (slides, ranked)
    } else {
        (Vec::new(), Vec::new())
    };
    if video_slides.is_empty() && course_slides.is_empty() {
        return Some(
            "（附图比对：当前视频和课程都还没有抽取课件页，没法按画面定位截图出自哪里。\
             只能用截图里的文字去搜字幕；可以提醒用户先在「课件」里抽取课件页，定位会准得多。）"
                .into(),
        );
    }

    let mut lines = Vec::new();
    for (index, query) in queries.iter().enumerate() {
        let label = if images.len() > 1 {
            format!("第 {} 张", index + 1)
        } else {
            "附图".to_string()
        };
        if query.is_none() {
            lines.push(format!("{label}：读不出画面（可能是纯色图），没法比对。"));
            continue;
        }
        let in_video = ranked_in_video.get_mut(index).map(std::mem::take).unwrap_or_default();
        let in_course = ranked_in_course.get(index).cloned().unwrap_or_default();
        let (slides, ranked, with_video) = match judge(&in_video) {
            Verdict::Found(_) => (&video_slides, in_video, false),
            _ if !in_course.is_empty() => (&course_slides, in_course, true),
            _ => (&video_slides, in_video, false),
        };
        let line = match judge(&ranked) {
            Verdict::Found(pages) if pages.len() == 1 => {
                format!("{label}就是{}。", describe_page(&slides[pages[0]], with_video))
            }
            Verdict::Found(pages) => format!(
                "{label}对上的画面在视频里出现了不止一次（同一页课件，老师翻回来重讲或边讲边写），\
                 分不出截的是哪一次，把这几处都告诉用户：最早是{}；其余：{}。",
                describe_page(&slides[pages[0]], with_video),
                pages[1..]
                    .iter()
                    .map(|&i| describe_page(&slides[i], with_video))
                    .collect::<Vec<_>>()
                    .join("；")
            ),
            Verdict::Possible(pages) => format!(
                "{label}可能是：{}。相似度不够高，请用截图里的文字再搜一下核对。",
                pages
                    .iter()
                    .map(|&i| describe_page(&slides[i], with_video))
                    .collect::<Vec<_>>()
                    .join("；")
            ),
            Verdict::None => format!(
                "{label}没有对上已抽取的课件页（可能不是这门课的课件，或者只截了很小一块）。"
            ),
        };
        lines.push(line);
    }
    Some(format!(
        "（附图比对：按画面和已抽取的课件页比对的结果。时间是这一页出现在画面上的时刻，\
         用户问截图「在哪讲的」时以这里的时间为准，不要改用字幕里提到同样字句的时间。\n{}）",
        lines.join("\n")
    ))
}

/// 对每张截图在一批课件页里排序。解码课件图和比对都放到阻塞线程里。
async fn rank_all(queries: &[Option<Signature>], slides: &[SlideRow]) -> Vec<Vec<(usize, f32)>> {
    if slides.is_empty() {
        return vec![Vec::new(); queries.len()];
    }
    let paths: Vec<String> = slides.iter().map(|s| s.image_path.clone()).collect();
    let queries = queries.to_vec();
    tokio::task::spawn_blocking(move || {
        let candidates = slide_signatures(&paths);
        queries
            .iter()
            .map(|query| query.as_ref().map(|q| rank(q, &candidates)).unwrap_or_default())
            .collect()
    })
    .await
    .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::{ImageBuffer, Luma};

    /// 一张「课件」：白底上几块深色文字块，位置由 seed 决定，彼此能区分开。
    fn slide(seed: u32, w: u32, h: u32) -> GrayImage {
        ImageBuffer::from_fn(w, h, |x, y| {
            let block = ((x * 8 / w) * 7 + (y * 6 / h) * 13 + seed * 31) % 5;
            if block == 0 && (y * 6 / h) % 2 == 1 {
                Luma([40])
            } else {
                Luma([235])
            }
        })
    }

    fn sig(image: &GrayImage) -> Signature {
        signature_from_gray(image).expect("has content")
    }

    #[test]
    fn the_same_slide_matches_itself_across_scale() {
        let original = slide(1, 1280, 720);
        let shrunk = image::imageops::resize(&original, 640, 360, FilterType::Triangle);
        assert!(sig(&original).similarity(&sig(&shrunk)) > 0.97);
    }

    #[test]
    fn letterbox_bars_from_the_player_are_trimmed_off() {
        let original = slide(2, 1280, 720);
        // 截屏时连播放器的黑边一起截进来。
        let mut boxed = GrayImage::from_pixel(1280, 900, Luma([0]));
        image::imageops::overlay(&mut boxed, &original, 0, 90);
        assert!(sig(&original).similarity(&sig(&boxed)) > 0.95);
    }

    #[test]
    fn different_slides_score_clearly_lower() {
        let a = sig(&slide(1, 1280, 720));
        let b = sig(&slide(4, 1280, 720));
        assert!(a.similarity(&b) < 0.8);
    }

    #[test]
    fn a_blank_frame_has_no_signature() {
        assert!(signature_from_gray(&GrayImage::from_pixel(64, 36, Luma([0]))).is_none());
    }

    #[test]
    fn data_urls_decode() {
        assert_eq!(decode_data_url("data:image/png;base64,aGk=").unwrap(), b"hi");
        assert!(decode_data_url("https://example.com/a.png").is_none());
    }

    fn png_data_url(image: &GrayImage) -> String {
        let mut bytes = Vec::new();
        image::DynamicImage::ImageLuma8(image.clone())
            .write_to(&mut std::io::Cursor::new(&mut bytes), image::ImageFormat::Png)
            .unwrap();
        format!(
            "data:image/png;base64,{}",
            base64::engine::general_purpose::STANDARD.encode(bytes)
        )
    }

    #[tokio::test]
    async fn a_screenshot_is_located_by_the_time_its_slide_appears() {
        let dir = tempfile::tempdir().unwrap();
        let db = crate::db::Db::connect_and_migrate(&dir.path().join("t.db"))
            .await
            .unwrap();
        let course = crate::commands::courses::create_course(
            &db,
            "课".into(),
            dir.path().to_string_lossy().into(),
        )
        .await
        .unwrap();
        let file = dir.path().join("a.mp4");
        std::fs::write(&file, b"x").unwrap();
        let video = crate::commands::videos::add_local_video(&db, &course.id, file, None)
            .await
            .unwrap();
        for (page, start, end) in [(0_i64, 0_i64, 65_000_i64), (1, 65_000, 130_000), (2, 130_000, 200_000)] {
            let path = dir.path().join(format!("{page}.png"));
            image::DynamicImage::ImageLuma8(slide(page as u32 * 3 + 1, 640, 360))
                .save(&path)
                .unwrap();
            sqlx::query(
                "INSERT INTO slides(video_id,image_path,start_ms,end_ms,page_no) VALUES (?,?,?,?,?)",
            )
            .bind(&video.id)
            .bind(path.to_string_lossy().to_string())
            .bind(start)
            .bind(end)
            .bind(page)
            .execute(&db.pool)
            .await
            .unwrap();
        }

        // 截第 2 页（page_no = 1），连播放器黑边一起截进来。
        let mut shot = GrayImage::from_pixel(800, 560, Luma([5]));
        image::imageops::overlay(
            &mut shot,
            &image::imageops::resize(&slide(4, 640, 360), 800, 450, FilterType::Triangle),
            0,
            55,
        );
        let text = describe_matches(&db, &[png_data_url(&shot)], Some(&video.id), Some(&course.id))
            .await
            .unwrap();
        assert!(text.contains("课件第 2 页，出现于 01:05"), "{text}");
        assert!(text.contains("停留到 02:10"), "{text}");

        // 一张和课件毫无关系的图：老实说对不上，不硬凑一页。
        let unrelated = ImageBuffer::from_fn(400, 300, |x, y| Luma([((x * y) % 251) as u8]));
        let text = describe_matches(&db, &[png_data_url(&unrelated)], Some(&video.id), Some(&course.id))
            .await
            .unwrap();
        assert!(text.contains("没有对上"), "{text}");
    }

    #[tokio::test]
    async fn no_extracted_slides_says_so_instead_of_guessing() {
        let dir = tempfile::tempdir().unwrap();
        let db = crate::db::Db::connect_and_migrate(&dir.path().join("t.db"))
            .await
            .unwrap();
        let text = describe_matches(&db, &[png_data_url(&slide(1, 64, 36))], Some("v"), Some("c"))
            .await
            .unwrap();
        assert!(text.contains("还没有抽取课件页"), "{text}");
    }

    /// 真实库 + 真实截图跑一遍：`MATCH_DB=<库> MATCH_VIDEO=<video id> MATCH_IMAGE=<截图>
    /// cargo test --release --lib slide_match::tests::real_db -- --ignored --nocapture`
    #[tokio::test]
    #[ignore]
    async fn real_db_screenshot() {
        let (Ok(db_path), Ok(video), Ok(image)) = (
            std::env::var("MATCH_DB"),
            std::env::var("MATCH_VIDEO"),
            std::env::var("MATCH_IMAGE"),
        ) else {
            return;
        };
        let db = crate::db::Db::connect_and_migrate(Path::new(&db_path)).await.unwrap();
        let course: Option<String> = sqlx::query_scalar("SELECT course_id FROM videos WHERE id=?")
            .bind(&video)
            .fetch_optional(&db.pool)
            .await
            .unwrap();
        let bytes = std::fs::read(&image).unwrap();
        let url = format!(
            "data:image/png;base64,{}",
            base64::engine::general_purpose::STANDARD.encode(bytes)
        );
        let started = std::time::Instant::now();
        let text = describe_matches(&db, &[url], Some(&video), course.as_deref()).await;
        println!("{:?}\n{}", started.elapsed(), text.unwrap_or_default());
    }

    /// 真实视频截帧 → 比对回课件页：`MATCH_DB=<库> MATCH_VIDEO=<id> MATCH_FRAMES=<目录>`，
    /// 目录里是 `<page_no>.png`，每张取自这一页停留区间的中点。统计比对回同一页（或画面几乎
    /// 一样的相邻页）的比例。
    #[tokio::test]
    #[ignore]
    async fn real_frames_match_back() {
        let (Ok(db_path), Ok(video), Ok(frames)) = (
            std::env::var("MATCH_DB"),
            std::env::var("MATCH_VIDEO"),
            std::env::var("MATCH_FRAMES"),
        ) else {
            return;
        };
        let db = crate::db::Db::connect_and_migrate(Path::new(&db_path)).await.unwrap();
        let slides = load_slides(&db, Some(&video), None).await;
        let paths: Vec<String> = slides.iter().map(|s| s.image_path.clone()).collect();
        let sigs = slide_signatures(&paths);
        let (mut ok, mut total, mut reported) = (0, 0, 0);
        for (i, row) in slides.iter().enumerate() {
            let frame = Path::new(&frames).join(format!("{}.png", row.page_no));
            let Some(query) = signature_from_file(&frame) else { continue };
            total += 1;
            let ranked = rank(&query, &sigs);
            let top = ranked[0].0;
            // 报给模型的那一组（同一页课件的多次出现）里有真实的那一页就算对。
            let group = match judge(&ranked) {
                Verdict::Found(pages) | Verdict::Possible(pages) => pages,
                Verdict::None => Vec::new(),
            };
            reported += group.len();
            if group.contains(&i) {
                ok += 1;
            } else {
                println!(
                    "page {} ({}s) -> page {} ({}s) score {:.3}",
                    row.page_no,
                    row.start_ms / 1000,
                    slides[top].page_no,
                    slides[top].start_ms / 1000,
                    ranked[0].1
                );
            }
        }
        println!(
            "real frames: {ok}/{total}, avg pages reported {:.2}",
            reported as f32 / total.max(1) as f32
        );
    }

    /// 截图来自别的视频时，在本视频课件里能拿到多高的分：决定「认不出」的阈值。
    /// `SLIDE_MATCH_DIR=<查询页目录> OTHER_DIR=<候选页目录> cargo test --release --lib
    /// slide_match::tests::cross -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn cross_video_scores() {
        let (Ok(query_dir), Ok(other_dir)) =
            (std::env::var("SLIDE_MATCH_DIR"), std::env::var("OTHER_DIR"))
        else {
            return;
        };
        let list = |dir: &str| {
            let mut paths: Vec<String> = std::fs::read_dir(dir)
                .unwrap()
                .filter_map(|e| e.ok())
                .map(|e| e.path().to_string_lossy().to_string())
                .filter(|p| p.ends_with(".jpg"))
                .collect();
            paths.sort();
            paths
        };
        let candidates = slide_signatures(&list(&other_dir));
        let mut best: Vec<f32> = slide_signatures(&list(&query_dir))
            .iter()
            .flatten()
            .filter_map(|q| rank(q, &candidates).first().map(|(_, s)| *s))
            .collect();
        best.sort_by(|a, b| a.total_cmp(b));
        let pick = |q: f32| best[((best.len() - 1) as f32 * q) as usize];
        println!(
            "cross best: min {:.3} median {:.3} p90 {:.3} max {:.3}",
            pick(0.0), pick(0.5), pick(0.9), pick(1.0)
        );
    }

    /// 用真实课件图评估：`SLIDE_MATCH_DIR=<某个视频的 slides 目录> cargo test --lib
    /// slide_match::tests::evaluate -- --ignored --nocapture`。
    /// 把每一页做成「截图」（缩小、加黑边、裁掉一点边），看能否排到第一。
    #[test]
    #[ignore]
    fn evaluate_on_real_slides() {
        let Ok(dir) = std::env::var("SLIDE_MATCH_DIR") else {
            return;
        };
        let mut paths: Vec<String> = std::fs::read_dir(&dir)
            .unwrap()
            .filter_map(|e| e.ok())
            .map(|e| e.path().to_string_lossy().to_string())
            .filter(|p| p.ends_with(".jpg"))
            .collect();
        paths.sort();
        let started = std::time::Instant::now();
        let sigs = slide_signatures(&paths);
        println!("{} slides signed in {:?}", paths.len(), started.elapsed());
        let (mut top1, mut total, mut worst_self, mut best_other) = (0, 0, 1.0_f32, -1.0_f32);
        for (i, path) in paths.iter().enumerate() {
            let Some(own) = &sigs[i] else { continue };
            let img = image::open(path).unwrap().to_luma8();
            let (w, h) = img.dimensions();
            let mode = std::env::var("SHOT").unwrap_or_else(|_| "C".into());
            let boxed = match mode.as_str() {
                // A：整帧截图，只是缩放。
                "A" => image::imageops::resize(&img, 1000, 562, FilterType::Triangle),
                // B：整帧 + 播放器上下黑边 + 顶部一条有字的标题栏。
                "B" => {
                    let small = image::imageops::resize(&img, 1000, 562, FilterType::Triangle);
                    let mut canvas = GrayImage::from_pixel(1000, 700, Luma([10]));
                    image::imageops::overlay(&mut canvas, &small, 0, 90);
                    for x in 0..1000 {
                        for y in 0..36 {
                            let ink = (x / 9) % 3 == 0 && (12..24).contains(&y) && x < 300;
                            canvas.put_pixel(x, y, Luma([if ink { 220 } else { 40 }]));
                        }
                    }
                    canvas
                }
                // C：只框了中间（四周各裁掉 1/30）。
                _ => {
                    let crop =
                        image::imageops::crop_imm(&img, w / 30, h / 30, w - w / 15, h - h / 15).to_image();
                    image::imageops::resize(&crop, 900, 506, FilterType::Triangle)
                }
            };
            let Some(shot) = signature_from_image(image::DynamicImage::ImageLuma8(boxed)) else {
                continue;
            };
            total += 1;
            let scored = rank(&shot, &sigs);
            let self_score = scored.iter().find(|(j, _)| *j == i).map(|(_, s)| *s).unwrap_or(0.0);
            worst_self = worst_self.min(self_score);
            // 和自己几乎一样的页（逐行出现的动画页）算对：它们本来就分不出。
            let near_dupe = |j: usize| sigs[j].as_ref().is_some_and(|s| s.similarity(own) > 0.97);
            if near_dupe(scored[0].0) {
                top1 += 1;
            } else if std::env::var("SHOW_MISSES").is_ok() {
                let j = scored[0].0;
                println!(
                    "miss: page {i} -> {j} (score {:.3} vs self {self_score:.3}, raw sim {:.3})",
                    scored[0].1,
                    sigs[j].as_ref().map(|s| s.similarity(own)).unwrap_or(0.0)
                );
            }
            if let Some(other) = scored.iter().find(|(j, _)| !near_dupe(*j)) {
                best_other = best_other.max(other.1);
            }
        }
        println!("top1 {top1}/{total}  worst self score {worst_self:.3}  best non-dupe {best_other:.3}");
    }
}
