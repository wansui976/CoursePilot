//! PaddleOCR（PP-OCRv6 small）本地 OCR，只在桌面上用。
//!
//! Windows 上本地 OCR 原来只有 Tesseract，认中文课件错字多、整行漏认是常事；Mac 上的 Apple Vision
//! 已经不错，但也有人想要和 Windows 一样的结果。
//!
//! 为什么是 v6 small：合成课件（1080p 原图 + 缩到 720p 再 JPEG 压缩的「视频帧」，黑体 / 宋体 /
//! 深色底 / 中英混排小字，共 1168 字）实测字错率 v5 mobile 2.40%、v6 small 0.26%、v6 medium 0.17%；
//! 每页耗时（M 系列 CPU、release）219 / 281 / 1352 ms。v5 在压缩过的视频帧上会整字漏掉
//! （「行为」认成「为」），v6 small 只错标点。medium 准一点点，但慢 5 倍、模型 139MB，不值。
//! 两个模型加字典一共 30MB。
//!
//! 推理用 sherpa-onnx 已经带着的那份 onnxruntime（`ort` 的 load-dynamic）：安装包不多一个运行库，
//! 进程里也只有一份 ORT。
//!
//! 流程照 PaddleOCR / RapidOCR 的默认做法：
//! 1. 检测：长边缩到不超过 [`DET_MAX_SIDE`]、两边取 32 的倍数，出一张「这里是字」的概率图；
//!    二值化后找轮廓、取最小外接矩形，按框内平均概率过滤，再按 1.5 倍外扩（unclip）。
//! 2. 识别：每个框透视拉正成高 48 的条，过识别模型，CTC 贪心解码成字。
//! 3. 按行拼回去：同一行（纵向重叠过半）的框从左到右用空格连，行与行之间换行。

use crate::error::{AppError, AppResult};
use crate::pipeline::local_asr::ModelFile;
use image::{imageops, GrayImage, Luma, Rgb, RgbImage};
use imageproc::geometric_transformations::{warp_into, Border, Interpolation, Projection};
use ort::session::Session;
use ort::value::Tensor;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};

/// 装在 `<模型存放目录>/ocr/<DIR>/` 下，和语音识别模型共用「模型存放位置」。
pub const DIR: &str = "ppocrv6-small";
pub const DISPLAY_NAME: &str = "PaddleOCR PP-OCRv6";

macro_rules! urls {
    ($($url:expr),+ $(,)?) => { &[$($url),+] };
}

/// 模型用 PaddlePaddle 官方发布的 ONNX（ModelScope 与 Hugging Face 上是同一份，哈希一致）；
/// 字典在官方包里是嵌在 inference.yml 里的，这里取 RapidOCR 整理成的同一份 txt（逐项核对过）。
pub const FILES: &[ModelFile] = &[
    ModelFile {
        path: "det.onnx",
        sha256: "d73e0058b7a8086bbd57f3d10b8bcd4ff95363f67e06e2762b5e814fe9c9410e",
        size: 9_880_512,
        urls: urls![
            "https://modelscope.cn/models/PaddlePaddle/PP-OCRv6_small_det_onnx/resolve/master/inference.onnx",
            "https://huggingface.co/PaddlePaddle/PP-OCRv6_small_det_onnx/resolve/main/inference.onnx",
        ],
    },
    ModelFile {
        path: "rec.onnx",
        sha256: "5435fd747c9e0efe15a96d0b378d5bd157e9492ed8fd80edf08f30d02fa24634",
        size: 21_159_378,
        urls: urls![
            "https://modelscope.cn/models/PaddlePaddle/PP-OCRv6_small_rec_onnx/resolve/master/inference.onnx",
            "https://huggingface.co/PaddlePaddle/PP-OCRv6_small_rec_onnx/resolve/main/inference.onnx",
        ],
    },
    ModelFile {
        path: "ppocrv6_dict.txt",
        sha256: "b5f2bfe2bdd9448429e3e82b51c789775d9b42f2403d082b00662eb77e401c5d",
        size: 74_947,
        urls: urls![
            "https://modelscope.cn/models/RapidAI/RapidOCR/resolve/master/paddle/PP-OCRv6/rec/PP-OCRv6_rec_small/ppocrv6_dict.txt",
            "https://huggingface.co/ogkalu/ppocr-v6-onnx/resolve/main/PP-OCRv6_small_rec.txt",
        ],
    },
];

const DICT_FILE: &str = "ppocrv6_dict.txt";

pub fn model_dir(models_root: &Path) -> PathBuf {
    models_root.join("ocr").join(DIR)
}

pub fn download_size() -> u64 {
    FILES.iter().map(|file| file.size).sum()
}

fn file_ok(path: &Path, file: &ModelFile) -> bool {
    std::fs::metadata(path).is_ok_and(|meta| meta.is_file() && meta.len() == file.size)
}

pub fn is_installed(models_root: &Path) -> bool {
    let dir = model_dir(models_root);
    FILES.iter().all(|file| file_ok(&dir.join(file.path), file))
}

pub fn missing_files(models_root: &Path) -> Vec<(PathBuf, &'static ModelFile)> {
    let dir = model_dir(models_root);
    FILES
        .iter()
        .map(|file| (dir.join(file.path), file))
        .filter(|(path, file)| !file_ok(path, file))
        .collect()
}

// ---------------------------------------------------------------- 运行库

/// sherpa-onnx 带的 onnxruntime 放在哪：安装包里 macOS 在 Contents/Frameworks，
/// Windows / Linux 在可执行文件旁边；开发时（target/debug）也在可执行文件旁边。
fn runtime_candidates() -> Vec<PathBuf> {
    let Some(exe_dir) = std::env::current_exe().ok().and_then(|exe| exe.parent().map(Path::to_path_buf)) else {
        return Vec::new();
    };
    #[cfg(target_os = "macos")]
    let names: &[&str] = &["../Frameworks/libonnxruntime.dylib", "libonnxruntime.dylib"];
    #[cfg(target_os = "windows")]
    let names: &[&str] = &["onnxruntime.dll"];
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    let names: &[&str] = &["libonnxruntime.so", "../lib/libonnxruntime.so"];
    names.iter().map(|name| exe_dir.join(name)).collect()
}

/// ORT 环境只建一次（load-dynamic 只能初始化一次）。失败原因留着，之后每次都报同一个。
fn environment() -> AppResult<&'static ort::environment::Environment> {
    static ENV: OnceLock<Result<ort::environment::Environment, String>> = OnceLock::new();
    ENV.get_or_init(|| {
        // ORT_DYLIB_PATH 是 ort 的惯例：测试、或者想换一份 onnxruntime 时用。
        let path = std::env::var_os("ORT_DYLIB_PATH")
            .map(PathBuf::from)
            .into_iter()
            .chain(runtime_candidates())
            .find(|path| path.is_file())
            .ok_or_else(|| "找不到 onnxruntime 运行库（应随本地语音识别一起安装）".to_string())?;
        ort::init_from(&path)
            .map_err(|error| format!("加载 onnxruntime 失败（{}）：{error}", path.display()))?
            .with_name("course-ai-ocr")
            .build()
            .map_err(|error| format!("初始化 onnxruntime 失败：{error}"))
    })
    .as_ref()
    .map_err(|error| AppError::Pipeline(error.clone()))
}

// ---------------------------------------------------------------- 模型

pub struct PaddleOcr {
    det: Mutex<Session>,
    rec: Mutex<Session>,
    /// 下标 i 对应识别输出的第 i+1 类（第 0 类是 CTC 空白）；末尾补一个空格，和训练时一致。
    dict: Vec<String>,
}

/// 加载好的模型按目录缓存：一门课几十页课件只加载一次；换了模型存放位置就重新加载。
type EngineCache = Mutex<Option<(PathBuf, Arc<PaddleOcr>)>>;

fn cached(dir: &Path) -> AppResult<Arc<PaddleOcr>> {
    static CACHE: OnceLock<EngineCache> = OnceLock::new();
    let cache = CACHE.get_or_init(|| Mutex::new(None));
    let mut slot = cache.lock().map_err(|_| AppError::Pipeline("OCR 模型缓存损坏".into()))?;
    if let Some((cached_dir, engine)) = slot.as_ref() {
        if cached_dir == dir {
            return Ok(engine.clone());
        }
    }
    let engine = Arc::new(PaddleOcr::load(dir)?);
    *slot = Some((dir.to_path_buf(), engine.clone()));
    Ok(engine)
}

impl PaddleOcr {
    pub fn load(dir: &Path) -> AppResult<Self> {
        let env = environment()?;
        let session = |name: &str| -> AppResult<Session> {
            let threads = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(4).min(4);
            Session::builder(env)
                .and_then(|builder| builder.with_intra_threads(threads).map_err(Into::into))
                .and_then(|mut builder| builder.commit_from_file(dir.join(name)))
                .map_err(|error| AppError::Pipeline(format!("加载 PaddleOCR 模型 {name} 失败：{error}")))
        };
        let dict_text = std::fs::read_to_string(dir.join(DICT_FILE))?;
        let mut dict: Vec<String> = dict_text
            .lines()
            .map(|line| line.trim_end_matches('\r').to_string())
            .collect();
        dict.push(" ".into());
        Ok(Self { det: Mutex::new(session("det.onnx")?), rec: Mutex::new(session("rec.onnx")?), dict })
    }

    pub fn recognize(&self, image: &RgbImage) -> AppResult<String> {
        let boxes = self.detect(image)?;
        let mut lines = Vec::new();
        for quad in boxes {
            let crop = crop_quad(image, &quad);
            if let Some((text, score)) = self.read_line(&crop)? {
                if score >= REC_MIN_SCORE && !text.trim().is_empty() {
                    lines.push(TextBox { quad, text: text.trim().to_string() });
                }
            }
        }
        Ok(join_lines(lines))
    }

    fn detect(&self, image: &RgbImage) -> AppResult<Vec<[(f32, f32); 4]>> {
        let (width, height) = image.dimensions();
        let (det_w, det_h) = det_size(width, height);
        let resized = imageops::resize(image, det_w, det_h, imageops::FilterType::Triangle);
        // PaddleOCR 按 OpenCV 的 BGR 顺序训练；均值方差是 ImageNet 那组。
        const MEAN: [f32; 3] = [0.485, 0.456, 0.406];
        const STD: [f32; 3] = [0.229, 0.224, 0.225];
        let plane = (det_w * det_h) as usize;
        let mut input = vec![0f32; plane * 3];
        for (i, pixel) in resized.pixels().enumerate() {
            let bgr = [pixel[2], pixel[1], pixel[0]];
            for c in 0..3 {
                input[c * plane + i] = (bgr[c] as f32 / 255.0 - MEAN[c]) / STD[c];
            }
        }
        let tensor = Tensor::from_array(([1usize, 3, det_h as usize, det_w as usize], input))
            .map_err(|error| AppError::Pipeline(format!("PaddleOCR 检测输入：{error}")))?;
        let mut det = self.det.lock().map_err(|_| AppError::Pipeline("OCR 检测模型被占用".into()))?;
        let outputs = det
            .run(ort::inputs![tensor])
            .map_err(|error| AppError::Pipeline(format!("PaddleOCR 检测失败：{error}")))?;
        let (shape, prob) = outputs[0]
            .try_extract_tensor::<f32>()
            .map_err(|error| AppError::Pipeline(format!("PaddleOCR 检测输出：{error}")))?;
        let map_h = shape[shape.len() - 2] as u32;
        let map_w = shape[shape.len() - 1] as u32;
        Ok(boxes_from_map(prob, map_w, map_h, width as f32 / map_w as f32, height as f32 / map_h as f32))
    }

    /// 一个文字条 → (文字, 平均置信度)。条太小（宽或高不到 2 像素）返回 None。
    fn read_line(&self, crop: &RgbImage) -> AppResult<Option<(String, f32)>> {
        let (w, h) = crop.dimensions();
        if w < 2 || h < 2 {
            return Ok(None);
        }
        let target_w = ((REC_HEIGHT as f32 * w as f32 / h as f32).ceil() as u32).clamp(8, REC_MAX_WIDTH);
        let resized = imageops::resize(crop, target_w, REC_HEIGHT, imageops::FilterType::Triangle);
        let plane = (target_w * REC_HEIGHT) as usize;
        let mut input = vec![0f32; plane * 3];
        for (i, pixel) in resized.pixels().enumerate() {
            let bgr = [pixel[2], pixel[1], pixel[0]];
            for c in 0..3 {
                input[c * plane + i] = (bgr[c] as f32 / 255.0 - 0.5) / 0.5;
            }
        }
        let tensor = Tensor::from_array(([1usize, 3, REC_HEIGHT as usize, target_w as usize], input))
            .map_err(|error| AppError::Pipeline(format!("PaddleOCR 识别输入：{error}")))?;
        let mut rec = self.rec.lock().map_err(|_| AppError::Pipeline("OCR 识别模型被占用".into()))?;
        let outputs = rec
            .run(ort::inputs![tensor])
            .map_err(|error| AppError::Pipeline(format!("PaddleOCR 识别失败：{error}")))?;
        let (shape, probs) = outputs[0]
            .try_extract_tensor::<f32>()
            .map_err(|error| AppError::Pipeline(format!("PaddleOCR 识别输出：{error}")))?;
        let steps = shape[shape.len() - 2] as usize;
        let classes = shape[shape.len() - 1] as usize;
        Ok(Some(ctc_decode(probs, steps, classes, &self.dict)))
    }
}

/// 识别一张图片文件。模型目录里缺文件时报错，提示去设置里下载。
pub async fn recognize_file(models_root: &Path, image: &Path) -> AppResult<String> {
    if !is_installed(models_root) {
        return Err(AppError::Pipeline(
            "PaddleOCR 模型还没下载：设置 → 课件 / OCR 里点「下载」，或换回系统 OCR".into(),
        ));
    }
    let dir = model_dir(models_root);
    let image = image.to_path_buf();
    tokio::task::spawn_blocking(move || {
        let picture = image::open(&image)
            .map_err(|error| AppError::Pipeline(format!("读不了课件图片：{error}")))?
            .to_rgb8();
        cached(&dir)?.recognize(&picture)
    })
    .await
    .map_err(|error| AppError::Pipeline(format!("PaddleOCR 任务失败：{error}")))?
}

// ---------------------------------------------------------------- 检测后处理

/// 检测输入的长边上限。课件常是 1920×1080，字小：960（PaddleOCR 默认）会漏掉页脚小字，
/// 再大 CPU 上就慢了。
const DET_MAX_SIDE: u32 = 1280;
// 下面三个照 PP-OCRv6 官方 inference.yml 的 DBPostProcess（v5 是 0.3 / 0.6 / 1.5）。
const DET_THRESH: f32 = 0.2;
const BOX_THRESH: f32 = 0.45;
const UNCLIP_RATIO: f32 = 1.4;
const MIN_BOX_SIDE: f32 = 3.0;
const MAX_CANDIDATES: usize = 1000;

const REC_HEIGHT: u32 = 48;
/// 特别长的一行（整页宽的标题）压到这么宽，再长识别模型的显存/耗时涨得快、准确率反而降。
const REC_MAX_WIDTH: u32 = 3200;
const REC_MIN_SCORE: f32 = 0.5;

/// 检测输入尺寸：长边不超过上限，两边都是 32 的倍数（不小于 32）。
fn det_size(width: u32, height: u32) -> (u32, u32) {
    let scale = (DET_MAX_SIDE as f32 / width.max(height) as f32).min(1.0);
    let round = |v: u32| ((((v as f32) * scale / 32.0).round() as u32) * 32).max(32);
    (round(width), round(height))
}

/// 概率图 → 原图坐标里的四边形（左上、右上、右下、左下），从上到下排好。
fn boxes_from_map(
    prob: &[f32],
    map_w: u32,
    map_h: u32,
    scale_x: f32,
    scale_y: f32,
) -> Vec<[(f32, f32); 4]> {
    let mask = GrayImage::from_fn(map_w, map_h, |x, y| {
        Luma([if prob[(y * map_w + x) as usize] > DET_THRESH { 255 } else { 0 }])
    });
    let contours = imageproc::contours::find_contours::<i32>(&mask);
    let mut boxes = Vec::new();
    for contour in contours
        .iter()
        .filter(|c| c.border_type == imageproc::contours::BorderType::Outer && c.points.len() >= 4)
        .take(MAX_CANDIDATES)
    {
        let rect = imageproc::geometry::min_area_rect(&contour.points);
        let corners = rect.map(|p| (p.x as f32, p.y as f32));
        let (w, h) = rect_sides(&corners);
        if w.min(h) < MIN_BOX_SIDE {
            continue;
        }
        if box_score(prob, map_w, map_h, &corners) < BOX_THRESH {
            continue;
        }
        let expanded = unclip(&corners, UNCLIP_RATIO);
        let (w, h) = rect_sides(&expanded);
        if w.min(h) < MIN_BOX_SIDE + 2.0 {
            continue;
        }
        let ordered = order_corners(expanded);
        boxes.push(ordered.map(|(x, y)| (
            (x * scale_x).clamp(0.0, map_w as f32 * scale_x - 1.0),
            (y * scale_y).clamp(0.0, map_h as f32 * scale_y - 1.0),
        )));
    }
    boxes.sort_by(|a, b| {
        let (ay, by) = (a[0].1, b[0].1);
        if (ay - by).abs() < 10.0 {
            a[0].0.total_cmp(&b[0].0)
        } else {
            ay.total_cmp(&by)
        }
    });
    boxes
}

fn dist(a: (f32, f32), b: (f32, f32)) -> f32 {
    ((a.0 - b.0).powi(2) + (a.1 - b.1).powi(2)).sqrt()
}

fn rect_sides(c: &[(f32, f32); 4]) -> (f32, f32) {
    (dist(c[0], c[1]), dist(c[1], c[2]))
}

/// 框内（矩形内的像素）平均概率：把「几个零星亮点凑出的大框」筛掉。
fn box_score(prob: &[f32], map_w: u32, map_h: u32, c: &[(f32, f32); 4]) -> f32 {
    let xs = c.iter().map(|p| p.0);
    let ys = c.iter().map(|p| p.1);
    let x0 = xs.clone().fold(f32::MAX, f32::min).floor().max(0.0) as u32;
    let x1 = (xs.fold(f32::MIN, f32::max).ceil() as u32).min(map_w - 1);
    let y0 = ys.clone().fold(f32::MAX, f32::min).floor().max(0.0) as u32;
    let y1 = (ys.fold(f32::MIN, f32::max).ceil() as u32).min(map_h - 1);
    let (mut sum, mut n) = (0f32, 0u32);
    for y in y0..=y1 {
        for x in x0..=x1 {
            if inside(c, (x as f32 + 0.5, y as f32 + 0.5)) {
                sum += prob[(y * map_w + x) as usize];
                n += 1;
            }
        }
    }
    if n == 0 { 0.0 } else { sum / n as f32 }
}

/// 点在凸四边形内（含边上）。
fn inside(c: &[(f32, f32); 4], p: (f32, f32)) -> bool {
    let mut sign = 0f32;
    for i in 0..4 {
        let (a, b) = (c[i], c[(i + 1) % 4]);
        let cross = (b.0 - a.0) * (p.1 - a.1) - (b.1 - a.1) * (p.0 - a.0);
        if cross.abs() < 1e-6 {
            continue;
        }
        if sign == 0.0 {
            sign = cross.signum();
        } else if cross.signum() != sign {
            return false;
        }
    }
    true
}

/// DB 的 unclip：检测出的是缩进去的「字芯」，按 面积×比例/周长 向外扩回整个字。
/// 矩形向外偏移 d 等于每条边各推出去 d。
fn unclip(c: &[(f32, f32); 4], ratio: f32) -> [(f32, f32); 4] {
    let (w, h) = rect_sides(c);
    let d = (w * h * ratio) / (2.0 * (w + h));
    let center = ((c[0].0 + c[2].0) / 2.0, (c[0].1 + c[2].1) / 2.0);
    let ux = ((c[1].0 - c[0].0) / w.max(1e-6), (c[1].1 - c[0].1) / w.max(1e-6));
    let uy = ((c[2].0 - c[1].0) / h.max(1e-6), (c[2].1 - c[1].1) / h.max(1e-6));
    let (hw, hh) = (w / 2.0 + d, h / 2.0 + d);
    [(-1.0, -1.0), (1.0, -1.0), (1.0, 1.0), (-1.0, 1.0)].map(|(sx, sy): (f32, f32)| {
        (
            center.0 + sx * hw * ux.0 + sy * hh * uy.0,
            center.1 + sx * hw * ux.1 + sy * hh * uy.1,
        )
    })
}

/// 四个角排成 左上、右上、右下、左下。
fn order_corners(c: [(f32, f32); 4]) -> [(f32, f32); 4] {
    let tl = *c.iter().min_by(|a, b| (a.0 + a.1).total_cmp(&(b.0 + b.1))).unwrap();
    let br = *c.iter().max_by(|a, b| (a.0 + a.1).total_cmp(&(b.0 + b.1))).unwrap();
    let tr = *c.iter().min_by(|a, b| (a.1 - a.0).total_cmp(&(b.1 - b.0))).unwrap();
    let bl = *c.iter().max_by(|a, b| (a.1 - a.0).total_cmp(&(b.1 - b.0))).unwrap();
    [tl, tr, br, bl]
}

/// 把四边形透视拉正成矩形条；竖排（高是宽的 1.5 倍以上）转 90° 成横条。
fn crop_quad(image: &RgbImage, quad: &[(f32, f32); 4]) -> RgbImage {
    let w = dist(quad[0], quad[1]).max(dist(quad[3], quad[2])).round().max(1.0) as u32;
    let h = dist(quad[0], quad[3]).max(dist(quad[1], quad[2])).round().max(1.0) as u32;
    let dst = [(0.0, 0.0), (w as f32, 0.0), (w as f32, h as f32), (0.0, h as f32)];
    let mut out = RgbImage::new(w, h);
    // 输出像素 → 原图像素：warp 需要的是「把原图坐标映到输出坐标」的变换。
    if let Some(projection) = Projection::from_control_points(*quad, dst) {
        warp_into(image, projection, Interpolation::Bilinear, Border::Constant(Rgb([255, 255, 255])), &mut out);
    }
    if h as f32 >= w as f32 * 1.5 {
        imageops::rotate270(&out)
    } else {
        out
    }
}

// ---------------------------------------------------------------- 识别后处理

/// CTC 贪心解码：每一步取概率最大的类，去掉空白（第 0 类）和相邻重复。
/// 返回文字和保留下来的那些字的平均概率。
fn ctc_decode(probs: &[f32], steps: usize, classes: usize, dict: &[String]) -> (String, f32) {
    let mut text = String::new();
    let (mut score, mut kept) = (0f32, 0u32);
    let mut previous = 0usize;
    for t in 0..steps {
        let row = &probs[t * classes..(t + 1) * classes];
        let (best, p) = row
            .iter()
            .enumerate()
            .fold((0usize, f32::MIN), |acc, (i, &v)| if v > acc.1 { (i, v) } else { acc });
        if best != 0 && best != previous {
            if let Some(ch) = dict.get(best - 1) {
                text.push_str(ch);
                score += p;
                kept += 1;
            }
        }
        previous = best;
    }
    (text, if kept == 0 { 0.0 } else { score / kept as f32 })
}

struct TextBox {
    quad: [(f32, f32); 4],
    text: String,
}

/// 按行拼：纵向和上一个框重叠过半就算同一行（从左到右用空格连），否则换行。
fn join_lines(mut boxes: Vec<TextBox>) -> String {
    let top = |b: &TextBox| b.quad[0].1.min(b.quad[1].1);
    let bottom = |b: &TextBox| b.quad[2].1.max(b.quad[3].1);
    boxes.sort_by(|a, b| top(a).total_cmp(&top(b)));
    let mut rows: Vec<Vec<TextBox>> = Vec::new();
    for item in boxes {
        let joins = rows.last().is_some_and(|row| {
            let (rt, rb) = row.iter().fold((f32::MAX, f32::MIN), |(t, b), x| (t.min(top(x)), b.max(bottom(x))));
            let overlap = rb.min(bottom(&item)) - rt.max(top(&item));
            overlap > 0.5 * (bottom(&item) - top(&item)).min(rb - rt)
        });
        if joins {
            rows.last_mut().unwrap().push(item);
        } else {
            rows.push(vec![item]);
        }
    }
    rows.into_iter()
        .map(|mut row| {
            row.sort_by(|a, b| a.quad[0].0.total_cmp(&b.quad[0].0));
            row.into_iter().map(|b| b.text).collect::<Vec<_>>().join(" ")
        })
        .collect::<Vec<_>>()
        .join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detection_input_is_capped_and_a_multiple_of_32() {
        assert_eq!(det_size(1920, 1080), (1280, 736));
        assert_eq!(det_size(640, 480), (640, 480));
        assert_eq!(det_size(10, 10), (32, 32));
    }

    #[test]
    fn ctc_drops_blanks_and_repeats() {
        let dict: Vec<String> = ["梯", "度", " "].iter().map(|s| s.to_string()).collect();
        // 4 类：空白、梯、度、空格。序列：梯 梯 空白 梯 度 度 → 「梯梯度」
        let rows = [[0.1, 0.9, 0.0, 0.0], [0.1, 0.8, 0.1, 0.0], [0.9, 0.05, 0.05, 0.0], [0.0, 0.7, 0.3, 0.0], [0.0, 0.1, 0.9, 0.0], [0.0, 0.0, 0.8, 0.2]];
        let probs: Vec<f32> = rows.iter().flatten().copied().collect();
        let (text, score) = ctc_decode(&probs, rows.len(), 4, &dict);
        assert_eq!(text, "梯梯度");
        assert!((score - (0.9 + 0.7 + 0.9) / 3.0).abs() < 1e-5);
    }

    #[test]
    fn unclip_grows_each_side_by_the_same_distance() {
        let rect = [(10.0, 10.0), (110.0, 10.0), (110.0, 30.0), (10.0, 30.0)];
        let out = unclip(&rect, 1.5);
        // d = 100*20*1.5 / (2*120) = 12.5
        assert_eq!(order_corners(out), [(-2.5, -2.5), (122.5, -2.5), (122.5, 42.5), (-2.5, 42.5)]);
    }

    #[test]
    fn boxes_on_the_same_row_join_left_to_right() {
        let b = |x: f32, y: f32, text: &str| TextBox {
            quad: [(x, y), (x + 50.0, y), (x + 50.0, y + 20.0), (x, y + 20.0)],
            text: text.into(),
        };
        let out = join_lines(vec![b(200.0, 12.0, "下降"), b(10.0, 10.0, "梯度"), b(10.0, 60.0, "学习率")]);
        assert_eq!(out, "梯度 下降\n学习率");
    }

    /// 真模型、真运行库跑一张合成的课件图。模型不在本机时跳过：
    /// `PADDLE_OCR_MODELS=/path/to/ppocrv6-small cargo test --lib paddle_ocr -- --ignored`
    #[test]
    #[ignore]
    fn reads_a_rendered_slide() {
        let Ok(dir) = std::env::var("PADDLE_OCR_MODELS") else { return };
        let image = std::env::var("PADDLE_OCR_IMAGE").expect("PADDLE_OCR_IMAGE");
        let engine = PaddleOcr::load(Path::new(&dir)).expect("load");
        let picture = image::open(image).unwrap().to_rgb8();
        let started = std::time::Instant::now();
        let text = engine.recognize(&picture).unwrap();
        eprintln!("{:?}\n---\n{text}", started.elapsed());
        assert!(text.contains("梯度下降"), "{text}");
    }

    /// 测速 / 测准：`PADDLE_OCR_BENCH=模型目录;...`，`PADDLE_OCR_IMAGES=图1,图2,...`。
    /// 每张图打印一行 JSON：{"model","image","ms","text"}，准确率在外面算。
    #[test]
    #[ignore]
    fn bench_models() {
        let (Ok(models), Ok(images)) = (std::env::var("PADDLE_OCR_BENCH"), std::env::var("PADDLE_OCR_IMAGES")) else {
            return;
        };
        for spec in models.split(';').filter(|s| !s.is_empty()) {
            let engine = PaddleOcr::load(Path::new(spec)).expect("load");
            // 预热一次：第一次推理要分配内存、编译图，不算进耗时。
            let first = images.split(',').next().unwrap();
            let _ = engine.recognize(&image::open(first).unwrap().to_rgb8());
            for path in images.split(',') {
                let picture = image::open(path).unwrap().to_rgb8();
                let started = std::time::Instant::now();
                let text = engine.recognize(&picture).unwrap();
                let ms = started.elapsed().as_millis();
                println!(
                    "BENCH {}",
                    serde_json::json!({ "model": spec, "image": path, "ms": ms, "text": text })
                );
            }
        }
    }
}
