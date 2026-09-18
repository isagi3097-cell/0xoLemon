//! Lua-only durable work. Deliberately independent of Store/local download orchestration.
use chrono::Utc;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, HashSet},
    fs,
    io::{Read, Write},
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, AtomicU8, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};
use tauri::{AppHandle, Emitter, Manager};
use uuid::Uuid;

const MAX_TASKS: usize = 500;
const MAX_QUEUE_BYTES: usize = 4 * 1024 * 1024;
static QUEUE: Mutex<Option<Queue>> = Mutex::new(None);
static STARTED: AtomicBool = AtomicBool::new(false);

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub enum LuaTaskAction {
    MetadataRefresh {
        appid: u32,
    },
    LuaInstall {
        appid: u32,
        #[serde(rename = "gameName")]
        game_name: String,
        provider: crate::lua_sources::LuaSourceProvider,
        #[serde(default = "live_channel")]
        channel: crate::lua_live::LuaGameChannel,
        #[serde(default, rename = "buildId")]
        build_id: Option<String>,
        #[serde(default, rename = "statSteamId")]
        stat_steam_id: Option<String>,
        #[serde(default)]
        timezone: Option<String>,
        #[serde(default, rename = "conflictResolution")]
        conflict_resolution: Option<crate::lua_live::LuaConflictResolution>,
    },
    LuaUpdate {
        appid: u32,
        provider: crate::lua_sources::LuaSourceProvider,
        #[serde(default)]
        mode: LuaUpdateMode,
        #[serde(default, rename = "statSteamId")]
        stat_steam_id: Option<String>,
        #[serde(default)]
        timezone: Option<String>,
        #[serde(default, rename = "conflictResolution")]
        conflict_resolution: Option<crate::lua_live::LuaConflictResolution>,
    },
    LuaSwitchChannel {
        appid: u32,
        channel: crate::lua_live::LuaGameChannel,
        #[serde(default, rename = "buildId")]
        build_id: Option<String>,
        #[serde(default)]
        provider: Option<crate::lua_sources::LuaSourceProvider>,
        #[serde(default, rename = "conflictResolution")]
        conflict_resolution: Option<crate::lua_live::LuaConflictResolution>,
    },
    WorkshopDownload {
        appid: u32,
        #[serde(rename = "publishedFileId")]
        published_file_id: String,
        #[serde(default, rename = "accountApproval")]
        account_approval: Option<crate::lua_workshop::WorkshopAccountApproval>,
    },
}
impl LuaTaskAction {
    fn is_lua_write(&self) -> bool {
        matches!(
            self,
            Self::LuaInstall { .. } | Self::LuaUpdate { .. } | Self::LuaSwitchChannel { .. }
        )
    }
    fn appid(&self) -> u32 {
        match self {
            Self::MetadataRefresh { appid }
            | Self::LuaInstall { appid, .. }
            | Self::LuaUpdate { appid, .. }
            | Self::LuaSwitchChannel { appid, .. }
            | Self::WorkshopDownload { appid, .. } => *appid,
        }
    }
    fn validate(&self) -> Result<(), String> {
        if self.appid() == 0 {
            return Err("LUA_TASK_INVALID_APPID".into());
        }
        let (build, steam_id) = match self {
            Self::LuaInstall {
                build_id,
                stat_steam_id,
                ..
            } => (build_id.as_deref(), stat_steam_id.as_deref()),
            Self::LuaUpdate { stat_steam_id, .. } => (None, stat_steam_id.as_deref()),
            Self::LuaSwitchChannel { build_id, .. } => (build_id.as_deref(), None),
            _ => (None, None),
        };
        for value in [build, steam_id].into_iter().flatten() {
            if value.is_empty() || value.len() > 20 || !value.bytes().all(|b| b.is_ascii_digit()) {
                return Err("LUA_TASK_INVALID_NUMERIC_OPTION".into());
            }
        }
        if let Self::LuaInstall {
            timezone: Some(timezone),
            ..
        }
        | Self::LuaUpdate {
            timezone: Some(timezone),
            ..
        } = self
        {
            if timezone.is_empty() || timezone.len() > 96 || timezone.chars().any(char::is_control)
            {
                return Err("LUA_TASK_INVALID_TIMEZONE".into());
            }
        }
        match self {
            Self::LuaInstall { game_name, .. }
                if game_name.trim().is_empty()
                    || game_name.len() > 256
                    || game_name.chars().any(char::is_control) =>
            {
                Err("LUA_TASK_INVALID_NAME".into())
            }
            Self::WorkshopDownload {
                published_file_id,
                account_approval,
                ..
            } => {
                if let Some(approval) = account_approval {
                    approval.validate()?;
                }
                crate::lua_workshop::validate_item_id(published_file_id).map(|_| ())
            }
            _ => Ok(()),
        }
    }
}
fn live_channel() -> crate::lua_live::LuaGameChannel {
    crate::lua_live::LuaGameChannel::Live
}
#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum LuaUpdateMode {
    Sync,
    #[default]
    Update,
}
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum LuaTaskStatus {
    Queued,
    Running,
    Pausing,
    Cancelling,
    Paused,
    Cancelled,
    Failed,
    Completed,
}
impl LuaTaskStatus {
    fn reserves_game(&self) -> bool {
        matches!(
            self,
            Self::Queued | Self::Running | Self::Pausing | Self::Cancelling | Self::Paused
        )
    }
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LuaTask {
    pub task_id: String,
    pub action: LuaTaskAction,
    pub status: LuaTaskStatus,
    pub created_at: String,
    pub updated_at: String,
    pub attempt: u32,
    pub progress: Option<f64>,
    pub error_code: Option<String>,
    pub receipt: Option<serde_json::Value>,
}
#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum LuaTaskOperation {
    Pause,
    Resume,
    Cancel,
    Retry,
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LuaTaskArchiveResult {
    pub archive_id: String,
    pub archived_task_ids: Vec<String>,
    pub archived_count: usize,
    pub sha256: String,
    pub archive_path: String,
    pub remaining_tasks: Vec<LuaTask>,
}
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TaskArchive {
    schema_version: u32,
    archive_id: String,
    archived_at: String,
    tasks: Vec<LuaTask>,
}
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct QueueFile {
    schema_version: u32,
    tasks: Vec<LuaTask>,
}
struct Queue {
    path: PathBuf,
    data: QueueFile,
    active: HashMap<String, Arc<AtomicU8>>,
}

impl Queue {
    fn open(path: PathBuf) -> Result<Self, String> {
        crate::lua_workshop::reject_reparse_ancestors(&path)?;
        let mut data = if path.exists() {
            if fs::metadata(&path)
                .map_err(|_| "LUA_QUEUE_READ_FAILED")?
                .len()
                > MAX_QUEUE_BYTES as u64
            {
                return Err("LUA_QUEUE_TOO_LARGE".into());
            }
            let parsed: QueueFile =
                serde_json::from_slice(&fs::read(&path).map_err(|_| "LUA_QUEUE_READ_FAILED")?)
                    .map_err(|_| "LUA_QUEUE_CORRUPT")?;
            if parsed.schema_version != 1 || parsed.tasks.len() > MAX_TASKS {
                return Err("LUA_QUEUE_SCHEMA_INVALID".into());
            }
            let mut ids = std::collections::HashSet::new();
            for task in &parsed.tasks {
                task.action.validate()?;
                if Uuid::parse_str(&task.task_id).is_err() || !ids.insert(&task.task_id) {
                    return Err("LUA_QUEUE_INVALID_TASK".into());
                }
            }
            parsed
        } else {
            QueueFile {
                schema_version: 1,
                tasks: vec![],
            }
        };
        for task in &mut data.tasks {
            if matches!(
                task.status,
                LuaTaskStatus::Running | LuaTaskStatus::Pausing | LuaTaskStatus::Cancelling
            ) {
                task.status = LuaTaskStatus::Paused;
                task.error_code = Some("LUA_TASK_INTERRUPTED_REVIEW_BEFORE_RETRY".into());
                task.updated_at = now();
            }
        }
        // Older queue versions admitted conflicting writes. Retain every request,
        // but require the user to cancel duplicates before any can run again.
        let mut reserved = HashMap::<u32, usize>::new();
        for task in &data.tasks {
            if task.action.is_lua_write() && task.status.reserves_game() {
                *reserved.entry(task.action.appid()).or_default() += 1;
            }
        }
        for task in &mut data.tasks {
            if task.action.is_lua_write()
                && task.status.reserves_game()
                && reserved.get(&task.action.appid()).copied().unwrap_or(0) > 1
            {
                task.status = LuaTaskStatus::Paused;
                task.error_code = Some("LUA_TASK_GAME_ALREADY_QUEUED".into());
                task.updated_at = now();
            }
        }
        let queue = Self {
            path,
            data,
            active: HashMap::new(),
        };
        if queue.path.exists() {
            queue.save(&queue.data)?;
        }
        Ok(queue)
    }
    fn save(&self, data: &QueueFile) -> Result<(), String> {
        crate::lua_workshop::reject_reparse_ancestors(&self.path)?;
        let bytes = serde_json::to_vec_pretty(data).map_err(|_| "LUA_QUEUE_ENCODE_FAILED")?;
        if bytes.len() > MAX_QUEUE_BYTES {
            return Err("LUA_QUEUE_TOO_LARGE".into());
        }
        crate::lua_live::atomic_write_path(&self.path, &bytes)
            .map_err(|_| "LUA_QUEUE_PERSIST_FAILED".into())
    }
    fn commit(&mut self, next: QueueFile) -> Result<(), String> {
        self.save(&next)?;
        self.data = next;
        Ok(())
    }
    fn ensure_game_available(
        &self,
        action: &LuaTaskAction,
        excluding_id: Option<&str>,
    ) -> Result<(), String> {
        if action.is_lua_write()
            && self.data.tasks.iter().any(|task| {
                Some(task.task_id.as_str()) != excluding_id
                    && task.action.is_lua_write()
                    && task.status.reserves_game()
                    && task.action.appid() == action.appid()
            })
        {
            return Err("LUA_TASK_GAME_ALREADY_QUEUED".into());
        }
        Ok(())
    }
    fn enqueue(&mut self, action: LuaTaskAction) -> Result<LuaTask, String> {
        action.validate()?;
        self.ensure_game_available(&action, None)?;
        if self.data.tasks.len() >= MAX_TASKS {
            return Err("LUA_QUEUE_FULL".into());
        }
        let task = LuaTask {
            task_id: Uuid::new_v4().to_string(),
            action,
            status: LuaTaskStatus::Queued,
            created_at: now(),
            updated_at: now(),
            attempt: 0,
            progress: None,
            error_code: None,
            receipt: None,
        };
        let mut next = self.data.clone();
        next.tasks.push(task.clone());
        self.commit(next)?;
        Ok(task)
    }
    fn control(&mut self, id: &str, operation: LuaTaskOperation) -> Result<LuaTask, String> {
        let mut next = self.data.clone();
        let task = next
            .tasks
            .iter_mut()
            .find(|t| t.task_id == id)
            .ok_or("LUA_TASK_NOT_FOUND")?;
        let running = matches!(
            task.status,
            LuaTaskStatus::Running | LuaTaskStatus::Pausing | LuaTaskStatus::Cancelling
        );
        if running && !matches!(task.action, LuaTaskAction::WorkshopDownload { .. }) {
            return Err("LUA_TASK_BUSY_ATOMIC_OPERATION".into());
        }
        task.status = match (task.status, operation) {
            (LuaTaskStatus::Queued, LuaTaskOperation::Pause) => LuaTaskStatus::Paused,
            (LuaTaskStatus::Running, LuaTaskOperation::Pause) => LuaTaskStatus::Pausing,
            (
                LuaTaskStatus::Queued | LuaTaskStatus::Paused | LuaTaskStatus::Failed,
                LuaTaskOperation::Cancel,
            ) => LuaTaskStatus::Cancelled,
            (LuaTaskStatus::Running | LuaTaskStatus::Pausing, LuaTaskOperation::Cancel) => {
                LuaTaskStatus::Cancelling
            }
            (LuaTaskStatus::Paused, LuaTaskOperation::Resume)
            | (LuaTaskStatus::Failed, LuaTaskOperation::Retry) => LuaTaskStatus::Queued,
            _ => return Err("LUA_TASK_TRANSITION_INVALID".into()),
        };
        if task.status == LuaTaskStatus::Queued {
            self.ensure_game_available(&task.action, Some(id))?;
            task.error_code = None;
        }
        task.updated_at = now();
        let result = task.clone();
        self.commit(next)?;
        if let Some(flag) = self.active.get(id) {
            flag.store(
                if result.status == LuaTaskStatus::Cancelling {
                    2
                } else {
                    1
                },
                Ordering::SeqCst,
            );
        }
        Ok(result)
    }
    fn archive_finished(&mut self, task_ids: Vec<String>) -> Result<LuaTaskArchiveResult, String> {
        let requested: HashSet<_> = task_ids.iter().collect();
        if task_ids.is_empty()
            || task_ids.len() > MAX_TASKS
            || requested.len() != task_ids.len()
            || task_ids.iter().any(|id| Uuid::parse_str(id).is_err())
        {
            return Err("LUA_ARCHIVE_EXACT_TASK_IDS_REQUIRED".into());
        }
        let tasks: Vec<_> = self
            .data
            .tasks
            .iter()
            .filter(|task| requested.contains(&task.task_id))
            .cloned()
            .collect();
        if tasks.len() != requested.len() {
            return Err("LUA_TASK_NOT_FOUND".into());
        }
        if tasks.iter().any(|task| {
            !matches!(
                task.status,
                LuaTaskStatus::Completed | LuaTaskStatus::Cancelled | LuaTaskStatus::Failed
            ) || self.active.contains_key(&task.task_id)
        }) {
            return Err("LUA_ARCHIVE_REQUIRES_FINISHED_TASKS".into());
        }
        let archive_id = Uuid::new_v4().to_string();
        let archived_task_ids = tasks.iter().map(|task| task.task_id.clone()).collect();
        let payload = TaskArchive {
            schema_version: 1,
            archive_id: archive_id.clone(),
            archived_at: now(),
            tasks,
        };
        let bytes = serde_json::to_vec_pretty(&payload).map_err(|_| "LUA_ARCHIVE_ENCODE_FAILED")?;
        // The archive adds a small audit header to the queue's existing bounded payload.
        if bytes.len() > MAX_QUEUE_BYTES + 1024 {
            return Err("LUA_ARCHIVE_TOO_LARGE".into());
        }
        let directory = self
            .path
            .parent()
            .ok_or("LUA_ARCHIVE_PATH_UNAVAILABLE")?
            .join("task-archive");
        crate::lua_workshop::reject_reparse_ancestors(&directory)?;
        fs::create_dir_all(&directory).map_err(|_| "LUA_ARCHIVE_CREATE_FAILED")?;
        let archive_path = directory.join(format!("{archive_id}.json"));
        crate::lua_workshop::reject_reparse_ancestors(&archive_path)?;
        {
            let mut file = fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&archive_path)
                .map_err(|_| "LUA_ARCHIVE_CREATE_FAILED")?;
            file.write_all(&bytes)
                .and_then(|_| file.sync_all())
                .map_err(|_| "LUA_ARCHIVE_WRITE_FAILED")?;
        }
        crate::lua_workshop::reject_reparse_ancestors(&archive_path)?;
        let mut verified = Vec::with_capacity(bytes.len());
        fs::File::open(&archive_path)
            .map_err(|_| "LUA_ARCHIVE_VERIFY_FAILED")?
            .take((bytes.len() + 1) as u64)
            .read_to_end(&mut verified)
            .map_err(|_| "LUA_ARCHIVE_VERIFY_FAILED")?;
        if verified != bytes {
            return Err("LUA_ARCHIVE_VERIFY_FAILED".into());
        }
        let sha256 = format!("{:x}", Sha256::digest(&verified));
        let mut next = self.data.clone();
        next.tasks.retain(|task| !requested.contains(&task.task_id));
        // Audit first, journal second. On any failure the queue is untouched and
        // the exact-owned archive is retained; retries never overwrite an audit.
        self.commit(next)?;
        Ok(LuaTaskArchiveResult {
            archive_id,
            archived_task_ids,
            archived_count: payload.tasks.len(),
            sha256,
            archive_path: archive_path.to_string_lossy().into_owned(),
            remaining_tasks: self.data.tasks.clone(),
        })
    }
}
fn now() -> String {
    Utc::now().to_rfc3339()
}
fn with_queue<T>(
    app: &AppHandle,
    f: impl FnOnce(&mut Queue) -> Result<T, String>,
) -> Result<T, String> {
    let mut guard = QUEUE.lock().map_err(|_| "LUA_QUEUE_UNAVAILABLE")?;
    if guard.is_none() {
        *guard = Some(Queue::open(
            app.path()
                .app_data_dir()
                .map_err(|_| "LUA_QUEUE_PATH_UNAVAILABLE")?
                .join("lua-experience/task-queue.json"),
        )?);
    }
    f(guard.as_mut().unwrap())
}
fn emit(app: &AppHandle) {
    if let Ok(tasks) = with_queue(app, |q| Ok(q.data.tasks.clone())) {
        let _ = app.emit("lua-tasks-changed", tasks);
    }
}
pub(crate) fn report_workshop_progress(
    app: &AppHandle,
    task_id: &str,
    progress: f64,
) -> Result<(), String> {
    if !progress.is_finite() || !(0.0..1.0).contains(&progress) {
        return Err("LUA_TASK_PROGRESS_INVALID".into());
    }
    with_queue(app, |q| {
        let mut next = q.data.clone();
        let task = next
            .tasks
            .iter_mut()
            .find(|t| t.task_id == task_id)
            .ok_or("LUA_TASK_NOT_FOUND")?;
        if task.status != LuaTaskStatus::Running {
            return Err("LUA_WORKSHOP_INTERRUPTED".into());
        }
        task.progress = Some(progress);
        task.updated_at = now();
        q.commit(next)
    })?;
    emit(app);
    Ok(())
}

#[tauri::command]
pub fn lua_list_tasks(app: AppHandle) -> Result<Vec<LuaTask>, String> {
    with_queue(&app, |q| Ok(q.data.tasks.clone()))
}
#[tauri::command]
pub async fn lua_archive_finished_tasks(
    app: AppHandle,
    task_ids: Vec<String>,
) -> Result<LuaTaskArchiveResult, String> {
    let worker_app = app.clone();
    let archived = tauri::async_runtime::spawn_blocking(move || {
        with_queue(&worker_app, |q| q.archive_finished(task_ids))
    })
    .await
    .map_err(|_| "LUA_ARCHIVE_WORKER_FAILED")??;
    emit(&app);
    Ok(archived)
}
#[tauri::command]
pub fn lua_enqueue_task(app: AppHandle, action: LuaTaskAction) -> Result<LuaTask, String> {
    let task = with_queue(&app, |q| q.enqueue(action))?;
    start_lua_task_worker(app.clone())?;
    emit(&app);
    Ok(task)
}
#[tauri::command]
pub fn lua_control_task(
    app: AppHandle,
    task_id: String,
    operation: LuaTaskOperation,
) -> Result<LuaTask, String> {
    let task = with_queue(&app, |q| q.control(&task_id, operation))?;
    start_lua_task_worker(app.clone())?;
    emit(&app);
    Ok(task)
}
#[tauri::command]
pub fn lua_reorder_tasks(app: AppHandle, task_ids: Vec<String>) -> Result<Vec<LuaTask>, String> {
    let result = with_queue(&app, |q| {
        let queued: Vec<_> = q
            .data
            .tasks
            .iter()
            .filter(|t| t.status == LuaTaskStatus::Queued)
            .map(|t| t.task_id.clone())
            .collect();
        let provided: std::collections::HashSet<_> = task_ids.iter().collect();
        if task_ids.len() != queued.len()
            || provided.len() != task_ids.len()
            || queued.iter().any(|id| !provided.contains(id))
        {
            return Err("LUA_QUEUE_REORDER_REQUIRES_ALL_QUEUED_IDS".into());
        }
        let mut next = q.data.clone();
        let mut ordered = task_ids.iter();
        for slot in &mut next.tasks {
            if slot.status == LuaTaskStatus::Queued {
                let id = ordered.next().unwrap();
                *slot = q
                    .data
                    .tasks
                    .iter()
                    .find(|t| &t.task_id == id)
                    .unwrap()
                    .clone();
            }
        }
        q.commit(next)?;
        Ok(q.data.tasks.clone())
    })?;
    emit(&app);
    Ok(result)
}

pub fn start_lua_task_worker(app: AppHandle) -> Result<(), String> {
    with_queue(&app, |q| {
        if !STARTED.load(Ordering::SeqCst) && !q.active.is_empty() {
            return Err("LUA_QUEUE_RECOVERY_RESTART_REQUIRED".into());
        }
        Ok(())
    })?;
    if STARTED.swap(true, Ordering::SeqCst) {
        return Ok(());
    }
    tauri::async_runtime::spawn(async move {
        loop {
            let claimed = with_queue(&app, |q| {
                let mut next = q.data.clone();
                let Some(task) = next
                    .tasks
                    .iter_mut()
                    .find(|t| t.status == LuaTaskStatus::Queued)
                else {
                    return Ok(None);
                };
                task.status = LuaTaskStatus::Running;
                task.attempt = task.attempt.saturating_add(1);
                task.updated_at = now();
                task.progress = None;
                let task = task.clone();
                q.commit(next)?;
                let flag = Arc::new(AtomicU8::new(0));
                q.active.insert(task.task_id.clone(), flag.clone());
                Ok(Some((task, flag)))
            });
            if let Ok(Some((task, flag))) = claimed {
                emit(&app);
                let result = execute(&app, &task, flag).await;
                let persisted = with_queue(&app, |q| {
                    let mut next = q.data.clone();
                    let target = next
                        .tasks
                        .iter_mut()
                        .find(|t| t.task_id == task.task_id)
                        .ok_or("LUA_TASK_NOT_FOUND")?;
                    match result {
                        Ok(receipt) => {
                            target.status = LuaTaskStatus::Completed;
                            target.receipt = Some(receipt);
                            target.progress = Some(1.0);
                            target.error_code = None;
                        }
                        Err(error) => {
                            target.status = match target.status {
                                LuaTaskStatus::Pausing => LuaTaskStatus::Paused,
                                LuaTaskStatus::Cancelling => LuaTaskStatus::Cancelled,
                                _ => LuaTaskStatus::Failed,
                            };
                            target.error_code = Some(safe_error(&error));
                        }
                    }
                    target.updated_at = now();
                    q.commit(next)?;
                    q.active.remove(&task.task_id);
                    Ok(())
                });
                emit(&app);
                // A lost terminal journal write must not permit subsequent mutations.
                if persisted.is_err() {
                    STARTED.store(false, Ordering::SeqCst);
                    break;
                }
            }
            tokio::time::sleep(Duration::from_millis(500)).await;
        }
    });
    Ok(())
}
fn safe_error(error: &str) -> String {
    if error.len() <= 160
        && error
            .bytes()
            .all(|b| b.is_ascii_uppercase() || b.is_ascii_digit() || b == b'_')
    {
        error.to_string()
    } else {
        "LUA_TASK_OPERATION_FAILED".into()
    }
}
async fn execute(
    app: &AppHandle,
    task: &LuaTask,
    stop: Arc<AtomicU8>,
) -> Result<serde_json::Value, String> {
    match &task.action {
        LuaTaskAction::MetadataRefresh { appid } => {
            let result = crate::lua_experience::lua_get_metadata(
                app.clone(),
                *appid,
                "english".into(),
                true,
            )
            .await?;
            let data = serde_json::to_value(result).map_err(|_| "LUA_METADATA_ENCODE_FAILED")?;
            if data.get("data").is_none_or(serde_json::Value::is_null) {
                return Err("LUA_METADATA_UNAVAILABLE".into());
            }
            if data.get("freshness").and_then(serde_json::Value::as_str) != Some("fresh") {
                return Err("LUA_METADATA_REFRESH_INCOMPLETE_STALE_DATA".into());
            }
            Ok(
                serde_json::json!({"kind":"metadataRefresh", "appid":appid, "completedAt":now(), "freshness":data.get("freshness"), "partial":data.get("errorCodes").and_then(serde_json::Value::as_array).is_some_and(|errors| !errors.is_empty()), "errorCodes":data.get("errorCodes")}),
            )
        }
        LuaTaskAction::LuaInstall {
            appid,
            game_name,
            provider,
            channel,
            build_id,
            stat_steam_id,
            timezone,
            conflict_resolution,
        } => {
            let state = crate::lua_live::install_lua_game_from_source(
                app.clone(),
                crate::lua_live::InstallLuaGameRequest {
                    appid: *appid,
                    game_name: game_name.clone(),
                    channel: *channel,
                    build_id: build_id.clone(),
                    access_token: None,
                    stat_steam_id: stat_steam_id.clone(),
                    conflict_resolution: *conflict_resolution,
                    provider: Some(*provider),
                    request_id: Some(task.task_id.clone()),
                    timezone: timezone.clone(),
                },
            )
            .await?;
            Ok(
                serde_json::json!({"kind":"luaInstall", "appid":appid, "completedAt":now(), "gameState":state}),
            )
        }
        LuaTaskAction::LuaUpdate {
            appid,
            provider,
            mode,
            stat_steam_id,
            timezone,
            conflict_resolution,
        } => {
            let request = crate::lua_live::LuaSourceActionRequest {
                appid: *appid,
                provider: *provider,
                request_id: Some(task.task_id.clone()),
                timezone: timezone.clone(),
                conflict_resolution: *conflict_resolution,
                stat_steam_id: stat_steam_id.clone(),
            };
            let state = match mode {
                LuaUpdateMode::Sync => {
                    crate::lua_live::sync_lua_game_from_source(app.clone(), request).await?
                }
                LuaUpdateMode::Update => {
                    crate::lua_live::apply_lua_game_update(app.clone(), request).await?
                }
            };
            Ok(
                serde_json::json!({"kind":"luaUpdate", "appid":appid, "completedAt":now(), "gameState":state}),
            )
        }
        LuaTaskAction::LuaSwitchChannel {
            appid,
            channel,
            build_id,
            provider,
            conflict_resolution,
        } => {
            let state = crate::lua_live::set_lua_game_channel(
                app.clone(),
                crate::lua_live::SetLuaGameChannelRequest {
                    appid: *appid,
                    channel: *channel,
                    build_id: build_id.clone(),
                    provider: *provider,
                    conflict_resolution: *conflict_resolution,
                    restart_steam_if_needed: false,
                },
            )
            .await?;
            Ok(
                serde_json::json!({"kind":"luaSwitchChannel", "appid":appid, "completedAt":now(), "gameState":state}),
            )
        }
        LuaTaskAction::WorkshopDownload {
            appid,
            published_file_id,
            account_approval,
        } => crate::lua_workshop::execute_download(
            app.clone(),
            *appid,
            published_file_id.clone(),
            task.task_id.clone(),
            stop,
            account_approval.clone(),
        )
        .await
        .and_then(|r| serde_json::to_value(r).map_err(|_| "LUA_WORKSHOP_RECEIPT_INVALID".into())),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn path() -> PathBuf {
        std::env::temp_dir().join(format!("lua-queue-test-{}.json", Uuid::new_v4()))
    }
    fn write_action(kind: &str, appid: u32) -> LuaTaskAction {
        let value = match kind {
            "luaInstall" => serde_json::json!({
                "kind":kind,"appid":appid,"gameName":"Fixture","provider":"hubcap"
            }),
            "luaUpdate" => serde_json::json!({
                "kind":kind,"appid":appid,"provider":"hubcap"
            }),
            "luaSwitchChannel" => serde_json::json!({
                "kind":kind,"appid":appid,"channel":"live"
            }),
            _ => panic!("unknown fixture action"),
        };
        serde_json::from_value(value).unwrap()
    }
    #[test]
    fn persists_transitions_and_pauses_interrupted_work() {
        let path = path();
        let mut queue = Queue::open(path.clone()).unwrap();
        let task = queue
            .enqueue(LuaTaskAction::MetadataRefresh { appid: 480 })
            .unwrap();
        queue
            .control(&task.task_id, LuaTaskOperation::Pause)
            .unwrap();
        assert_eq!(
            Queue::open(path.clone()).unwrap().data.tasks[0].status,
            LuaTaskStatus::Paused
        );
        queue
            .control(&task.task_id, LuaTaskOperation::Resume)
            .unwrap();
        let mut next = queue.data.clone();
        next.tasks[0].status = LuaTaskStatus::Running;
        queue.commit(next).unwrap();
        let recovered = Queue::open(path.clone()).unwrap();
        assert_eq!(recovered.data.tasks[0].status, LuaTaskStatus::Paused);
        fs::remove_file(path).unwrap();
    }
    #[test]
    fn rejects_invalid_actions_and_terminal_retries() {
        let path = path();
        let mut queue = Queue::open(path.clone()).unwrap();
        assert!(queue
            .enqueue(LuaTaskAction::MetadataRefresh { appid: 0 })
            .is_err());
        assert!(queue
            .enqueue(LuaTaskAction::WorkshopDownload {
                account_approval: None,
                appid: 480,
                published_file_id: "../1".into()
            })
            .is_err());
        let task = queue
            .enqueue(LuaTaskAction::MetadataRefresh { appid: 480 })
            .unwrap();
        queue
            .control(&task.task_id, LuaTaskOperation::Cancel)
            .unwrap();
        assert!(queue
            .control(&task.task_id, LuaTaskOperation::Retry)
            .is_err());
        fs::remove_file(path).unwrap();
    }
    #[test]
    fn queue_schema_rejects_store_and_credentials() {
        assert!(
            serde_json::from_str::<LuaTaskAction>(r#"{"kind":"storeDownload","appid":480}"#)
                .is_err()
        );
        assert!(serde_json::from_str::<LuaTaskAction>(
            r#"{"kind":"metadataRefresh","appid":480,"accessToken":"secret"}"#
        )
        .is_err());
        assert_eq!(
            safe_error("https://example.invalid?token=secret"),
            "LUA_TASK_OPERATION_FAILED"
        );
    }
    #[test]
    fn queued_install_preserves_explicit_provider_and_channel_options() {
        let json = r#"{"kind":"luaInstall","appid":480,"gameName":"Fixture","provider":"hubcap","channel":"locked","buildId":"12345","statSteamId":"76561198000000000","conflictResolution":"keepCurrent"}"#;
        let action: LuaTaskAction = serde_json::from_str(json).unwrap();
        action.validate().unwrap();
        let serialized = serde_json::to_value(&action).unwrap();
        assert_eq!(serialized["provider"], "hubcap");
        assert_eq!(serialized["channel"], "locked");
        assert_eq!(serialized["buildId"], "12345");
        assert_eq!(serialized["conflictResolution"], "keepCurrent");
    }
    #[test]
    fn queue_files_are_isolated_and_atomic_work_cannot_be_aborted() {
        let first_path = path();
        let second_path = path();
        let mut first = Queue::open(first_path.clone()).unwrap();
        let second = Queue::open(second_path.clone()).unwrap();
        let action: LuaTaskAction = serde_json::from_str(
            r#"{"kind":"luaInstall","appid":480,"gameName":"Fixture","provider":"hubcap"}"#,
        )
        .unwrap();
        let task = first.enqueue(action).unwrap();
        assert!(second.data.tasks.is_empty());
        assert!(!second_path.exists());
        let mut next = first.data.clone();
        next.tasks[0].status = LuaTaskStatus::Running;
        first.commit(next).unwrap();
        assert_eq!(
            first
                .control(&task.task_id, LuaTaskOperation::Cancel)
                .unwrap_err(),
            "LUA_TASK_BUSY_ATOMIC_OPERATION"
        );
        assert_eq!(first.data.tasks[0].status, LuaTaskStatus::Running);
        fs::remove_file(first_path).unwrap();
    }
    #[test]
    fn persistence_failure_does_not_change_memory_state() {
        let file = path();
        let mut queue = Queue::open(file.clone()).unwrap();
        let task = queue
            .enqueue(LuaTaskAction::MetadataRefresh { appid: 480 })
            .unwrap();
        fs::remove_file(&file).unwrap();
        fs::create_dir(&file).unwrap();
        assert!(queue
            .control(&task.task_id, LuaTaskOperation::Pause)
            .is_err());
        assert_eq!(queue.data.tasks[0].status, LuaTaskStatus::Queued);
        fs::remove_dir(file).unwrap();
    }
    #[test]
    fn duplicate_lua_writes_are_blocked_but_metadata_and_workshop_are_independent() {
        let file = path();
        let mut queue = Queue::open(file.clone()).unwrap();
        let task = queue.enqueue(write_action("luaInstall", 480)).unwrap();
        for status in [
            LuaTaskStatus::Queued,
            LuaTaskStatus::Running,
            LuaTaskStatus::Pausing,
            LuaTaskStatus::Cancelling,
            LuaTaskStatus::Paused,
        ] {
            let mut next = queue.data.clone();
            next.tasks[0].status = status;
            queue.commit(next).unwrap();
            let before = fs::read(&file).unwrap();
            for kind in ["luaInstall", "luaUpdate", "luaSwitchChannel"] {
                assert_eq!(
                    queue.enqueue(write_action(kind, 480)).unwrap_err(),
                    "LUA_TASK_GAME_ALREADY_QUEUED"
                );
            }
            assert_eq!(fs::read(&file).unwrap(), before);
            assert_eq!(queue.data.tasks.len(), 1);
        }
        queue
            .enqueue(LuaTaskAction::MetadataRefresh { appid: 480 })
            .unwrap();
        queue
            .enqueue(LuaTaskAction::WorkshopDownload {
                account_approval: None,
                appid: 480,
                published_file_id: "123".into(),
            })
            .unwrap();
        queue.enqueue(write_action("luaUpdate", 481)).unwrap();
        queue
            .control(&task.task_id, LuaTaskOperation::Cancel)
            .unwrap();
        queue
            .enqueue(write_action("luaSwitchChannel", 480))
            .unwrap();
        fs::remove_file(file).unwrap();
    }
    #[test]
    fn resume_retry_and_legacy_restart_cannot_bypass_game_reservation() {
        let file = path();
        let mut queue = Queue::open(file.clone()).unwrap();
        let first = queue.enqueue(write_action("luaUpdate", 480)).unwrap();
        let mut next = queue.data.clone();
        next.tasks[0].status = LuaTaskStatus::Failed;
        queue.commit(next).unwrap();
        let second = queue
            .enqueue(write_action("luaSwitchChannel", 480))
            .unwrap();
        assert_eq!(
            queue
                .control(&first.task_id, LuaTaskOperation::Retry)
                .unwrap_err(),
            "LUA_TASK_GAME_ALREADY_QUEUED"
        );
        assert_eq!(queue.data.tasks[0].status, LuaTaskStatus::Failed);
        // Simulate a durable journal written by the former version that allowed duplicates.
        let mut next = queue.data.clone();
        next.tasks[0].status = LuaTaskStatus::Queued;
        queue.commit(next).unwrap();
        let mut recovered = Queue::open(file.clone()).unwrap();
        assert!(recovered.data.tasks.iter().all(|task| {
            task.status == LuaTaskStatus::Paused
                && task.error_code.as_deref() == Some("LUA_TASK_GAME_ALREADY_QUEUED")
        }));
        assert_eq!(
            recovered
                .control(&first.task_id, LuaTaskOperation::Resume)
                .unwrap_err(),
            "LUA_TASK_GAME_ALREADY_QUEUED"
        );
        recovered
            .control(&second.task_id, LuaTaskOperation::Cancel)
            .unwrap();
        recovered
            .control(&first.task_id, LuaTaskOperation::Resume)
            .unwrap();
        assert_eq!(recovered.data.tasks[0].status, LuaTaskStatus::Queued);
        fs::remove_file(file).unwrap();
    }
    #[test]
    fn archive_retains_full_receipt_and_only_removes_exact_finished_ids() {
        let directory = std::env::temp_dir().join(format!("lua-archive-test-{}", Uuid::new_v4()));
        let file = directory.join("task-queue.json");
        let mut queue = Queue::open(file.clone()).unwrap();
        let finished = queue
            .enqueue(LuaTaskAction::MetadataRefresh { appid: 480 })
            .unwrap();
        let retained = queue
            .enqueue(LuaTaskAction::MetadataRefresh { appid: 481 })
            .unwrap();
        let mut next = queue.data.clone();
        next.tasks[0].status = LuaTaskStatus::Completed;
        next.tasks[0].receipt =
            Some(serde_json::json!({"gameState":{"appid":480},"hash":"fixture"}));
        let full_task = serde_json::to_value(&next.tasks[0]).unwrap();
        queue.commit(next).unwrap();
        for ids in [
            vec![],
            vec![finished.task_id.clone(), finished.task_id.clone()],
            vec![retained.task_id.clone()],
            vec![Uuid::new_v4().to_string()],
            vec!["../task-queue.json".into()],
        ] {
            assert!(queue.archive_finished(ids).is_err());
        }
        assert!(!directory.join("task-archive").exists());
        let result = queue
            .archive_finished(vec![finished.task_id.clone()])
            .unwrap();
        assert_eq!(result.archived_task_ids, vec![finished.task_id]);
        assert_eq!(result.archived_count, 1);
        assert_eq!(result.remaining_tasks.len(), 1);
        assert_eq!(result.remaining_tasks[0].task_id, retained.task_id);
        let archive_bytes = fs::read(&result.archive_path).unwrap();
        assert_eq!(
            result.sha256,
            format!("{:x}", Sha256::digest(&archive_bytes))
        );
        let archive: TaskArchive = serde_json::from_slice(&archive_bytes).unwrap();
        assert_eq!(serde_json::to_value(&archive.tasks[0]).unwrap(), full_task);
        assert_eq!(Queue::open(file.clone()).unwrap().data.tasks.len(), 1);
        queue
            .control(&retained.task_id, LuaTaskOperation::Cancel)
            .unwrap();
        let cancelled = queue.archive_finished(vec![retained.task_id]).unwrap();
        assert_ne!(result.archive_path, cancelled.archive_path);
        assert_eq!(fs::read(&result.archive_path).unwrap(), archive_bytes);
        assert!(Queue::open(file.clone()).unwrap().data.tasks.is_empty());
        fs::remove_file(result.archive_path).unwrap();
        fs::remove_file(cancelled.archive_path).unwrap();
        fs::remove_file(file).unwrap();
        fs::remove_dir(directory.join("task-archive")).unwrap();
        fs::remove_dir(directory).unwrap();
    }
    #[test]
    fn archive_write_or_queue_commit_failure_never_discards_task_history() {
        let directory = std::env::temp_dir().join(format!("lua-archive-test-{}", Uuid::new_v4()));
        let file = directory.join("task-queue.json");
        let mut queue = Queue::open(file.clone()).unwrap();
        let task = queue
            .enqueue(LuaTaskAction::MetadataRefresh { appid: 480 })
            .unwrap();
        queue
            .control(&task.task_id, LuaTaskOperation::Cancel)
            .unwrap();
        let archived_directory = directory.join("task-archive");
        fs::write(&archived_directory, b"owned archive-path blocker").unwrap();
        let original = fs::read(&file).unwrap();
        assert!(queue.archive_finished(vec![task.task_id.clone()]).is_err());
        assert_eq!(fs::read(&file).unwrap(), original);
        assert_eq!(queue.data.tasks.len(), 1);
        fs::remove_file(&archived_directory).unwrap();
        // Real filesystem failure in the atomic journal replacement, after the
        // archive has been flushed and verified, must retain both audit and memory.
        fs::remove_file(&file).unwrap();
        fs::create_dir(&file).unwrap();
        assert_eq!(
            queue
                .archive_finished(vec![task.task_id.clone()])
                .unwrap_err(),
            "LUA_QUEUE_PERSIST_FAILED"
        );
        assert_eq!(queue.data.tasks.len(), 1);
        assert_eq!(queue.data.tasks[0].task_id, task.task_id);
        assert_eq!(queue.data.tasks[0].status, LuaTaskStatus::Cancelled);
        let entries: Vec<_> = fs::read_dir(&archived_directory)
            .unwrap()
            .map(|entry| entry.unwrap().path())
            .collect();
        assert_eq!(entries.len(), 1);
        let audit: TaskArchive = serde_json::from_slice(&fs::read(&entries[0]).unwrap()).unwrap();
        assert_eq!(audit.tasks[0].task_id, task.task_id);
        fs::remove_file(&entries[0]).unwrap();
        fs::remove_dir(file).unwrap();
        fs::remove_dir(archived_directory).unwrap();
        fs::remove_dir(directory).unwrap();
    }
}
