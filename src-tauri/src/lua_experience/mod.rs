//! Lua Shop metadata only. This module never installs games or selects Lua/GSE providers.
mod metadata;
pub(crate) mod native;
mod store;

pub use metadata::{LuaImageBlob, LuaMetadataResult};
pub use store::LuaCacheHealth;

use metadata::MetadataService;
use std::sync::{Arc, Mutex, OnceLock};
use tauri::Manager;

fn service(app: &tauri::AppHandle) -> Result<Arc<MetadataService>, String> {
    static SERVICE: OnceLock<Mutex<Option<Arc<MetadataService>>>> = OnceLock::new();
    let root = app
        .path()
        .app_cache_dir()
        .map_err(|_| "LUA_CACHE_PATH")?
        .join("lua_shop");
    let mut slot = SERVICE
        .get_or_init(|| Mutex::new(None))
        .lock()
        .map_err(|_| "LUA_CACHE_LOCK")?;
    if let Some(service) = slot.as_ref() {
        if service.root() != root {
            return Err("LUA_CACHE_ROOT_CHANGED".into());
        }
        return Ok(service.clone());
    }
    let packaged = native_resource_root(app)?;
    let service =
        Arc::new(MetadataService::open(root)?.with_native(native::NativeBridge::new(packaged)));
    *slot = Some(service.clone());
    Ok(service)
}

pub(crate) fn native_resource_root(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    let resource_root = app
        .path()
        .resource_dir()
        .map_err(|_| "LUA_STEAMKIT_RESOURCE_PATH")?;
    let packaged = resource_root.join("resources/lua-steamkit");
    #[cfg(debug_assertions)]
    let packaged = if packaged.exists() {
        packaged
    } else {
        std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources/lua-steamkit")
    };
    Ok(packaged)
}

#[tauri::command]
pub async fn lua_get_metadata(
    app: tauri::AppHandle,
    appid: u32,
    locale: String,
    refresh: bool,
) -> Result<LuaMetadataResult, String> {
    tauri::async_runtime::spawn_blocking(move || service(&app)?.get(appid, &locale, refresh, false))
        .await
        .map_err(|_| "LUA_METADATA_TASK")?
}

/// Card previews only consult Store metadata, avoiding three upstream calls per card.
#[tauri::command]
pub async fn lua_get_basic_metadata(
    app: tauri::AppHandle,
    appid: u32,
    locale: String,
) -> Result<LuaMetadataResult, String> {
    tauri::async_runtime::spawn_blocking(move || service(&app)?.get(appid, &locale, false, true))
        .await
        .map_err(|_| "LUA_METADATA_TASK")?
}

#[tauri::command]
pub async fn lua_get_cache_health(app: tauri::AppHandle) -> Result<LuaCacheHealth, String> {
    tauri::async_runtime::spawn_blocking(move || service(&app)?.health())
        .await
        .map_err(|_| "LUA_CACHE_TASK")?
}

#[tauri::command]
pub async fn lua_cache_image(app: tauri::AppHandle, url: String) -> Result<LuaImageBlob, String> {
    tauri::async_runtime::spawn_blocking(move || service(&app)?.image(&url))
        .await
        .map_err(|_| "LUA_IMAGE_TASK")?
}
