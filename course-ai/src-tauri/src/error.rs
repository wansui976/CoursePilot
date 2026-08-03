use serde::{Serialize, Serializer};

#[derive(Debug, thiserror::Error)]
pub enum AppError {
    #[error("database error: {0}")]
    Database(#[from] sqlx::Error),
    #[error("migration error: {0}")]
    Migrate(#[from] sqlx::migrate::MigrateError),
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
    #[error("json error: {0}")]
    Json(#[from] serde_json::Error),
    #[error("config error: {0}")]
    Config(String),
    #[error("not found: {0}")]
    NotFound(String),
    #[error("pipeline error: {0}")]
    Pipeline(String),
    /// 再试一次也是同一个答复：鉴权失败、额度耗尽、请求本身有问题。
    ///
    /// 单独立一个变体是为了让**重试逻辑**能问出「这值得再等一轮吗」。展示文案与
    /// `Other` 完全一致，前端不必区分。
    #[error("{0}")]
    Permanent(String),
    #[error("{0}")]
    Other(String),
}

impl AppError {
    /// 重试救不了的错误。退避重试是为网络抖动准备的，拿它去撞一个 402
    /// 只是让用户多等几轮，最后拿到同一句话。
    pub fn is_permanent(&self) -> bool {
        matches!(self, AppError::Permanent(_))
    }

    /// 换一段说明文字，保留「值不值得重试」这个判断。
    ///
    /// 包装错误时必须走它：外层随手 `format!` 出一个 `Other`，分类就丢了，
    /// 而上层正是靠这个分类决定还要不要接着跑。
    pub fn rewrap(&self, message: String) -> AppError {
        if self.is_permanent() {
            AppError::Permanent(message)
        } else {
            AppError::Other(message)
        }
    }
}

impl Serialize for AppError {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.to_string())
    }
}

pub type AppResult<T> = Result<T, AppError>;
