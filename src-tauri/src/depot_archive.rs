use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    fs,
    path::{Path, PathBuf},
    time::Duration,
};
use tauri::AppHandle;

const BASE: &str = "https://zeroxolemon-launcher.onrender.com/api/0xolemon/lua-shop/archive";
fn client() -> Result<reqwest::blocking::Client, String> {
    reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(65))
        .build()
        .map_err(|e| e.to_string())
}
fn id(value: &str) -> Result<(), String> {
    if value.len() == 64 && value.bytes().all(|b| b.is_ascii_hexdigit()) {
        Ok(())
    } else {
        Err("INVALID_CANDIDATE_ID".into())
    }
}
fn root() -> Result<PathBuf, String> {
    let root = PathBuf::from(crate::platform::current_settings().default_library)
        .join("downloading")
        .join("depot-archive");
    // Refuse link/reparse ancestors before creating any owned staging files.
    for parent in root.ancestors() {
        if let Ok(meta) = fs::symlink_metadata(parent) {
            if meta.file_type().is_symlink() {
                return Err("ARCHIVE_REPARSE_POINT".into());
            }
            #[cfg(windows)]
            {
                use std::os::windows::fs::MetadataExt;
                if meta.file_attributes() & 0x400 != 0 {
                    return Err("ARCHIVE_REPARSE_POINT".into());
                }
            }
        }
    }
    fs::create_dir_all(&root).map_err(|e| e.to_string())?;
    Ok(root)
}
fn response(value: reqwest::blocking::Response) -> Result<Value, String> {
    let status = value.status();
    if !status.is_success() {
        return Err(format!("ARCHIVE_HTTP_{}", status.as_u16()));
    }
    value.json().map_err(|_| "ARCHIVE_INVALID_RESPONSE".into())
}
fn owned_bytes(path: &Path, maximum: u64) -> Result<Vec<u8>, String> {
    let meta = fs::symlink_metadata(path).map_err(|e| e.to_string())?;
    if !meta.is_file() || meta.file_type().is_symlink() || meta.len() > maximum {
        return Err("ARCHIVE_UNSAFE_FILE".into());
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if meta.file_attributes() & 0x400 != 0 {
            return Err("ARCHIVE_REPARSE_POINT".into());
        }
    }
    fs::read(path).map_err(|e| e.to_string())
}

pub(crate) fn enqueue(
    app: &AppHandle,
    package: &crate::lua_sources::CanonicalPackage,
) -> Result<(), String> {
    if package.provider != crate::lua_sources::LuaPackageProvider::Hubcap
        || package.manifests.is_empty()
    {
        return Ok(());
    }
    let root = root()?;
    if root.join("disabled").exists() {
        return Ok(());
    }
    // Only declarations required by the depot archive may leave this machine.
    // Unrecognized executable Lua is never evaluated or contributed.
    let sensitive = regex::Regex::new(
        r"(?i)(addtoken|setappticket|seteticket|setstat|password|steamid|7656119\d{10})",
    )
    .map_err(|e| e.to_string())?;
    let clean: String = package
        .canonical_lua
        .split_inclusive('\n')
        .filter(|line| !sensitive.is_match(line))
        .collect();
    let bytes = crate::lua_sources::build_canonical_archive(
        package.appid,
        package.provider,
        &clean,
        &package.manifests,
    )?;
    let candidate_id = format!("{:x}", Sha256::digest(&bytes));
    let path = root.join(format!("{candidate_id}.zip"));
    if !path.exists() {
        crate::lua_live::atomic_write_path(&path, &bytes)?;
    }
    let receipt = json!({ "candidateId": candidate_id, "appId": package.appid, "state": "queued", "sha256": candidate_id });
    let receipt_path = root.join(format!("{candidate_id}.json"));
    if !receipt_path.exists() {
        crate::lua_live::atomic_write_path(
            &receipt_path,
            &serde_json::to_vec(&receipt).map_err(|e| e.to_string())?,
        )?;
    }
    let app = app.clone();
    std::thread::spawn(move || {
        let _ = submit(&app, &candidate_id);
    });
    Ok(())
}
fn submit(app: &AppHandle, candidate_id: &str) -> Result<Value, String> {
    id(candidate_id)?;
    let root = root()?;
    if root.join("disabled").exists() {
        return Err("ARCHIVE_CONTRIBUTION_DISABLED".into());
    }
    let path = root.join(format!("{candidate_id}.json"));
    let mut receipt: Value =
        serde_json::from_slice(&owned_bytes(&path, 64 * 1024)?).map_err(|e| e.to_string())?;
    if receipt["state"] != "queued" {
        return Ok(receipt);
    }
    let package_path = root.join(format!("{candidate_id}.zip"));
    let bytes = owned_bytes(&package_path, 128 * 1024 * 1024)?;
    if format!("{:x}", Sha256::digest(&bytes)) != candidate_id {
        return Err("ARCHIVE_HASH_MISMATCH".into());
    }
    let token = crate::discord_auth::access_token_for_backend(app)?;
    let result = response(
        client()?
            .post(format!("{BASE}/candidates"))
            .bearer_auth(token)
            .header("Content-Type", "application/zip")
            .header("X-App-Id", receipt["appId"].to_string())
            .header("X-Content-Sha256", candidate_id)
            .body(bytes)
            .send()
            .map_err(|_| "ARCHIVE_NETWORK_ERROR")?,
    )?;
    receipt["state"] = result["state"].clone();
    receipt["serverCandidateId"] = result["candidateId"].clone();
    crate::lua_live::atomic_write_path(
        &path,
        &serde_json::to_vec(&receipt).map_err(|e| e.to_string())?,
    )?;
    Ok(receipt)
}

#[tauri::command]
pub async fn get_depot_steam_snapshot(app_id: u32) -> Result<Value, String> {
    if app_id == 0 {
        return Err("INVALID_APP_ID".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        // 1. Try GitHub CDN (fast, free, no rate-limit) — same shard pattern as depot_downloader
        let shard = app_id % 1000;
        let cdn_urls = [
            format!("https://raw.githubusercontent.com/isagi3097-cell/steam-metadata/main/data/{:03}/{}.json", shard, app_id),
            format!("https://cdn.jsdelivr.net/gh/isagi3097-cell/steam-metadata@main/data/{:03}/{}.json", shard, app_id),
        ];
        for cdn_url in &cdn_urls {
            if let Ok(resp) = client()?.get(cdn_url).send() {
                if resp.status().is_success() {
                    if let Ok(json_val) = resp.json::<Value>() {
                        if json_val.get("depots").map(|d| d.is_object()).unwrap_or(false) {
                            let title = json_val.get("common").and_then(|c| c.get("name")).and_then(|n| n.as_str()).unwrap_or("Unknown").to_string();
                            return Ok(json!({
                                "appId": app_id,
                                "title": title,
                                "source": "github_cdn",
                                "observedAt": chrono::Utc::now().timestamp_millis(),
                                "appinfo": { "data": { app_id.to_string(): json_val } }
                            }));
                        }
                    }
                }
            }
        }
        // 2. Fallback: live steamcmd.net
        let raw = response(client()?.get(format!("https://api.steamcmd.net/v1/info/{app_id}")).send().map_err(|_| "STEAM_NETWORK_ERROR")?)?;
        let info = &raw["data"][app_id.to_string()];
        if !info["depots"].is_object() { return Err("STEAM_APPINFO_INVALID".into()); }
        Ok(json!({ "appId": app_id, "title": info["common"]["name"], "source": "steamcmd_live", "observedAt": chrono::Utc::now().timestamp_millis(), "appinfo": raw }))
    }).await.map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn list_depot_archive_versions(app_id: u32) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        response(
            client()?
                .get(format!("{BASE}/apps/{app_id}"))
                .send()
                .map_err(|_| "ARCHIVE_NETWORK_ERROR")?,
        )
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn get_depot_archive_build(app_id: u32, build_id: String) -> Result<Value, String> {
    if build_id.parse::<u64>().ok().filter(|v| *v > 0).is_none() {
        return Err("INVALID_BUILD_ID".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        response(
            client()?
                .get(format!("{BASE}/apps/{app_id}/builds/{build_id}"))
                .send()
                .map_err(|_| "ARCHIVE_NETWORK_ERROR")?,
        )
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn cache_depot_archive_build(app_id: u32, build_id: String) -> Result<Value, String> {
    if app_id == 0 || build_id.parse::<u64>().ok().filter(|v| *v > 0).is_none() {
        return Err("INVALID_BUILD_ID".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let info = response(
            client()?
                .get(format!("{BASE}/apps/{app_id}/builds/{build_id}"))
                .send()
                .map_err(|_| "ARCHIVE_NETWORK_ERROR")?,
        )?;
        let package = &info["package"];
        let expected = package["sha256"]
            .as_str()
            .ok_or("ARCHIVE_PACKAGE_UNVERIFIED")?;
        id(expected)?;
        let size = package["sizeBytes"]
            .as_u64()
            .filter(|s| *s > 0 && *s <= 128 * 1024 * 1024)
            .ok_or("ARCHIVE_SIZE_LIMIT")?;
        let url = reqwest::Url::parse(
            package["url"]
                .as_str()
                .ok_or("ARCHIVE_PACKAGE_UNAVAILABLE")?,
        )
        .map_err(|_| "ARCHIVE_INVALID_URL")?;
        if url.scheme() != "https"
            || url.host_str() != Some("huggingface.co")
            || !url.path().starts_with("/datasets/Immaking/Luas/resolve/")
            || url.username() != ""
            || url.password().is_some()
        {
            return Err("ARCHIVE_INVALID_URL".into());
        }
        let path = root()?.join(format!("build-{app_id}-{build_id}-{expected}.zip"));
        if path.exists() {
            let bytes = owned_bytes(&path, size)?;
            if bytes.len() as u64 != size || format!("{:x}", Sha256::digest(&bytes)) != expected {
                return Err("ARCHIVE_CACHE_HASH_MISMATCH".into());
            }
            return Ok(json!({ "source": "localCache", "path": path, "sha256": expected }));
        }
        let mut download = client()?
            .get(url)
            .send()
            .map_err(|_| "ARCHIVE_NETWORK_ERROR")?;
        if !download.status().is_success() {
            return Err(format!("ARCHIVE_HTTP_{}", download.status().as_u16()));
        }
        let mut bytes = Vec::new();
        use std::io::Read;
        (&mut download)
            .take(size + 1)
            .read_to_end(&mut bytes)
            .map_err(|_| "ARCHIVE_DOWNLOAD_FAILED")?;
        if bytes.len() as u64 != size || format!("{:x}", Sha256::digest(&bytes)) != expected {
            return Err("ARCHIVE_HASH_MISMATCH".into());
        }
        crate::lua_live::atomic_write_path(&path, &bytes)?;
        Ok(json!({ "source": "0xoLemonArchive", "path": path, "sha256": expected }))
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn prepare_depot_archive_candidate(candidate_id: String) -> Result<Value, String> {
    id(&candidate_id)?;
    tauri::async_runtime::spawn_blocking(move || {
        serde_json::from_slice(&owned_bytes(
            &root()?.join(format!("{candidate_id}.json")),
            64 * 1024,
        )?)
        .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn resolve_depot_package_build(
    app: AppHandle,
    candidate_id: String,
) -> Result<Value, String> {
    id(&candidate_id)?;
    tauri::async_runtime::spawn_blocking(move || {
        let root = root()?;
        let receipt: Value = serde_json::from_slice(&owned_bytes(
            &root.join(format!("{candidate_id}.json")),
            64 * 1024,
        )?)
        .map_err(|e| e.to_string())?;
        let bytes = owned_bytes(&root.join(format!("{candidate_id}.zip")), 128 * 1024 * 1024)?;
        if format!("{:x}", Sha256::digest(&bytes)) != candidate_id {
            return Err("ARCHIVE_HASH_MISMATCH".into());
        }
        let token = crate::discord_auth::access_token_for_backend(&app)?;
        response(
            client()?
                .post(format!("{BASE}/resolve"))
                .bearer_auth(token)
                .header("Content-Type", "application/zip")
                .header("X-App-Id", receipt["appId"].to_string())
                .header("X-Content-Sha256", candidate_id)
                .body(bytes)
                .send()
                .map_err(|_| "ARCHIVE_NETWORK_ERROR")?,
        )
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn submit_depot_archive_candidate(
    app: AppHandle,
    candidate_id: String,
) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || submit(&app, &candidate_id))
        .await
        .map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn get_depot_archive_candidate_status(
    app: AppHandle,
    candidate_id: String,
) -> Result<Value, String> {
    id(&candidate_id)?;
    tauri::async_runtime::spawn_blocking(move || {
        let path = root()?.join(format!("{candidate_id}.json"));
        let mut receipt: Value =
            serde_json::from_slice(&owned_bytes(&path, 64 * 1024)?).map_err(|e| e.to_string())?;
        let server_id = receipt["serverCandidateId"]
            .as_str()
            .ok_or("ARCHIVE_NOT_SUBMITTED")?;
        id(server_id)?;
        let token = crate::discord_auth::access_token_for_backend(&app)?;
        let latest = response(
            client()?
                .get(format!("{BASE}/candidates/{server_id}"))
                .bearer_auth(token)
                .send()
                .map_err(|_| "ARCHIVE_NETWORK_ERROR")?,
        )?;
        if latest["appId"] != receipt["appId"] {
            return Err("ARCHIVE_APPID_MISMATCH".into());
        }
        receipt["state"] = latest["state"].clone();
        crate::lua_live::atomic_write_path(
            &path,
            &serde_json::to_vec(&receipt).map_err(|e| e.to_string())?,
        )?;
        Ok(receipt)
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn get_depot_archive_outbox() -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let root = root()?;
        let mut receipts = Vec::new();
        for entry in fs::read_dir(&root).map_err(|e| e.to_string())?.take(1000) {
            let entry = entry.map_err(|e| e.to_string())?;
            if entry.path().extension().and_then(|s| s.to_str()) != Some("json")
                || !entry.file_type().map_err(|e| e.to_string())?.is_file()
            {
                continue;
            }
            if let Ok(bytes) = owned_bytes(&entry.path(), 64 * 1024) {
                if let Ok(value) = serde_json::from_slice::<Value>(&bytes) {
                    receipts.push(value);
                }
            }
        }
        Ok(json!({ "enabled": !root.join("disabled").exists(), "receipts": receipts }))
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn set_depot_archive_enabled(enabled: bool) -> Result<(), String> {
    let path = root()?.join("disabled");
    if enabled {
        if path.exists() {
            fs::remove_file(path).map_err(|e| e.to_string())?;
        }
    } else {
        crate::lua_live::atomic_write_path(&path, b"disabled")?;
    }
    Ok(())
}
