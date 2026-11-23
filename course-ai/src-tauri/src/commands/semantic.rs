//! 设置 → 语义检索：选向量来源（关 / 本地模型 / 云端接口）、下载删除本地模型、看索引进度。

use crate::commands::courses::AppState;
use crate::commands::settings::{get_setting, set_setting};
use crate::commands::whisper::{
    app_data, download_client, download_files, DownloadEvent, DOWNLOAD_STALL_TIMEOUT,
};
use crate::error::{AppError, AppResult};
use crate::pipeline::model_store;
use crate::pipeline::semantic::{self, IndexProgress, Purpose};
use serde::Serialize;
use tauri::{Emitter, State};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalModelInfo {
    pub id: String,
    pub name: String,
    pub description: String,
    pub size: u64,
    pub installed: bool,
    /// 已经下到本机的大小（含下了一半的）。
    pub size_on_disk: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SemanticStatus {
    /// off / local / cloud（设置里存的值，不代表一定能用）。
    pub backend: String,
    pub local_supported: bool,
    pub local_model: Option<String>,
    pub cloud_profile: Option<String>,
    pub cloud_model: Option<String>,
    pub models: Vec<LocalModelInfo>,
    /// 设置齐全、真能算向量时为 true。
    pub active: bool,
    pub indexed: i64,
    pub total: i64,
    pub progress: IndexProgress,
}

#[tauri::command]
pub async fn cmd_semantic_status(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> AppResult<SemanticStatus> {
    let db = &state.db;
    let root = model_store::models_root(db, &app_data(&app)?).await?;
    let models = semantic::LOCAL_MODELS
        .iter()
        .map(|model| LocalModelInfo {
            id: model.id.into(),
            name: model.display_name.into(),
            description: model.description.into(),
            size: model.file.size,
            installed: semantic::is_installed(&root, model),
            size_on_disk: model_store::dir_size(&root.join("embed").join(model.dir)),
        })
        .collect();
    let (indexed, total) = semantic::index_counts(db).await?;
    Ok(SemanticStatus {
        backend: get_setting(db, semantic::SETTING_BACKEND)
            .await?
            .unwrap_or_else(|| "off".into()),
        local_supported: semantic::LOCAL_SUPPORTED,
        local_model: get_setting(db, semantic::SETTING_LOCAL_MODEL).await?,
        cloud_profile: get_setting(db, semantic::SETTING_CLOUD_PROFILE).await?,
        cloud_model: get_setting(db, semantic::SETTING_CLOUD_MODEL).await?,
        models,
        active: semantic::current_embedder(db).await?.is_some(),
        indexed,
        total,
        progress: semantic::progress(),
    })
}

/// 保存向量来源。来源变了就作废正在建的索引，按新来源把还没建的排进去。
#[tauri::command]
pub async fn cmd_semantic_save(
    state: State<'_, AppState>,
    backend: String,
    local_model: Option<String>,
    cloud_profile: Option<String>,
    cloud_model: Option<String>,
) -> AppResult<()> {
    let db = &state.db;
    if !matches!(backend.as_str(), "off" | "local" | "cloud") {
        return Err(AppError::Config(format!("未知的语义检索来源：{backend}")));
    }
    if backend == "local" && !semantic::LOCAL_SUPPORTED {
        return Err(AppError::Config(
            "这台设备不能跑本地嵌入模型，请改用云端接口".into(),
        ));
    }
    if let Some(id) = local_model.as_deref().filter(|id| !id.is_empty()) {
        if semantic::local_model(id).is_none() {
            return Err(AppError::Config(format!("未知的本地嵌入模型：{id}")));
        }
    }
    let before = semantic::current_embedder(db)
        .await?
        .map(|embedder| embedder.id());
    set_setting(db, semantic::SETTING_BACKEND, &backend).await?;
    set_setting(
        db,
        semantic::SETTING_LOCAL_MODEL,
        local_model.as_deref().unwrap_or(""),
    )
    .await?;
    set_setting(
        db,
        semantic::SETTING_CLOUD_PROFILE,
        cloud_profile.as_deref().unwrap_or("").trim(),
    )
    .await?;
    set_setting(
        db,
        semantic::SETTING_CLOUD_MODEL,
        cloud_model.as_deref().unwrap_or("").trim(),
    )
    .await?;
    let after = semantic::current_embedder(db)
        .await?
        .map(|embedder| embedder.id());
    if before != after {
        semantic::restart();
    }
    Ok(())
}

pub const DOWNLOAD_EVENT: &str = "semantic-model:download";

#[tauri::command]
pub async fn cmd_semantic_download_model(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    id: String,
) -> AppResult<()> {
    if !semantic::LOCAL_SUPPORTED {
        return Err(AppError::Config("这台设备不能跑本地嵌入模型".into()));
    }
    let model = semantic::local_model(&id)
        .ok_or_else(|| AppError::Config(format!("未知的本地嵌入模型：{id}")))?;
    let root = model_store::models_root(&state.db, &app_data(&app)?).await?;
    let missing = semantic::missing_files(&root, model);
    let total: u64 = missing.iter().map(|(_, file)| file.size).sum();
    let _keep_alive = crate::keep_alive::hold(
        crate::keep_alive::Kind::ModelDownload,
        model.id,
        model.display_name,
    );
    let emit = |received: u64, done: bool, error: Option<String>| {
        app.emit(
            DOWNLOAD_EVENT,
            DownloadEvent {
                id: model.id.into(),
                received,
                total,
                done,
                error,
            },
        )
        .ok();
    };
    let client = download_client(DOWNLOAD_STALL_TIMEOUT)?;
    if let Err(error) = download_files(&client, model.display_name, missing, |received| {
        emit(received, false, None)
    })
    .await
    {
        emit(0, true, Some(error.to_string()));
        return Err(error);
    }
    emit(total, true, None);
    // 正选着这个模型的话，装好了就开始建索引。
    semantic::restart();
    Ok(())
}

#[tauri::command]
pub async fn cmd_semantic_delete_model(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    id: String,
) -> AppResult<()> {
    let model = semantic::local_model(&id)
        .ok_or_else(|| AppError::Config(format!("未知的本地嵌入模型：{id}")))?;
    semantic::stop_local_server().await;
    let root = model_store::models_root(&state.db, &app_data(&app)?).await?;
    let dir = root.join("embed").join(model.dir);
    if dir.exists() {
        tokio::fs::remove_dir_all(&dir).await?;
    }
    // 向量留着：重新下回同一个模型时不用再算一遍。
    semantic::restart();
    Ok(())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SemanticTest {
    pub dimensions: usize,
    pub millis: u64,
}

/// 用当前设置算一句话的向量，确认接口通、模型名对。
#[tauri::command]
pub async fn cmd_semantic_test(state: State<'_, AppState>) -> AppResult<SemanticTest> {
    let embedder = semantic::current_embedder(&state.db)
        .await?
        .ok_or_else(|| AppError::Config("语义检索还没设置好".into()))?;
    let started = std::time::Instant::now();
    let vectors = semantic::embed(
        &state.db,
        &embedder,
        &["梯度下降的学习率".to_string()],
        Purpose::Query,
    )
    .await?;
    Ok(SemanticTest {
        dimensions: vectors.first().map(Vec::len).unwrap_or(0),
        millis: started.elapsed().as_millis() as u64,
    })
}

/// 上一轮出错停下后，接着把没建的建完。
#[tauri::command]
pub async fn cmd_semantic_resume() -> AppResult<()> {
    semantic::resume();
    Ok(())
}

/// 删掉当前来源的全部索引，从头重建。
#[tauri::command]
pub async fn cmd_semantic_rebuild(state: State<'_, AppState>) -> AppResult<()> {
    semantic::rebuild(&state.db).await
}
