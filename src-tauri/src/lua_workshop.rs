//! Explicit Lua Workshop downloads, isolated beneath downloading/lua-workshop.
use chrono::Utc;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    fs::{self, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::{
        atomic::{AtomicU8, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant},
};
use tauri::{AppHandle, Manager};
use uuid::Uuid;

const DETAILS_URL: &str =
    "https://api.steampowered.com/ISteamRemoteStorage/GetPublishedFileDetails/v1/";
const MAX_METADATA: u64 = 2 * 1024 * 1024;
const MAX_CONTENT: u64 = 8 * 1024 * 1024 * 1024;
static SETTINGS_LOCK: Mutex<()> = Mutex::new(());

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LuaWorkshopItem {
    pub account_approval: Option<WorkshopAccountApproval>,
    pub published_file_id: String,
    pub appid: u32,
    pub title: String,
    pub size_bytes: u64,
    pub updated_at: u64,
    pub preview_url: Option<String>,
    pub authentication: String,
    pub download_available: bool,
    pub availability_reason: Option<String>,
    #[serde(skip)]
    content_url: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkshopAccountApproval {
    pub account_id: String,
    pub updated_at: u64,
    pub expected_bytes: u64,
}
impl WorkshopAccountApproval {
    pub(crate) fn validate(&self) -> Result<(), String> {
        if Uuid::parse_str(&self.account_id).is_err()
            || self.updated_at == 0
            || self.expected_bytes == 0
            || self.expected_bytes > MAX_CONTENT
        {
            return Err("LUA_WORKSHOP_APPROVAL_INVALID".into());
        }
        Ok(())
    }
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LuaWorkshopSettings {
    pub downloading_root: String,
    #[serde(default)]
    pub official_tool: Option<ApprovedWorkshopTool>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ApprovedWorkshopTool {
    pub executable_path: String,
    pub sha256: String,
    pub source_release_url: String,
    pub approved: bool,
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LuaWorkshopHealth {
    pub direct_download_available: bool,
    pub official_tool_available: bool,
    pub authentication_available: bool,
    pub reason_code: String,
    pub downloading_root: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkshopFile {
    pub relative_path: String,
    pub size_bytes: u64,
    pub sha256: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LuaWorkshopReceipt {
    pub schema_version: u32,
    pub task_id: String,
    pub appid: u32,
    pub published_file_id: String,
    pub source: String,
    pub source_updated_at: u64,
    pub output_path: String,
    pub verified_at: String,
    pub files: Vec<WorkshopFile>,
}
#[derive(Serialize, Deserialize)]
struct PartialIdentity {
    appid: u32,
    item: String,
    updated: u64,
    expected: u64,
    url_hash: String,
}

pub(crate) fn validate_item_id(value: &str) -> Result<u64, String> {
    if value.is_empty()
        || value.len() > 20
        || !value.bytes().all(|b| b.is_ascii_digit())
        || value.starts_with('0')
    {
        return Err("LUA_WORKSHOP_INVALID_ITEM_ID".into());
    }
    value
        .parse::<u64>()
        .ok()
        .filter(|id| *id != 0)
        .ok_or_else(|| "LUA_WORKSHOP_INVALID_ITEM_ID".into())
}
pub(crate) fn reject_reparse_ancestors(path: &Path) -> Result<(), String> {
    for ancestor in path.ancestors().collect::<Vec<_>>().into_iter().rev() {
        match fs::symlink_metadata(ancestor) {
            Ok(metadata) => {
                #[cfg(windows)]
                {
                    use std::os::windows::fs::MetadataExt;
                    if metadata.file_attributes() & 0x400 != 0 {
                        return Err("LUA_PATH_REPARSE_POINT".into());
                    }
                }
                if metadata.file_type().is_symlink() {
                    return Err("LUA_PATH_REPARSE_POINT".into());
                }
                if metadata.is_file() {
                    reject_hard_links(ancestor)?;
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => return Err("LUA_PATH_INSPECTION_FAILED".into()),
        }
    }
    Ok(())
}
fn reject_hard_links(path: &Path) -> Result<(), String> {
    #[cfg(windows)]
    {
        use std::os::windows::io::AsRawHandle;
        use winapi::um::fileapi::{GetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION};
        let file = fs::File::open(path).map_err(|_| "LUA_PATH_INSPECTION_FAILED")?;
        let mut info: BY_HANDLE_FILE_INFORMATION = unsafe { std::mem::zeroed() };
        if unsafe { GetFileInformationByHandle(file.as_raw_handle() as _, &mut info) } == 0 {
            return Err("LUA_PATH_INSPECTION_FAILED".into());
        }
        if info.nNumberOfLinks > 1 {
            return Err("LUA_PATH_HARD_LINK".into());
        }
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if fs::metadata(path)
            .map_err(|_| "LUA_PATH_INSPECTION_FAILED")?
            .nlink()
            > 1
        {
            return Err("LUA_PATH_HARD_LINK".into());
        }
    }
    Ok(())
}
fn validate_root(path: &Path) -> Result<(), String> {
    if !path.is_absolute()
        || path
            .file_name()
            .and_then(|v| v.to_str())
            .is_none_or(|v| !v.eq_ignore_ascii_case("downloading"))
        || path
            .components()
            .any(|c| matches!(c, std::path::Component::ParentDir))
        || path.ancestors().any(|p| {
            p.file_name()
                .and_then(|n| n.to_str())
                .is_some_and(|n| n.eq_ignore_ascii_case("steamapps"))
        })
    {
        return Err("LUA_WORKSHOP_ROOT_MUST_BE_NON_STEAM_DOWNLOADING".into());
    }
    reject_reparse_ancestors(path)
}
fn settings_path(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|p| p.join("lua-experience/workshop-settings.json"))
        .map_err(|_| "LUA_WORKSHOP_PATH_UNAVAILABLE".into())
}
fn settings(app: &AppHandle) -> Result<LuaWorkshopSettings, String> {
    let path = settings_path(app)?;
    reject_reparse_ancestors(&path)?;
    let value = if path.exists() {
        if fs::metadata(&path)
            .map_err(|_| "LUA_WORKSHOP_SETTINGS_FAILED")?
            .len()
            > 16_384
        {
            return Err("LUA_WORKSHOP_SETTINGS_INVALID".into());
        }
        serde_json::from_slice(&fs::read(path).map_err(|_| "LUA_WORKSHOP_SETTINGS_FAILED")?)
            .map_err(|_| "LUA_WORKSHOP_SETTINGS_INVALID")?
    } else {
        let exe = std::env::current_exe().map_err(|_| "LUA_WORKSHOP_PATH_UNAVAILABLE")?;
        LuaWorkshopSettings {
            downloading_root: exe
                .parent()
                .ok_or("LUA_WORKSHOP_PATH_UNAVAILABLE")?
                .join("downloading")
                .to_string_lossy()
                .into_owned(),
            official_tool: None,
        }
    };
    validate_root(Path::new(&value.downloading_root))?;
    Ok(value)
}
#[tauri::command]
pub fn lua_get_workshop_settings(app: AppHandle) -> Result<LuaWorkshopSettings, String> {
    settings(&app)
}
#[tauri::command]
pub async fn lua_save_workshop_settings(
    app: AppHandle,
    settings: LuaWorkshopSettings,
) -> Result<LuaWorkshopSettings, String> {
    tauri::async_runtime::spawn_blocking(move || save_settings(&app, settings))
        .await
        .map_err(|_| "LUA_WORKSHOP_WORKER_FAILED")?
}
fn save_settings(
    app: &AppHandle,
    settings: LuaWorkshopSettings,
) -> Result<LuaWorkshopSettings, String> {
    validate_root(Path::new(&settings.downloading_root))?;
    if let Some(tool) = &settings.official_tool {
        verify_tool(tool)?;
    }
    let _guard = SETTINGS_LOCK
        .lock()
        .map_err(|_| "LUA_WORKSHOP_SETTINGS_BUSY")?;
    let path = settings_path(&app)?;
    reject_reparse_ancestors(&path)?;
    crate::lua_live::atomic_write_path(
        &path,
        &serde_json::to_vec_pretty(&settings).map_err(|_| "LUA_WORKSHOP_SETTINGS_INVALID")?,
    )?;
    Ok(settings)
}
#[tauri::command]
pub async fn lua_get_workshop_health(app: AppHandle) -> Result<LuaWorkshopHealth, String> {
    tauri::async_runtime::spawn_blocking(move || workshop_health(&app))
        .await
        .map_err(|_| "LUA_WORKSHOP_WORKER_FAILED")?
}
fn workshop_health(app: &AppHandle) -> Result<LuaWorkshopHealth, String> {
    let settings = settings(&app)?;
    let tool_available = settings
        .official_tool
        .as_ref()
        .is_some_and(|tool| verify_tool(tool).is_ok());
    let authentication_available = crate::lua_experience::native::NativeBridge::new(
        crate::lua_experience::native_resource_root(app)?,
    )
    .available();
    Ok(LuaWorkshopHealth {
        direct_download_available: true,
        official_tool_available: tool_available,
        authentication_available,
        reason_code: if authentication_available {
            "STEAMKIT_QR_AUTH_AVAILABLE_DIRECT_ONLY"
        } else if tool_available {
            "USER_APPROVED_TOOL_HASH_MATCH_ANONYMOUS_ONLY"
        } else {
            "PUBLIC_STEAM_CONTENT_ONLY_APPROVED_TOOL_REQUIRED"
        }
        .into(),
        downloading_root: settings.downloading_root,
    })
}
// No existing modified downloader is inferred to support official Workshop arguments.
pub(crate) fn lua_workshop_tool_available(app: &AppHandle) -> Result<bool, String> {
    Ok(settings(app)?
        .official_tool
        .as_ref()
        .is_some_and(|tool| verify_tool(tool).is_ok()))
}

fn verify_tool(tool: &ApprovedWorkshopTool) -> Result<(), String> {
    if !tool.approved
        || tool.sha256.len() != 64
        || !tool.sha256.bytes().all(|b| b.is_ascii_hexdigit())
    {
        return Err("LUA_WORKSHOP_TOOL_APPROVAL_REQUIRED".into());
    }
    let origin = reqwest::Url::parse(&tool.source_release_url)
        .map_err(|_| "LUA_WORKSHOP_TOOL_ORIGIN_INVALID")?;
    if origin.scheme() != "https"
        || origin.host_str() != Some("github.com")
        || !origin
            .path()
            .starts_with("/SteamRE/DepotDownloader/releases/download/")
        || !origin.username().is_empty()
        || origin.password().is_some()
        || origin.port_or_known_default() != Some(443)
        || origin.query().is_some()
        || origin.fragment().is_some()
    {
        return Err("LUA_WORKSHOP_TOOL_ORIGIN_INVALID".into());
    }
    let path = Path::new(&tool.executable_path);
    if !path.is_absolute()
        || path
            .file_name()
            .and_then(|n| n.to_str())
            .is_none_or(|n| !n.eq_ignore_ascii_case("DepotDownloader.exe"))
    {
        return Err("LUA_WORKSHOP_TOOL_PATH_INVALID".into());
    }
    reject_reparse_ancestors(path)?;
    let metadata = fs::metadata(path).map_err(|_| "LUA_WORKSHOP_TOOL_MISSING")?;
    if !metadata.is_file() || metadata.len() > 256 * 1024 * 1024 {
        return Err("LUA_WORKSHOP_TOOL_INVALID".into());
    }
    let bytes = fs::read(path).map_err(|_| "LUA_WORKSHOP_TOOL_READ_FAILED")?;
    if !hex::encode(Sha256::digest(&bytes)).eq_ignore_ascii_case(&tool.sha256) {
        return Err("LUA_WORKSHOP_TOOL_HASH_CHANGED".into());
    }
    // Only a self-contained .NET single-file distribution is allowed; a verified apphost
    // beside unpinned managed dependencies would not constitute a verified owned file set.
    const BUNDLE: [u8; 32] = [
        0x8b, 0x12, 0x02, 0xb9, 0x6a, 0x61, 0x20, 0x38, 0x72, 0x7b, 0x93, 0x02, 0x14, 0xd7, 0xa0,
        0x32, 0x13, 0xf5, 0xb9, 0xe6, 0xef, 0xae, 0x33, 0x18, 0xee, 0x3b, 0x2d, 0xce, 0x24, 0xb3,
        0x6a, 0xae,
    ];
    let marker = bytes
        .windows(32)
        .position(|part| part == BUNDLE)
        .filter(|offset| *offset >= 8)
        .ok_or("LUA_WORKSHOP_TOOL_SINGLE_FILE_REQUIRED")?;
    let offset = u64::from_le_bytes(bytes[marker - 8..marker].try_into().unwrap());
    if bytes.get(..2) != Some(b"MZ") || offset == 0 || offset >= bytes.len() as u64 {
        return Err("LUA_WORKSHOP_TOOL_SINGLE_FILE_REQUIRED".into());
    }
    Ok(())
}

fn client() -> Result<reqwest::blocking::Client, String> {
    reqwest::blocking::Client::builder()
        .connect_timeout(Duration::from_secs(15))
        .timeout(Duration::from_secs(120))
        .redirect(reqwest::redirect::Policy::none())
        .user_agent("0xoLemon-LuaWorkshop/1")
        .build()
        .map_err(|_| "LUA_WORKSHOP_HTTP_UNAVAILABLE".into())
}
fn trusted_content_url(value: &str) -> bool {
    reqwest::Url::parse(value).is_ok_and(|u| {
        u.scheme() == "https"
            && u.username().is_empty()
            && u.password().is_none()
            && u.port_or_known_default() == Some(443)
            && u.host_str().is_some_and(|h| {
                h == "steamusercontent.com"
                    || h.ends_with(".steamusercontent.com")
                    || h == "steamusercontent-a.akamaihd.net"
                    || h == "steamuserimages-a.akamaihd.net"
                    || h == "community.akamai.steamstatic.com"
            })
    })
}
fn number(value: &serde_json::Value) -> Option<u64> {
    value.as_u64().or_else(|| value.as_str()?.parse().ok())
}
fn parse_details(bytes: &[u8], item: &str) -> Result<LuaWorkshopItem, String> {
    let json: serde_json::Value =
        serde_json::from_slice(bytes).map_err(|_| "LUA_WORKSHOP_INVALID_RESPONSE")?;
    let data = json
        .pointer("/response/publishedfiledetails/0")
        .ok_or("LUA_WORKSHOP_ITEM_UNAVAILABLE")?;
    if data.get("publishedfileid").and_then(|v| v.as_str()) != Some(item)
        || data.get("result").and_then(number) != Some(1)
    {
        return Err("LUA_WORKSHOP_ITEM_UNAVAILABLE_OR_AUTH_REQUIRED".into());
    }
    let appid = data
        .get("consumer_app_id")
        .and_then(number)
        .and_then(|v| u32::try_from(v).ok())
        .filter(|v| *v > 0)
        .ok_or("LUA_WORKSHOP_INVALID_APPID")?;
    let content_url = data
        .get("file_url")
        .and_then(|v| v.as_str())
        .filter(|v| trusted_content_url(v))
        .map(str::to_string);
    let size = data.get("file_size").and_then(number).unwrap_or(0);
    let available = content_url.is_some() && size > 0 && size <= MAX_CONTENT;
    Ok(LuaWorkshopItem {
        account_approval: None,
        published_file_id: item.into(),
        appid,
        title: data
            .get("title")
            .and_then(|v| v.as_str())
            .unwrap_or("Workshop item")
            .chars()
            .filter(|c| !c.is_control())
            .take(256)
            .collect(),
        size_bytes: size,
        updated_at: data.get("time_updated").and_then(number).unwrap_or(0),
        preview_url: data
            .get("preview_url")
            .and_then(|v| v.as_str())
            .filter(|v| trusted_content_url(v))
            .map(str::to_string),
        authentication: if content_url.is_some() {
            "notRequiredForPublicUrl"
        } else {
            "requiredOrUgcAdapterNeeded"
        }
        .into(),
        download_available: available,
        availability_reason: if available {
            None
        } else {
            Some(
                if size > MAX_CONTENT {
                    "LUA_WORKSHOP_ITEM_TOO_LARGE"
                } else {
                    "LUA_WORKSHOP_AUTH_OR_OFFICIAL_ADAPTER_REQUIRED"
                }
                .into(),
            )
        },
        content_url,
    })
}
fn resolve(item: &str) -> Result<LuaWorkshopItem, String> {
    validate_item_id(item)?;
    let mut response = client()?
        .post(DETAILS_URL)
        .form(&[("itemcount", "1"), ("publishedfileids[0]", item)])
        .send()
        .map_err(|_| "LUA_WORKSHOP_NETWORK_FAILED")?;
    if !response.status().is_success() {
        return Err("LUA_WORKSHOP_METADATA_HTTP_ERROR".into());
    }
    if response.content_length().is_some_and(|v| v > MAX_METADATA) {
        return Err("LUA_WORKSHOP_RESPONSE_TOO_LARGE".into());
    }
    let mut bytes = Vec::new();
    response
        .by_ref()
        .take(MAX_METADATA + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "LUA_WORKSHOP_READ_FAILED")?;
    if bytes.len() as u64 > MAX_METADATA {
        return Err("LUA_WORKSHOP_RESPONSE_TOO_LARGE".into());
    }
    parse_details(&bytes, item)
}
#[tauri::command]
pub async fn lua_resolve_workshop_item(
    app: AppHandle,
    published_file_id: String,
) -> Result<LuaWorkshopItem, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut item = resolve(&published_file_id)?;
        if !item.download_available
            && item.size_bytes <= MAX_CONTENT
            && lua_workshop_tool_available(&app)?
        {
            item.download_available = true;
            item.authentication = "unknownAnonymousToolAttempt".into();
            item.availability_reason =
                Some("USER_APPROVED_TOOL_ANONYMOUS_ATTEMPT_AUTH_MAY_BE_REQUIRED".into());
        }
        Ok(item)
    })
    .await
    .map_err(|_| "LUA_WORKSHOP_WORKER_FAILED")?
}

fn authenticated_item(
    details: crate::lua_steam_auth::AuthenticatedDetails,
    account_id: &str,
) -> LuaWorkshopItem {
    let direct = details.file_type == 0
        && trusted_content_url(&details.content_url)
        && details.size_bytes > 0
        && details.size_bytes <= MAX_CONTENT
        && details.updated_at > 0;
    LuaWorkshopItem {
        published_file_id: details.item_id,
        appid: details.appid,
        title: details.title,
        size_bytes: details.size_bytes,
        updated_at: details.updated_at,
        preview_url: None,
        authentication: "steamAccountVerified".into(),
        download_available: direct,
        availability_reason: if direct {
            None
        } else {
            Some(
                if details.file_type != 0 {
                    "LUA_WORKSHOP_FILE_TYPE_UNSUPPORTED"
                } else if details.size_bytes > MAX_CONTENT {
                    "LUA_WORKSHOP_ITEM_TOO_LARGE"
                } else {
                    "LUA_WORKSHOP_AUTHENTICATED_CDN_REQUIRED"
                }
                .into(),
            )
        },
        content_url: if direct {
            Some(details.content_url)
        } else {
            None
        },
        account_approval: direct.then(|| WorkshopAccountApproval {
            account_id: account_id.into(),
            updated_at: details.updated_at,
            expected_bytes: details.size_bytes,
        }),
    }
}

#[tauri::command]
pub async fn lua_resolve_authenticated_workshop_item(
    app: AppHandle,
    account_id: String,
    appid: u32,
    published_file_id: String,
) -> Result<LuaWorkshopItem, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let lease =
            crate::lua_steam_auth::account_lease(&app, &account_id, Arc::new(AtomicU8::new(0)))?;
        Ok(authenticated_item(
            lease.resolve(appid, &published_file_id)?,
            &account_id,
        ))
    })
    .await
    .map_err(|_| "LUA_WORKSHOP_WORKER_FAILED")?
}

pub async fn execute_download(
    app: AppHandle,
    appid: u32,
    item: String,
    task_id: String,
    stop: Arc<AtomicU8>,
    approval: Option<WorkshopAccountApproval>,
) -> Result<LuaWorkshopReceipt, String> {
    let settings = settings(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        if let Some(approval) = approval {
            approval.validate()?;
            let lease =
                crate::lua_steam_auth::account_lease(&app, &approval.account_id, stop.clone())?;
            let resolved = authenticated_item(lease.resolve(appid, &item)?, &approval.account_id);
            if resolved.updated_at != approval.updated_at
                || resolved.size_bytes != approval.expected_bytes
            {
                return Err("LUA_WORKSHOP_REMOTE_CHANGED_REVIEW_REQUIRED".into());
            }
            // Keep the account lease until all bytes/receipt are committed. Never retry
            // an authenticated intent with an anonymous tool or a different account.
            return download_resolved(
                &settings,
                appid,
                &item,
                &task_id,
                &stop,
                &|progress| {
                    crate::lua_task_queue::report_workshop_progress(&app, &task_id, progress)
                },
                resolved,
            );
        }
        download(&settings, appid, &item, &task_id, &stop, &|progress| {
            crate::lua_task_queue::report_workshop_progress(&app, &task_id, progress)
        })
    })
    .await
    .map_err(|_| "LUA_WORKSHOP_WORKER_FAILED")?
}
fn download(
    settings: &LuaWorkshopSettings,
    appid: u32,
    item_id: &str,
    task_id: &str,
    stop: &AtomicU8,
    progress: &dyn Fn(f64) -> Result<(), String>,
) -> Result<LuaWorkshopReceipt, String> {
    let root = Path::new(&settings.downloading_root);
    validate_root(root)?;
    validate_item_id(item_id)?;
    if appid == 0 || Uuid::parse_str(task_id).is_err() {
        return Err("LUA_WORKSHOP_INVALID_IDENTITY".into());
    }
    let item = resolve(item_id)?;
    download_resolved(settings, appid, item_id, task_id, stop, progress, item)
}

fn download_resolved(
    settings: &LuaWorkshopSettings,
    appid: u32,
    item_id: &str,
    task_id: &str,
    stop: &AtomicU8,
    progress: &dyn Fn(f64) -> Result<(), String>,
    item: LuaWorkshopItem,
) -> Result<LuaWorkshopReceipt, String> {
    let root = Path::new(&settings.downloading_root);
    validate_root(root)?;
    validate_item_id(item_id)?;
    if appid == 0 || Uuid::parse_str(task_id).is_err() {
        return Err("LUA_WORKSHOP_INVALID_IDENTITY".into());
    }
    if stop.load(Ordering::SeqCst) != 0 {
        return Err("LUA_WORKSHOP_INTERRUPTED".into());
    }
    if item.appid != appid {
        return Err("LUA_WORKSHOP_APPID_MISMATCH".into());
    }
    if !item.download_available {
        if let Some(tool) = settings
            .official_tool
            .as_ref()
            .filter(|_| item.authentication != "steamAccountVerified")
        {
            return download_with_tool(root, &item, task_id, tool, stop);
        }
        return Err(item
            .availability_reason
            .unwrap_or("LUA_WORKSHOP_AUTH_REQUIRED".into()));
    }
    let url = item
        .content_url
        .as_ref()
        .ok_or("LUA_WORKSHOP_AUTH_REQUIRED")?;
    let output = root
        .join("lua-workshop")
        .join(appid.to_string())
        .join(item_id)
        .join(task_id);
    reject_reparse_ancestors(&output)?;
    fs::create_dir_all(&output).map_err(|_| "LUA_WORKSHOP_CREATE_FAILED")?;
    reject_reparse_ancestors(&output)?;
    if fs2::available_space(&output).map_err(|_| "LUA_WORKSHOP_SPACE_CHECK_FAILED")?
        < item.size_bytes.saturating_add(64 * 1024 * 1024)
    {
        return Err("LUA_WORKSHOP_INSUFFICIENT_SPACE".into());
    }
    let identity = PartialIdentity {
        appid,
        item: item_id.into(),
        updated: item.updated_at,
        expected: item.size_bytes,
        url_hash: hex::encode(Sha256::digest(url.as_bytes())),
    };
    let identity_path = output.join("partial-identity.json");
    reject_reparse_ancestors(&identity_path)?;
    if identity_path.exists() {
        let previous: PartialIdentity = serde_json::from_slice(&read_owned_json(&identity_path)?)
            .map_err(|_| "LUA_WORKSHOP_PARTIAL_INVALID")?;
        if previous.appid != identity.appid
            || previous.item != identity.item
            || previous.updated != identity.updated
            || previous.expected != identity.expected
            || previous.url_hash != identity.url_hash
        {
            return Err("LUA_WORKSHOP_REMOTE_CHANGED_REVIEW_REQUIRED".into());
        }
    } else {
        if output.join("content.part").exists() || output.join("content.bin").exists() {
            return Err("LUA_WORKSHOP_UNOWNED_CONTENT".into());
        }
        crate::lua_live::atomic_write_path(
            &identity_path,
            &serde_json::to_vec(&identity).map_err(|_| "LUA_WORKSHOP_PARTIAL_INVALID")?,
        )?;
    }
    let partial = output.join("content.part");
    let complete = output.join("content.bin");
    reject_reparse_ancestors(&partial)?;
    reject_reparse_ancestors(&complete)?;
    if !complete.exists() {
        let offset = fs::metadata(&partial).map(|m| m.len()).unwrap_or(0);
        if offset > item.size_bytes {
            return Err("LUA_WORKSHOP_PARTIAL_SIZE_INVALID".into());
        }
        if offset < item.size_bytes {
            let http = client()?;
            let mut request = http.get(url);
            if offset > 0 {
                request = request.header(reqwest::header::RANGE, format!("bytes={offset}-"));
            }
            let mut response = request.send().map_err(|_| "LUA_WORKSHOP_NETWORK_FAILED")?;
            if offset == 0 && response.status() != reqwest::StatusCode::OK {
                return Err("LUA_WORKSHOP_CONTENT_HTTP_ERROR".into());
            }
            if offset > 0 {
                let expected =
                    format!("bytes {offset}-{}/{}", item.size_bytes - 1, item.size_bytes);
                if response.status() != reqwest::StatusCode::PARTIAL_CONTENT
                    || response
                        .headers()
                        .get(reqwest::header::CONTENT_RANGE)
                        .and_then(|v| v.to_str().ok())
                        != Some(expected.as_str())
                {
                    return Err("LUA_WORKSHOP_RESUME_NOT_SUPPORTED".into());
                }
            }
            let mut file = OpenOptions::new()
                .create(true)
                .append(true)
                .open(&partial)
                .map_err(|_| "LUA_WORKSHOP_WRITE_FAILED")?;
            let mut total = offset;
            let mut buffer = [0_u8; 64 * 1024];
            let mut last_progress = Instant::now();
            loop {
                if stop.load(Ordering::SeqCst) != 0 {
                    file.sync_all().map_err(|_| "LUA_WORKSHOP_FLUSH_FAILED")?;
                    return Err("LUA_WORKSHOP_INTERRUPTED".into());
                }
                let read = response
                    .read(&mut buffer)
                    .map_err(|_| "LUA_WORKSHOP_READ_FAILED")?;
                if read == 0 {
                    break;
                }
                total = total
                    .checked_add(read as u64)
                    .ok_or("LUA_WORKSHOP_CONTENT_TOO_LARGE")?;
                if total > item.size_bytes || total > MAX_CONTENT {
                    return Err("LUA_WORKSHOP_CONTENT_TOO_LARGE".into());
                }
                file.write_all(&buffer[..read])
                    .map_err(|_| "LUA_WORKSHOP_WRITE_FAILED")?;
                if last_progress.elapsed() >= Duration::from_secs(1) {
                    progress((total as f64 / item.size_bytes as f64).min(0.999))?;
                    last_progress = Instant::now();
                }
            }
            file.sync_all().map_err(|_| "LUA_WORKSHOP_FLUSH_FAILED")?;
            if total != item.size_bytes {
                return Err("LUA_WORKSHOP_CONTENT_SIZE_MISMATCH".into());
            }
        }
        if stop.load(Ordering::SeqCst) != 0 {
            return Err("LUA_WORKSHOP_INTERRUPTED".into());
        }
        reject_reparse_ancestors(&partial)?;
        reject_reparse_ancestors(&complete)?;
        if complete.exists() {
            return Err("LUA_WORKSHOP_TARGET_CONFLICT".into());
        }
        fs::rename(&partial, &complete).map_err(|_| "LUA_WORKSHOP_COMMIT_FAILED")?;
    }
    let mut file = fs::File::open(&complete).map_err(|_| "LUA_WORKSHOP_VERIFY_FAILED")?;
    let mut hash = Sha256::new();
    let bytes = std::io::copy(&mut file, &mut hash).map_err(|_| "LUA_WORKSHOP_VERIFY_FAILED")?;
    if bytes != item.size_bytes {
        return Err("LUA_WORKSHOP_CONTENT_SIZE_MISMATCH".into());
    }
    if stop.load(Ordering::SeqCst) != 0 {
        return Err("LUA_WORKSHOP_INTERRUPTED".into());
    }
    let receipt = LuaWorkshopReceipt {
        schema_version: 1,
        task_id: task_id.into(),
        appid,
        published_file_id: item_id.into(),
        source: item
            .account_approval
            .as_ref()
            .map(|approval| format!("steamKitAuthenticatedDirect:{}", approval.account_id))
            .unwrap_or_else(|| "steamPublishedFilePublicUrl".into()),
        source_updated_at: item.updated_at,
        output_path: output.to_string_lossy().into_owned(),
        verified_at: Utc::now().to_rfc3339(),
        files: vec![WorkshopFile {
            relative_path: "content.bin".into(),
            size_bytes: bytes,
            sha256: hex::encode(hash.finalize()),
        }],
    };
    crate::lua_live::atomic_write_path(
        &output.join("receipt.json"),
        &serde_json::to_vec_pretty(&receipt).map_err(|_| "LUA_WORKSHOP_RECEIPT_INVALID")?,
    )?;
    Ok(receipt)
}

fn download_with_tool(
    root: &Path,
    item: &LuaWorkshopItem,
    task_id: &str,
    tool: &ApprovedWorkshopTool,
    stop: &AtomicU8,
) -> Result<LuaWorkshopReceipt, String> {
    verify_tool(tool)?;
    if item.size_bytes > MAX_CONTENT {
        return Err("LUA_WORKSHOP_ITEM_TOO_LARGE".into());
    }
    let output = root
        .join("lua-workshop")
        .join(item.appid.to_string())
        .join(&item.published_file_id)
        .join(task_id);
    reject_reparse_ancestors(&output)?;
    fs::create_dir_all(&output).map_err(|_| "LUA_WORKSHOP_CREATE_FAILED")?;
    let content = output.join("content");
    reject_reparse_ancestors(&content)?;
    fs::create_dir_all(&content).map_err(|_| "LUA_WORKSHOP_CREATE_FAILED")?;
    // Existing content is only reusable when the task's identity record matches.
    let identity_path = output.join("tool-identity.json");
    let identity = serde_json::json!({"appid":item.appid,"item":item.published_file_id,"updated":item.updated_at,"toolSha256":tool.sha256});
    if identity_path.exists() {
        let previous: serde_json::Value = serde_json::from_slice(&read_owned_json(&identity_path)?)
            .map_err(|_| "LUA_WORKSHOP_PARTIAL_INVALID")?;
        if previous != identity {
            return Err("LUA_WORKSHOP_REMOTE_CHANGED_REVIEW_REQUIRED".into());
        }
    } else {
        if fs::read_dir(&content)
            .map_err(|_| "LUA_WORKSHOP_INVENTORY_FAILED")?
            .next()
            .is_some()
        {
            return Err("LUA_WORKSHOP_UNOWNED_CONTENT".into());
        }
        crate::lua_live::atomic_write_path(
            &identity_path,
            &serde_json::to_vec(&identity).map_err(|_| "LUA_WORKSHOP_PARTIAL_INVALID")?,
        )?;
    }
    inventory(&content)?;
    if fs2::available_space(&output).map_err(|_| "LUA_WORKSHOP_SPACE_CHECK_FAILED")?
        < item.size_bytes.saturating_add(64 * 1024 * 1024)
    {
        return Err("LUA_WORKSHOP_INSUFFICIENT_SPACE".into());
    }
    let mut command = Command::new(&tool.executable_path);
    command
        .args(tool_arguments(
            item.appid,
            &item.published_file_id,
            &content,
        ))
        .current_dir(&output)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    let mut child = command
        .spawn()
        .map_err(|_| "LUA_WORKSHOP_TOOL_START_FAILED")?;
    let started = Instant::now();
    loop {
        if stop.load(Ordering::SeqCst) != 0 || started.elapsed() > Duration::from_secs(3600) {
            let _ = child.kill();
            let _ = child.wait();
            return Err(if stop.load(Ordering::SeqCst) != 0 {
                "LUA_WORKSHOP_INTERRUPTED"
            } else {
                "LUA_WORKSHOP_TOOL_TIMEOUT"
            }
            .into());
        }
        match child.try_wait() {
            Ok(Some(status)) if status.success() => break,
            Ok(Some(_)) => return Err("LUA_WORKSHOP_TOOL_FAILED_OR_AUTH_REQUIRED".into()),
            Ok(None) => std::thread::sleep(Duration::from_millis(200)),
            Err(_) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err("LUA_WORKSHOP_TOOL_WAIT_FAILED".into());
            }
        }
    }
    let files = inventory(&content)?;
    if files.is_empty() {
        return Err("LUA_WORKSHOP_EMPTY_OUTPUT".into());
    }
    let receipt = LuaWorkshopReceipt {
        schema_version: 1,
        task_id: task_id.into(),
        appid: item.appid,
        published_file_id: item.published_file_id.clone(),
        source: format!(
            "userApprovedOfficialDepotDownloader:{}",
            tool.sha256.to_ascii_lowercase()
        ),
        source_updated_at: item.updated_at,
        output_path: content.to_string_lossy().into_owned(),
        verified_at: Utc::now().to_rfc3339(),
        files,
    };
    crate::lua_live::atomic_write_path(
        &output.join("receipt.json"),
        &serde_json::to_vec_pretty(&receipt).map_err(|_| "LUA_WORKSHOP_RECEIPT_INVALID")?,
    )?;
    Ok(receipt)
}
fn tool_arguments(appid: u32, item: &str, content: &Path) -> Vec<std::ffi::OsString> {
    [
        "-app".into(),
        appid.to_string().into(),
        "-pubfile".into(),
        item.into(),
        "-dir".into(),
        content.as_os_str().to_owned(),
        "-validate".into(),
        "-max-downloads".into(),
        "2".into(),
    ]
    .into()
}
fn inventory(root: &Path) -> Result<Vec<WorkshopFile>, String> {
    reject_reparse_ancestors(root)?;
    let mut pending = vec![root.to_path_buf()];
    let mut files = vec![];
    let mut total = 0_u64;
    while let Some(directory) = pending.pop() {
        reject_reparse_ancestors(&directory)?;
        for entry in fs::read_dir(directory).map_err(|_| "LUA_WORKSHOP_INVENTORY_FAILED")? {
            let path = entry.map_err(|_| "LUA_WORKSHOP_INVENTORY_FAILED")?.path();
            reject_reparse_ancestors(&path)?;
            let metadata =
                fs::symlink_metadata(&path).map_err(|_| "LUA_WORKSHOP_INVENTORY_FAILED")?;
            if metadata.is_dir() {
                if pending.len() > 20_000 {
                    return Err("LUA_WORKSHOP_TOO_MANY_FILES".into());
                }
                pending.push(path);
                continue;
            }
            if !metadata.is_file() {
                return Err("LUA_WORKSHOP_NON_REGULAR_FILE".into());
            }
            total = total
                .checked_add(metadata.len())
                .ok_or("LUA_WORKSHOP_CONTENT_TOO_LARGE")?;
            if total > MAX_CONTENT || files.len() >= 20_000 {
                return Err("LUA_WORKSHOP_CONTENT_TOO_LARGE".into());
            }
            let mut file = fs::File::open(&path).map_err(|_| "LUA_WORKSHOP_VERIFY_FAILED")?;
            let mut hash = Sha256::new();
            let count =
                std::io::copy(&mut file, &mut hash).map_err(|_| "LUA_WORKSHOP_VERIFY_FAILED")?;
            if count != metadata.len() {
                return Err("LUA_WORKSHOP_FILE_CHANGED".into());
            }
            files.push(WorkshopFile {
                relative_path: path
                    .strip_prefix(root)
                    .map_err(|_| "LUA_WORKSHOP_PATH_ESCAPE")?
                    .to_string_lossy()
                    .replace('\\', "/"),
                size_bytes: count,
                sha256: hex::encode(hash.finalize()),
            });
        }
    }
    files.sort_by(|a, b| a.relative_path.cmp(&b.relative_path));
    Ok(files)
}
fn read_owned_json(path: &Path) -> Result<Vec<u8>, String> {
    reject_reparse_ancestors(path)?;
    let metadata = fs::metadata(path).map_err(|_| "LUA_WORKSHOP_RECEIPT_READ_FAILED")?;
    if !metadata.is_file() || metadata.len() > 4 * 1024 * 1024 {
        return Err("LUA_WORKSHOP_RECEIPT_TOO_LARGE".into());
    }
    let mut bytes = Vec::new();
    fs::File::open(path)
        .map_err(|_| "LUA_WORKSHOP_RECEIPT_READ_FAILED")?
        .take(4 * 1024 * 1024 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "LUA_WORKSHOP_RECEIPT_READ_FAILED")?;
    if bytes.len() > 4 * 1024 * 1024 {
        return Err("LUA_WORKSHOP_RECEIPT_TOO_LARGE".into());
    }
    Ok(bytes)
}
#[tauri::command]
pub async fn lua_verify_workshop_receipt(
    app: AppHandle,
    appid: u32,
    published_file_id: String,
    task_id: String,
) -> Result<LuaWorkshopReceipt, String> {
    let settings = settings(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        validate_item_id(&published_file_id)?;
        if appid == 0 || Uuid::parse_str(&task_id).is_err() {
            return Err("LUA_WORKSHOP_INVALID_IDENTITY".into());
        }
        let output = Path::new(&settings.downloading_root)
            .join("lua-workshop")
            .join(appid.to_string())
            .join(&published_file_id)
            .join(&task_id);
        let receipt: LuaWorkshopReceipt =
            serde_json::from_slice(&read_owned_json(&output.join("receipt.json"))?)
                .map_err(|_| "LUA_WORKSHOP_RECEIPT_INVALID")?;
        if receipt.schema_version != 1
            || receipt.appid != appid
            || receipt.published_file_id != published_file_id
            || receipt.task_id != task_id
        {
            return Err("LUA_WORKSHOP_RECEIPT_IDENTITY_MISMATCH".into());
        }
        let content_root = if receipt
            .source
            .starts_with("userApprovedOfficialDepotDownloader:")
        {
            output.join("content")
        } else if receipt.source == "steamPublishedFilePublicUrl" {
            output.clone()
        } else {
            return Err("LUA_WORKSHOP_RECEIPT_SOURCE_INVALID".into());
        };
        if Path::new(&receipt.output_path) != content_root {
            return Err("LUA_WORKSHOP_RECEIPT_PATH_MISMATCH".into());
        }
        let actual = inventory(&content_root)?;
        for expected in &receipt.files {
            if !actual.iter().any(|file| {
                file.relative_path == expected.relative_path
                    && file.size_bytes == expected.size_bytes
                    && file.sha256 == expected.sha256
            }) {
                return Err("LUA_WORKSHOP_RECEIPT_DRIFTED".into());
            }
        }
        if receipt.files.is_empty() {
            return Err("LUA_WORKSHOP_RECEIPT_EMPTY".into());
        }
        Ok(receipt)
    })
    .await
    .map_err(|_| "LUA_WORKSHOP_WORKER_FAILED")?
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn ids_and_roots_are_confined() {
        for id in ["", "0", "01", "../2", "1/2", "18446744073709551616"] {
            assert!(validate_item_id(id).is_err());
        }
        assert_eq!(validate_item_id("1885082371").unwrap(), 1885082371);
        assert!(validate_root(Path::new("downloading")).is_err());
        assert!(validate_root(Path::new(r"C:\Steam\steamapps\downloading")).is_err());
    }
    #[test]
    fn content_urls_reject_insecure_or_arbitrary_hosts() {
        assert!(trusted_content_url(
            "https://steamusercontent-a.akamaihd.net/ugc/1"
        ));
        for url in [
            "http://steamusercontent.com/1",
            "https://steamusercontent.com.attacker.test/x",
            "https://127.0.0.1/x",
            "https://user:pass@steamusercontent.com/x",
        ] {
            assert!(!trusted_content_url(url));
        }
    }
    #[test]
    fn metadata_validates_identity_and_reports_unavailable_auth() {
        let bytes = br#"{"response":{"publishedfiledetails":[{"publishedfileid":"123","result":1,"consumer_app_id":480,"title":"Fixture","file_size":"40","time_updated":2,"file_url":""}]}}"#;
        let item = parse_details(bytes, "123").unwrap();
        assert_eq!(item.appid, 480);
        assert!(!item.download_available);
        assert_eq!(item.authentication, "requiredOrUgcAdapterNeeded");
        assert!(parse_details(bytes, "124").is_err());
    }

    #[test]
    fn authenticated_manifest_cannot_fall_back_to_anonymous_tool() {
        let account = Uuid::new_v4().to_string();
        let details = |url: &str, file_type: u32| {
            serde_json::from_value::<crate::lua_steam_auth::AuthenticatedDetails>(serde_json::json!({
            "schemaVersion":2,"requestId":"fixture","sequence":1,"kind":"details","steamId":"76561198000000001",
            "appid":4000,"itemId":"123","title":"Fixture","sizeBytes":42,"updatedAt":12345,"contentUrl":url,"manifestId":"12345","fileType":file_type
        })).unwrap()
        };
        let direct = authenticated_item(details("https://steamusercontent.com/file", 0), &account);
        assert!(direct.download_available);
        assert_eq!(
            direct.account_approval.as_ref().unwrap().account_id,
            account
        );
        assert!(!serde_json::to_string(&direct)
            .unwrap()
            .contains("https://steamusercontent.com/file"));
        assert!(
            !authenticated_item(details("https://steamusercontent.com/file", 2), &account)
                .download_available
        );
        let manifest = authenticated_item(details("", 0), &account);
        assert!(!manifest.download_available);
        let root = std::env::temp_dir()
            .join(format!("oxo-auth-route-{}", Uuid::new_v4()))
            .join("downloading");
        let settings = LuaWorkshopSettings {
            downloading_root: root.to_string_lossy().into_owned(),
            official_tool: Some(ApprovedWorkshopTool {
                executable_path: "never-run.exe".into(),
                sha256: "0".repeat(64),
                source_release_url: "invalid".into(),
                approved: true,
            }),
        };
        let result = download_resolved(
            &settings,
            4000,
            "123",
            &Uuid::new_v4().to_string(),
            &AtomicU8::new(0),
            &|_| Ok(()),
            manifest,
        );
        assert_eq!(
            result.unwrap_err(),
            "LUA_WORKSHOP_AUTHENTICATED_CDN_REQUIRED"
        );
        assert!(!root.exists(), "unsupported route must not create files");
        for approval in [
            WorkshopAccountApproval {
                account_id: "other".into(),
                updated_at: 1,
                expected_bytes: 42,
            },
            WorkshopAccountApproval {
                account_id: account,
                updated_at: 1,
                expected_bytes: MAX_CONTENT + 1,
            },
        ] {
            assert!(approval.validate().is_err());
        }
    }
    #[test]
    fn official_arguments_are_workshop_only_and_credential_free() {
        let tool = ApprovedWorkshopTool {
            executable_path: "DepotDownloader.exe".into(),
            sha256: "0".repeat(64),
            source_release_url:
                "https://github.com/SteamRE/DepotDownloader/releases/download/v3/tool.zip".into(),
            approved: false,
        };
        assert!(verify_tool(&tool).is_err());
        let args: Vec<_> = tool_arguments(480, "123", Path::new("fixture/content"))
            .iter()
            .map(|s| s.to_string_lossy().into_owned())
            .collect();
        assert_eq!(
            args,
            vec![
                "-app",
                "480",
                "-pubfile",
                "123",
                "-dir",
                "fixture/content",
                "-validate",
                "-max-downloads",
                "2"
            ]
        );
    }
    #[test]
    fn inventory_hashes_actual_files_and_rejects_hard_link_aliases() {
        let directory =
            std::env::temp_dir().join(format!("lua-workshop-inventory-{}", Uuid::new_v4()));
        fs::create_dir(&directory).unwrap();
        let file = directory.join("item.bin");
        fs::write(&file, b"verified workshop fixture").unwrap();
        let files = inventory(&directory).unwrap();
        assert_eq!(files.len(), 1);
        assert_eq!(
            files[0].sha256,
            hex::encode(Sha256::digest(b"verified workshop fixture"))
        );
        fs::write(&file, b"externally changed").unwrap();
        assert_ne!(files[0].sha256, inventory(&directory).unwrap()[0].sha256);
        let alias = directory.join("alias.bin");
        fs::hard_link(&file, &alias).unwrap();
        assert!(inventory(&directory).is_err());
        fs::remove_file(alias).unwrap();
        fs::remove_file(file).unwrap();
        fs::remove_dir(directory).unwrap();
    }
    /// Opt-in network evidence through the same service called by the Lua queue.
    /// The fixture is inert public Workshop data, never installed or executed.
    #[test]
    #[ignore = "requires explicit public Steam network access and retains isolated evidence"]
    fn live_public_workshop_download_resume_and_receipt() {
        assert_eq!(
            std::env::var("OXO_LUA_WORKSHOP_LIVE_TEST").as_deref(),
            Ok("1"),
            "Set OXO_LUA_WORKSHOP_LIVE_TEST=1 for this explicit network smoke"
        );
        const ITEM: &str = "212504882";
        const APPID: u32 = 4000;
        const SIZE: u64 = 7439;
        // Independently observed from Valve's public CDN, 2026-09-04; a remote
        // edit fails this fixture gate rather than silently testing new content.
        const SHA256: &str = "80791208f7906ddc8e3264f13921c44ff84197838cd6d9afbed3bcebb119e414";
        let workspace = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
        let cache = workspace.join("downloading");
        validate_root(&cache).unwrap();
        assert!(
            fs2::available_space(workspace).unwrap() >= 10 * 1024 * 1024 * 1024,
            "The live smoke preserves a 10 GiB free-space floor"
        );
        let evidence = cache
            .join("lua-workshop-test")
            .join(Uuid::new_v4().to_string());
        reject_reparse_ancestors(&evidence).unwrap();
        fs::create_dir_all(evidence.parent().unwrap()).unwrap();
        fs::create_dir(&evidence).unwrap();
        println!("Workshop smoke evidence: {}", evidence.display());
        let settings = LuaWorkshopSettings {
            downloading_root: evidence.join("downloading").to_string_lossy().into_owned(),
            official_tool: None,
        };
        let resolved = resolve(ITEM).expect("public Valve metadata must be reachable");
        assert_eq!(resolved.appid, APPID);
        assert_eq!(resolved.title, "TDM SHOWROOM");
        assert_eq!(resolved.size_bytes, SIZE);
        assert_eq!(resolved.updated_at, 1_388_861_671);
        assert_eq!(resolved.authentication, "notRequiredForPublicUrl");
        assert!(resolved.download_available);
        let task = Uuid::new_v4().to_string();
        let stop = AtomicU8::new(0);
        let report = |progress: f64| {
            assert!(progress.is_finite() && (0.0..1.0).contains(&progress));
            Ok(())
        };
        assert_eq!(
            download(&settings, APPID + 1, ITEM, &task, &stop, &report).unwrap_err(),
            "LUA_WORKSHOP_APPID_MISMATCH"
        );
        let receipt = download(&settings, APPID, ITEM, &task, &stop, &report)
            .expect("production public-URL download must complete");
        assert_eq!(receipt.source, "steamPublishedFilePublicUrl");
        assert_eq!(receipt.files.len(), 1);
        assert_eq!(receipt.files[0].size_bytes, SIZE);
        assert_eq!(receipt.files[0].sha256, SHA256);
        let completed = Path::new(&receipt.output_path).join("content.bin");
        assert!(completed.starts_with(&evidence));
        let bytes = fs::read(&completed).unwrap();
        assert_eq!(bytes.len() as u64, SIZE);
        assert_eq!(hex::encode(Sha256::digest(&bytes)), SHA256);
        let persisted: LuaWorkshopReceipt = serde_json::from_slice(
            &read_owned_json(&Path::new(&receipt.output_path).join("receipt.json")).unwrap(),
        )
        .unwrap();
        assert_eq!(persisted.task_id, task);
        assert_eq!(persisted.files[0].sha256, SHA256);
        let repeated = download(&settings, APPID, ITEM, &task, &stop, &report).unwrap();
        assert_eq!(repeated.files[0].sha256, SHA256);
        assert_eq!(fs::read(&completed).unwrap(), bytes);

        let resumed_task = Uuid::new_v4().to_string();
        stop.store(1, Ordering::SeqCst);
        assert_eq!(
            download(&settings, APPID, ITEM, &resumed_task, &stop, &report).unwrap_err(),
            "LUA_WORKSHOP_INTERRUPTED"
        );
        let partial = Path::new(&settings.downloading_root)
            .join("lua-workshop")
            .join(APPID.to_string())
            .join(ITEM)
            .join(&resumed_task)
            .join("content.part");
        assert!(partial.starts_with(&evidence));
        assert!(
            !partial.exists(),
            "cancelled admission must not create a partial"
        );
        let partial_root = partial.parent().unwrap();
        fs::create_dir_all(partial_root).unwrap();
        let identity = PartialIdentity {
            appid: APPID,
            item: ITEM.into(),
            updated: resolved.updated_at,
            expected: SIZE,
            url_hash: hex::encode(Sha256::digest(
                resolved.content_url.as_ref().unwrap().as_bytes(),
            )),
        };
        crate::lua_live::atomic_write_path(
            &partial_root.join("partial-identity.json"),
            &serde_json::to_vec(&identity).unwrap(),
        )
        .unwrap();
        // Seed an exact known prefix of this test-owned file to exercise a real
        // HTTP Range/Content-Range resume, not a timing-dependent interruption.
        let mut seed = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&partial)
            .unwrap();
        seed.write_all(&bytes[..128]).unwrap();
        seed.sync_all().unwrap();
        drop(seed);
        stop.store(0, Ordering::SeqCst);
        let resumed = download(&settings, APPID, ITEM, &resumed_task, &stop, &report)
            .expect("the public CDN must honor the exact resume range");
        assert_eq!(resumed.files[0].sha256, SHA256);
        assert!(!partial.exists());
        let evidence_json = serde_json::json!({
            "schemaVersion": 1,
            "observedAt": Utc::now().to_rfc3339(),
            "productionSeam": "lua_workshop::download",
            "metadata": resolved,
            "receipt": receipt,
            "resumeReceipt": resumed,
            "rangePrefixBytes": 128,
            "checks": ["publicMetadata", "wrongAppIdRejected", "publicDownload", "exactFixtureSha256", "persistedReceipt", "repeatDownload", "cancellation", "seededPrefixRealHttpRangeResume"],
            "steamOrGameModified": false,
            "externalToolExecuted": false,
            "tauriQueueUiTested": false,
            "authenticatedWorkshopTested": false
        });
        let evidence_bytes = serde_json::to_vec_pretty(&evidence_json).unwrap();
        let mut evidence_file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(evidence.join("evidence.json"))
            .unwrap();
        evidence_file.write_all(&evidence_bytes).unwrap();
        evidence_file.sync_all().unwrap();
        // Preserve exact-owned content and receipts as evidence; no cleanup.
    }
}
