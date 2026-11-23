//! 课桌窗外的天气：用 Open-Meteo（免费、不要 API Key）查当前天气，按城市名查坐标。
//!
//! - 只发经纬度（四舍五入到两位小数，约 1 公里）和城市名，不带任何账号信息。
//! - 同一位置 20 分钟内只查一次（进程内缓存），窗外的雨不需要秒级更新。
//! - 位置由用户在设置里搜索城市或用当前位置选定，存在前端本机，不进同步。

use crate::error::{AppError, AppResult};
use serde::{Deserialize, Serialize};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

const FORECAST_URL: &str = "https://api.open-meteo.com/v1/forecast";
const GEOCODE_URL: &str = "https://geocoding-api.open-meteo.com/v1/search";
const CACHE_MS: i64 = 20 * 60 * 1000;

/// 窗外画得出来的几种天气。
#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Condition {
    Clear,
    Cloudy,
    Overcast,
    Fog,
    Drizzle,
    Rain,
    Snow,
    Thunder,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct Weather {
    pub condition: Condition,
    pub is_day: bool,
    pub temperature_c: f64,
    pub fetched_at: i64,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct Place {
    pub name: String,
    /// 省 / 州，国家；用来区分同名城市。
    pub region: String,
    pub latitude: f64,
    pub longitude: f64,
}

/// WMO 天气代码 → 窗外画哪种天。
pub fn condition_of(code: i64) -> Condition {
    match code {
        0 => Condition::Clear,
        1 | 2 => Condition::Cloudy,
        3 => Condition::Overcast,
        45 | 48 => Condition::Fog,
        51..=57 => Condition::Drizzle,
        61..=67 | 80..=82 => Condition::Rain,
        71..=77 | 85 | 86 => Condition::Snow,
        95..=99 => Condition::Thunder,
        _ => Condition::Cloudy,
    }
}

fn round2(v: f64) -> f64 {
    (v * 100.0).round() / 100.0
}

#[derive(Deserialize)]
struct ForecastBody {
    current: CurrentBody,
}

#[derive(Deserialize)]
struct CurrentBody {
    weather_code: i64,
    is_day: i64,
    temperature_2m: f64,
}

pub fn parse_forecast(body: &str, now: i64) -> AppResult<Weather> {
    let parsed: ForecastBody = serde_json::from_str(body)
        .map_err(|error| AppError::Other(format!("天气数据看不懂：{error}")))?;
    Ok(Weather {
        condition: condition_of(parsed.current.weather_code),
        is_day: parsed.current.is_day != 0,
        temperature_c: parsed.current.temperature_2m,
        fetched_at: now,
    })
}

#[derive(Deserialize)]
struct GeocodeBody {
    #[serde(default)]
    results: Vec<GeocodeHit>,
}

#[derive(Deserialize)]
struct GeocodeHit {
    name: String,
    latitude: f64,
    longitude: f64,
    #[serde(default)]
    admin1: Option<String>,
    #[serde(default)]
    country: Option<String>,
}

pub fn parse_geocode(body: &str) -> AppResult<Vec<Place>> {
    let parsed: GeocodeBody = serde_json::from_str(body)
        .map_err(|error| AppError::Other(format!("地点数据看不懂：{error}")))?;
    Ok(parsed
        .results
        .into_iter()
        .map(|hit| Place {
            region: [hit.admin1, hit.country]
                .into_iter()
                .flatten()
                .filter(|part| !part.is_empty() && *part != hit.name)
                .collect::<Vec<_>>()
                .join("，"),
            name: hit.name,
            latitude: round2(hit.latitude),
            longitude: round2(hit.longitude),
        })
        .collect())
}

fn client() -> AppResult<reqwest::Client> {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .user_agent("CoursePilot")
        .build()
        .map_err(|error| AppError::Other(format!("网络客户端：{error}")))
}

fn cache() -> &'static Mutex<Option<((i64, i64), Weather)>> {
    static CACHE: OnceLock<Mutex<Option<((i64, i64), Weather)>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(None))
}

/// 当前天气。坐标先取两位小数，同一处 20 分钟内用缓存。
#[tauri::command]
pub async fn cmd_weather_now(latitude: f64, longitude: f64) -> AppResult<Weather> {
    if !(-90.0..=90.0).contains(&latitude) || !(-180.0..=180.0).contains(&longitude) {
        return Err(AppError::Other("坐标不对".into()));
    }
    let (lat, lon) = (round2(latitude), round2(longitude));
    let key = ((lat * 100.0).round() as i64, (lon * 100.0).round() as i64);
    let now = chrono::Utc::now().timestamp_millis();
    if let Some((cached_key, weather)) = cache().lock().ok().and_then(|guard| guard.clone()) {
        if cached_key == key && now - weather.fetched_at < CACHE_MS {
            return Ok(weather);
        }
    }
    let body = client()?
        .get(FORECAST_URL)
        .query(&[
            ("latitude", lat.to_string()),
            ("longitude", lon.to_string()),
            ("current", "weather_code,is_day,temperature_2m".to_string()),
            ("timezone", "auto".to_string()),
        ])
        .send()
        .await
        .and_then(reqwest::Response::error_for_status)
        .map_err(|error| AppError::Other(format!("查不到天气：{error}")))?
        .text()
        .await
        .map_err(|error| AppError::Other(format!("查不到天气：{error}")))?;
    let weather = parse_forecast(&body, now)?;
    if let Ok(mut guard) = cache().lock() {
        *guard = Some((key, weather.clone()));
    }
    Ok(weather)
}

/// 按城市名找地点（最多 5 个），给设置里的「窗外的天气 · 地点」用。
#[tauri::command]
pub async fn cmd_weather_find_place(
    query: String,
    language: Option<String>,
) -> AppResult<Vec<Place>> {
    let query = query.trim();
    if query.is_empty() {
        return Ok(Vec::new());
    }
    let language = match language.as_deref() {
        Some(lang) if lang.starts_with("zh") => "zh",
        _ => "en",
    };
    let body = client()?
        .get(GEOCODE_URL)
        .query(&[
            ("name", query),
            ("count", "5"),
            ("language", language),
            ("format", "json"),
        ])
        .send()
        .await
        .and_then(reqwest::Response::error_for_status)
        .map_err(|error| AppError::Other(format!("查不到地点：{error}")))?
        .text()
        .await
        .map_err(|error| AppError::Other(format!("查不到地点：{error}")))?;
    parse_geocode(&body)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_wmo_codes_to_what_the_window_can_draw() {
        assert_eq!(condition_of(0), Condition::Clear);
        assert_eq!(condition_of(2), Condition::Cloudy);
        assert_eq!(condition_of(45), Condition::Fog);
        assert_eq!(condition_of(53), Condition::Drizzle);
        assert_eq!(condition_of(63), Condition::Rain);
        assert_eq!(condition_of(81), Condition::Rain);
        assert_eq!(condition_of(73), Condition::Snow);
        assert_eq!(condition_of(95), Condition::Thunder);
    }

    #[test]
    fn parses_the_current_block() {
        let body = r#"{"latitude":31.23,"current":{"time":"2026-11-23T10:00","weather_code":61,"is_day":1,"temperature_2m":12.4}}"#;
        let weather = parse_forecast(body, 7).unwrap();
        assert_eq!(weather.condition, Condition::Rain);
        assert!(weather.is_day);
        assert_eq!(weather.temperature_c, 12.4);
        assert!(parse_forecast("{}", 0).is_err());
    }

    #[test]
    fn geocode_rounds_and_names_the_region() {
        let body = r#"{"results":[{"name":"上海","latitude":31.22222,"longitude":121.45806,"admin1":"上海","country":"中国"},
                                  {"name":"Springfield","latitude":39.8017,"longitude":-89.6437,"admin1":"Illinois","country":"United States"}]}"#;
        let places = parse_geocode(body).unwrap();
        assert_eq!(places[0].region, "中国");
        assert_eq!((places[0].latitude, places[0].longitude), (31.22, 121.46));
        assert_eq!(places[1].region, "Illinois，United States");
        assert!(parse_geocode("{}").unwrap().is_empty());
    }
}
