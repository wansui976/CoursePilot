//! 对同一个视频平台的请求，开始时间之间留出最小间隔。
//!
//! 批量导入一整个合集时，探测、下载、字幕、弹幕、评论会在几秒内对同一个站点连发
//! 几十个请求，B 站回 -412 / -352 风控、YouTube 字幕回 429。事后退避重试只能挨过一阵，
//! 被拉进风控名单后整批都会失败；事先把请求摊开，比撞墙之后再等稳得多。
//!
//! 只管「开始」的间隔，不限并发：一个大文件下几分钟，不该挡住后面的探测请求。
//! 进程内全局一份——本应用只有一个后端进程，多个下载任务之间共享同一个节拍。

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Platform {
    Bilibili,
    YouTube,
    Chaoxing,
}

impl Platform {
    /// 相邻两次请求开始之间至少隔多久。按各站实际的风控松紧定，宁可慢一点。
    fn interval(self) -> Duration {
        match self {
            Platform::Bilibili => Duration::from_millis(1200),
            Platform::YouTube => Duration::from_millis(1500),
            Platform::Chaoxing => Duration::from_millis(800),
        }
    }

    /// 按网址的主机认平台；认不出的（本地文件、其它站点）不限速。
    pub fn of_url(url: &str) -> Option<Platform> {
        let host = reqwest::Url::parse(url.trim())
            .ok()?
            .host_str()?
            .to_ascii_lowercase();
        let under = |domain: &str| host == domain || host.ends_with(&format!(".{domain}"));
        if under("bilibili.com") || under("b23.tv") || under("bilivideo.com") {
            Some(Platform::Bilibili)
        } else if under("youtube.com") || under("youtu.be") || under("googlevideo.com") {
            Some(Platform::YouTube)
        } else if under("chaoxing.com") || under("xuexi365.com") {
            Some(Platform::Chaoxing)
        } else {
            None
        }
    }
}

fn next_slots() -> &'static Mutex<HashMap<Platform, Instant>> {
    static SLOTS: OnceLock<Mutex<HashMap<Platform, Instant>>> = OnceLock::new();
    SLOTS.get_or_init(|| Mutex::new(HashMap::new()))
}

/// 给这次请求排一个开始时刻：上一个排到的时刻加间隔，或者现在（取晚的）。
/// 排号在锁里做完就放锁，等待在锁外——并发的请求各自拿到不同的号，依次错开。
fn reserve(slots: &Mutex<HashMap<Platform, Instant>>, platform: Platform, now: Instant) -> Instant {
    let mut slots = slots.lock().unwrap_or_else(|e| e.into_inner());
    let start = slots
        .get(&platform)
        .map_or(now, |last| (*last + platform.interval()).max(now));
    slots.insert(platform, start);
    start
}

/// 等到轮到这个平台的下一个请求再返回。
pub async fn pace(platform: Platform) {
    let start = reserve(next_slots(), platform, Instant::now());
    let wait = start.saturating_duration_since(Instant::now());
    if !wait.is_zero() {
        tokio::time::sleep(wait).await;
    }
}

/// 网址属于需要限速的平台就等一等；其余直接返回。
pub async fn pace_url(url: &str) {
    if let Some(platform) = Platform::of_url(url) {
        pace(platform).await;
    }
}

/// 按命令行参数里的网址限速。yt-dlp 的参数里目标网址在最后，前面可能还有 Referer，
/// 所以从后往前找第一个认得出平台的。
pub async fn pace_args(args: &[String]) {
    if let Some(platform) = args.iter().rev().find_map(|arg| Platform::of_url(arg)) {
        pace(platform).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn platforms_are_recognised_by_host_not_by_substring() {
        assert_eq!(
            Platform::of_url("https://www.bilibili.com/video/BV1x"),
            Some(Platform::Bilibili)
        );
        assert_eq!(
            Platform::of_url("https://b23.tv/abc"),
            Some(Platform::Bilibili)
        );
        assert_eq!(
            Platform::of_url("https://youtu.be/abc"),
            Some(Platform::YouTube)
        );
        assert_eq!(
            Platform::of_url("https://mooc1.chaoxing.com/mycourse"),
            Some(Platform::Chaoxing)
        );
        assert_eq!(Platform::of_url("https://bilibili.com.example/x"), None);
        assert_eq!(Platform::of_url("/Users/me/lecture.mp4"), None);
    }

    #[test]
    fn concurrent_requests_get_staggered_start_times() {
        let slots = Mutex::new(HashMap::new());
        let now = Instant::now();
        let a = reserve(&slots, Platform::Chaoxing, now);
        let b = reserve(&slots, Platform::Chaoxing, now);
        let c = reserve(&slots, Platform::Chaoxing, now);
        let gap = Platform::Chaoxing.interval();
        assert!(b >= a + gap);
        assert!(c >= b + gap);
    }

    #[test]
    fn an_idle_platform_does_not_make_the_next_request_wait() {
        let slots = Mutex::new(HashMap::new());
        let earlier = Instant::now();
        reserve(&slots, Platform::YouTube, earlier);
        let later = earlier + Duration::from_secs(60);
        assert_eq!(reserve(&slots, Platform::YouTube, later), later);
    }
}
