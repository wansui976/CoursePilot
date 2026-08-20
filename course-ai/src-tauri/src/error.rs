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
    /// 凭据、账号权限或余额导致的永久失败。同一个 Profile 的其他请求也不会成功，
    /// 但路由到别的 Profile 的任务仍应继续。
    #[error("{message}")]
    Account {
        message: String,
        /// 嵌套任务可能单独路由；记录真正发出失败请求的 Profile，避免停错账号。
        profile_id: Option<String>,
    },
    #[error("{0}")]
    Other(String),
}

impl AppError {
    /// 重试救不了的错误。退避重试是为网络抖动准备的，拿它去撞一个 402
    /// 只是让用户多等几轮，最后拿到同一句话。
    pub fn is_permanent(&self) -> bool {
        matches!(self, AppError::Permanent(_) | AppError::Account { .. })
    }

    /// 同一个账号/Profile 的其他请求也必然失败，可用于阻止重复付费或重复报错。
    pub fn is_account_failure(&self) -> bool {
        matches!(self, AppError::Account { .. })
    }

    pub fn account(message: String) -> AppError {
        AppError::Account {
            message,
            profile_id: None,
        }
    }

    /// 给账号错误补上实际执行请求的 Profile。已有归属优先，外层不能覆盖内层路由。
    pub fn with_account_profile(self, profile_id: Option<&str>) -> AppError {
        match self {
            AppError::Account {
                message,
                profile_id: existing,
            } => AppError::Account {
                message,
                profile_id: existing.or_else(|| profile_id.map(str::to_owned)),
            },
            other => other,
        }
    }

    pub fn account_profile_id(&self) -> Option<&str> {
        match self {
            AppError::Account { profile_id, .. } => profile_id.as_deref(),
            _ => None,
        }
    }

    /// 换一段说明文字，保留「值不值得重试」这个判断。
    ///
    /// 包装错误时必须走它：外层随手 `format!` 出一个 `Other`，分类就丢了，
    /// 而上层正是靠这个分类决定还要不要接着跑。
    pub fn rewrap(&self, message: String) -> AppError {
        match self {
            AppError::Account { profile_id, .. } => AppError::Account {
                message,
                profile_id: profile_id.clone(),
            },
            AppError::Permanent(_) => AppError::Permanent(message),
            _ => AppError::Other(message),
        }
    }
}

impl Serialize for AppError {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.to_string())
    }
}

pub type AppResult<T> = Result<T, AppError>;
