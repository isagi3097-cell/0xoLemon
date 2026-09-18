// bypass_fix.rs — Bypass/Fix downloader from PROBBI/PROBBINE HuggingFace dataset

use reqwest::blocking::Client;
use reqwest::header::{HeaderMap, HeaderValue, AUTHORIZATION};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fs;
use std::io::{Read, Write};
use std::path::Path;
use std::time::Duration;
use tauri::command;

const PROBBI_REPO: &str = "PROBBI/PROBBINE";
const HF_API_BASE: &str = "https://huggingface.co/api/datasets";
const HF_DL_BASE: &str = "https://huggingface.co/datasets";
const BYPASS_PASS: &str = "0xoLemon.dll";
const BYPASS_FOLDER: &str = "Bypass-fix"; // subfolder inside the dataset root
const EMPRESS_LIST_URL: &str = "https://emptools-fixes.walkerrexe.workers.dev/list";

/// One fix file entry from the Empress catalog (`/list` endpoint).
#[derive(Debug, Deserialize, Clone)]
struct EmpressFix {
    href: String,
    filename: String,
    #[allow(dead_code)]
    size: String,
    #[serde(default)]
    badges: Vec<String>,
}

/// One game entry returned by the Empress catalog endpoint.
#[derive(Debug, Deserialize, Clone)]
struct EmpressGame {
    appid: String,
    name: String,
    #[serde(default)]
    fixes: Vec<EmpressFix>,
}

fn fetch_empress_list(client: &Client) -> Result<Vec<EmpressGame>, String> {
    client
        .get(EMPRESS_LIST_URL)
        .send()
        .and_then(|r| r.json::<Vec<EmpressGame>>())
        .map_err(|e| format!("Empress catalog: {e}"))
}

fn display_bypass_tag(filename: &str) -> String {
    let lower = filename.to_ascii_lowercase();
    if lower.starts_with("online-fix") || lower.starts_with("online_fix") || lower.starts_with("onlinefix") {
        return "online-fix".to_string();
    }
    let s = filename
        .strip_suffix(".7z")
        .unwrap_or(filename)
        .strip_suffix(".dll")
        .unwrap_or_else(|| filename.strip_suffix(".7z").unwrap_or(filename));
    s.to_string()
}

fn get_probbi_token() -> String {
    let json_str = include_str!("../huggingface-repos.json");
    let config: serde_json::Value = serde_json::from_str(json_str).unwrap_or_default();
    config["repositories"]
        .as_array()
        .unwrap_or(&vec![])
        .iter()
        .find(|r| r["repoId"].as_str() == Some(PROBBI_REPO))
        .and_then(|r| r["token"].as_str())
        .unwrap_or("")
        .to_string()
}

fn build_client() -> Result<Client, String> {
    Client::builder()
        .user_agent("0xoLemon-Launcher/2.0 (Windows NT 10.0; Win64; x64)")
        .redirect(reqwest::redirect::Policy::limited(10))
        .timeout(Duration::from_secs(60))
        .build()
        .map_err(|e| format!("HTTP client: {e}"))
}

fn auth_headers(token: &str) -> HeaderMap {
    let mut h = HeaderMap::new();
    if !token.is_empty() {
        if let Ok(v) = HeaderValue::from_str(&format!("Bearer {token}")) {
            h.insert(AUTHORIZATION, v);
        }
    }
    h
}

#[derive(Debug, Deserialize)]
struct HfTreeEntry {
    #[serde(rename = "type")]
    entry_type: String,
    path: String,
}

#[derive(Debug, Serialize, Clone)]
pub struct BypassTag {
    pub tag: String,
    pub filename: String,
    /// Direct download URL — only set for empress fixes (generator.ryuu.lol).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub href: Option<String>,
}

#[derive(Debug, Serialize, Clone)]
pub struct BypassBuild {
    pub buildid: String,
    pub tags: Vec<BypassTag>,
}

#[derive(Debug, Serialize, Clone)]
pub struct BypassAppInfo {
    pub appid: String,
    pub build_count: usize,
    pub latest_buildid: String,
    pub all_tags: Vec<String>,
    #[serde(default)]
    pub provider: String,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub header_image: Option<String>,
}

#[derive(Debug, Deserialize)]
struct LuaToolsListingResponse {
    games: Vec<LuaToolsGame>,
}

#[derive(Debug, Deserialize)]
struct LuaToolsGame {
    appid: String,
    name: String,
    header_image: Option<String>,
    #[serde(rename = "fixCount")]
    fix_count: usize,
    tags: Vec<LuaToolsTag>,
}

#[derive(Debug, Deserialize)]
struct LuaToolsTag {
    name: String,
}

#[derive(Debug, Deserialize)]
struct LuaToolsFixResponse {
    fixes: Vec<LuaToolsFix>,
}

#[derive(Debug, Deserialize)]
struct LuaToolsFix {
    id: String,
    #[serde(rename = "title")]
    _title: String,
    #[serde(default)]
    tags: Vec<LuaToolsTag>,
    #[serde(rename = "fixFilename")]
    fix_filename: Option<String>,
}

#[derive(Debug, Serialize, Clone)]
pub struct BypassProgressPayload {
    pub game_id: String,
    pub stage: String,
    pub downloaded_bytes: u64,
    pub total_bytes: u64,
    pub percent: f64,
    pub speed_bps: u64,
    pub message: String,
}

fn emit_progress(app: &tauri::AppHandle, payload: BypassProgressPayload) {
    let _ = tauri::Emitter::emit(app, "bypass-progress", payload);
}

#[derive(Debug, Serialize, Deserialize, Clone)]
struct BypassInstallManifest {
    game_id: String,
    installed_files: Vec<String>,
    backed_up_files: Vec<String>,
    installed_at: String,
}

#[command]
pub fn get_bypass_status(
    app: tauri::AppHandle,
    game_id: String,
    custom_path: Option<String>,
) -> Result<bool, String> {
    let path = crate::translations::resolve_effective_path(&app, &game_id, custom_path.as_deref());
    Ok(path.is_ok_and(|root| root.join(".0xolemon_bypass").join("manifest.json").is_file()))
}

#[command]
pub async fn install_bypass_fix(
    app: tauri::AppHandle,
    game_id: String,
    appid: String,
    buildid: String,
    tag: String,
    filename: Option<String>,
    custom_path: Option<String>,
) -> Result<(), String> {
    let install_path = crate::translations::resolve_effective_path(&app, &game_id, custom_path.as_deref())
        .map_err(|e| format!("Không tìm thấy thư mục cài đặt game: {e}"))?;
    let token = get_probbi_token();
    let client = build_client()?;
    let file_name = filename.unwrap_or_else(|| {
        if tag.to_ascii_lowercase().contains("online-fix") {
            "online-fix.7z".to_string()
        } else {
            format!("{tag}.7z")
        }
    });
    let url = if buildid == "Latest" {
        format!("{HF_DL_BASE}/{PROBBI_REPO}/resolve/main/{BYPASS_FOLDER}/{appid}/{file_name}")
    } else {
        format!("{HF_DL_BASE}/{PROBBI_REPO}/resolve/main/{BYPASS_FOLDER}/{appid}/{buildid}/{file_name}")
    };
    let mut req = client.get(&url);
    if !token.is_empty() {
        req = req.header(AUTHORIZATION, format!("Bearer {token}"));
    }
    let app_for_download = app.clone();
    let game_for_download = game_id.clone();
    let temp = tauri::async_runtime::spawn_blocking(move || -> Result<std::path::PathBuf, String> {
        emit_progress(&app_for_download, BypassProgressPayload {
            game_id: game_for_download.clone(), stage: "downloading".into(), downloaded_bytes: 0,
            total_bytes: 0, percent: 0.0, speed_bps: 0, message: "Đang tải bản bypass...".into(),
        });
        let mut response = req.send().map_err(|e| format!("Lỗi kết nối: {e}"))?;
        if !response.status().is_success() {
            return Err(format!("Máy chủ phản hồi HTTP {}", response.status()));
        }
        let total_bytes = response.content_length().unwrap_or(0);
        let path = std::env::temp_dir().join(format!("bypass_{appid}_{buildid}_{tag}.7z"));
        let mut temp_file = fs::File::create(&path).map_err(|e| format!("Không thể tạo file tạm: {e}"))?;
        let mut buffer = [0_u8; 64 * 1024];
        let started = std::time::Instant::now();
        let mut last_emit = started;
        let mut downloaded = 0_u64;
        let mut last_downloaded = 0_u64;
        let mut last_speed_at = started;
        loop {
            let read = response.read(&mut buffer).map_err(|e| format!("Không đọc được archive: {e}"))?;
            if read == 0 { break; }
            temp_file.write_all(&buffer[..read]).map_err(|e| format!("Không ghi được archive tạm: {e}"))?;
            downloaded += read as u64;
            if last_emit.elapsed() >= Duration::from_millis(250) {
                let elapsed = last_speed_at.elapsed().as_secs_f64().max(0.001);
                let speed = ((downloaded - last_downloaded) as f64 / elapsed) as u64;
                emit_progress(&app_for_download, BypassProgressPayload {
                    game_id: game_for_download.clone(), stage: "downloading".into(),
                    downloaded_bytes: downloaded, total_bytes, percent: if total_bytes > 0 { downloaded as f64 * 100.0 / total_bytes as f64 } else { 0.0 },
                    speed_bps: speed, message: "Đang tải bản bypass...".into(),
                });
                last_emit = std::time::Instant::now();
                last_downloaded = downloaded;
                last_speed_at = std::time::Instant::now();
            }
        }
        temp_file.flush().map_err(|e| format!("Không hoàn tất archive tạm: {e}"))?;
        let speed = if downloaded > last_downloaded {
            ((downloaded - last_downloaded) as f64 / last_speed_at.elapsed().as_secs_f64().max(0.001)) as u64
        } else {
            (downloaded as f64 / started.elapsed().as_secs_f64().max(0.001)) as u64
        };
        emit_progress(&app_for_download, BypassProgressPayload {
            game_id: game_for_download.clone(), stage: "downloading".into(),
            downloaded_bytes: downloaded, total_bytes, percent: if total_bytes > 0 { 100.0 } else { 0.0 },
            speed_bps: speed, message: "Đã tải xong archive bypass, đang chuẩn bị backup...".into(),
        });
        emit_progress(&app_for_download, BypassProgressPayload {
            game_id: game_for_download, stage: "backing_up".into(), downloaded_bytes: downloaded,
            total_bytes, percent: 100.0, speed_bps: speed,
            message: "Đang chuẩn bị backup file game...".into(),
        });
        Ok(path)
    }).await.map_err(|e| e.to_string())??;

    let app_for_extract = app.clone();
    let game_for_extract = game_id.clone();
    tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
        let backup_root = install_path.join(".0xolemon_bypass");
        let backup_files = backup_root.join("files");
        if backup_root.exists() {
            return Err("Đã có backup của một bản bypass đang cài hoặc dở dang. Gỡ bản hiện tại trước khi cài lại.".into());
        }
        fs::create_dir_all(&backup_files).map_err(|e| e.to_string())?;
        let mut installed_files = Vec::new();
        let mut backed_up_files = Vec::new();
        emit_progress(&app_for_extract, BypassProgressPayload {
            game_id: game_for_extract.clone(), stage: "extracting".into(), downloaded_bytes: 0,
            total_bytes: 0, percent: 100.0, speed_bps: 0, message: "Đang giải nén bản bypass...".into(),
        });
        let file = fs::File::open(&temp).map_err(|e| e.to_string())?;
        let extraction_result = sevenz_rust::decompress_with_extract_fn_and_password(
            file, &install_path, BYPASS_PASS.into(),
            |entry, reader, dest| {
                if !entry.is_directory() {
                    let relative = entry.name().to_string();
                    let target = install_path.join(&relative);
                    if target.exists() {
                        let backup = backup_files.join(&relative);
                        if let Some(parent) = backup.parent() {
                            fs::create_dir_all(parent).map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, format!("Không thể tạo thư mục backup {}: {e}", relative)))?;
                        }
                        fs::copy(&target, &backup).map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, format!("Không thể backup {}: {e}", relative)))?;
                        backed_up_files.push(relative.clone());
                    }
                    installed_files.push(relative);
                }
                sevenz_rust::default_entry_extract_fn(entry, reader, dest)
            },
        );
        if let Err(error) = extraction_result {
            for relative in &installed_files {
                let target = install_path.join(relative);
                let backup = backup_files.join(relative);
                if backup.is_file() {
                    let _ = fs::copy(&backup, &target);
                } else if target.is_file() {
                    let _ = fs::remove_file(&target);
                }
            }
            let _ = fs::remove_dir_all(&backup_root);
            let _ = fs::remove_file(&temp);
            return Err(format!("Giải nén bypass thất bại: {error}"));
        }
        let manifest = BypassInstallManifest {
            game_id: game_for_extract.clone(), installed_files, backed_up_files,
            installed_at: chrono::Utc::now().to_rfc3339(),
        };
        fs::write(backup_root.join("manifest.json"), serde_json::to_vec_pretty(&manifest).map_err(|e| e.to_string())?)
            .map_err(|e| e.to_string())?;
        let _ = fs::remove_file(&temp);
        emit_progress(&app_for_extract, BypassProgressPayload {
            game_id: game_for_extract, stage: "finished".into(), downloaded_bytes: 0,
            total_bytes: 0, percent: 100.0, speed_bps: 0, message: "Cài đặt bypass thành công!".into(),
        });
        Ok(())
    }).await.map_err(|e| e.to_string())??;
    Ok(())
}

#[command]
pub async fn install_lua_tools_fix(
    app: tauri::AppHandle,
    game_id: String,
    appid: String,
    fix_id: String,
    custom_path: Option<String>,
) -> Result<(), String> {
    let install_path = crate::translations::resolve_effective_path(&app, &game_id, custom_path.as_deref())
        .map_err(|e| format!("Không tìm thấy thư mục cài đặt game: {e}"))?;
    let client = build_client()?;
    // LuaTools fixes belong to the LuaTools (lua.tools) account, not the launcher's own
    // 0xoLemon Discord gate. Two very different things:
    //   * the launcher gate  (discord_auth.rs)           = 0xoLemon Discord, decides who
    //                                                      may use the launcher at all.
    //   * the LuaTools session (lua_sources.rs, Supabase OAuth on db.lua.tools) = the
    //                                                      account that may download fixes.
    // Only the signed-in LuaTools session has access to the `/api/denuvo/download`
    // endpoint, so we send that bearer token and never fall back to the launcher's.
    let token = crate::lua_sources::luatools_access_token_if_present(&app, &client)?;
    let Some(token) = token else {
        // Never auto-open a browser from an install action: installing with no LuaTools
        // session must fail with a clear, actionable error so the UI can prompt the user.
        return Err("LUATOOLS_AUTH_REQUIRED".to_string());
    };
    let response = client
        .get(format!("https://lua.tools/api/denuvo/download?fix={}&slot=fix", urlencoding::encode(&fix_id)))
        .bearer_auth(token)
        .send()
        .map_err(|e| format!("LuaTools download: {e}"))?;
    if response.status() == reqwest::StatusCode::UNAUTHORIZED
        || response.status() == reqwest::StatusCode::FORBIDDEN
    {
        // The stored LuaTools session is stale/revoked — force a fresh Discord sign-in.
        crate::lua_sources::clear_luatools_session(&app);
        return Err("LUATOOLS_AUTH_REQUIRED".to_string());
    }
    if !response.status().is_success() {
        return Err(format!("LuaTools trả về HTTP {}.", response.status()));
    }
    let signed: serde_json::Value = response.json().map_err(|e| format!("LuaTools response: {e}"))?;
    let signed_url = signed["url"].as_str().filter(|url| !url.is_empty())
        .ok_or_else(|| "LuaTools không trả về signed download URL".to_string())?.to_string();

    let app_for_download = app.clone();
    let game_for_download = game_id.clone();
    let temp = tauri::async_runtime::spawn_blocking(move || -> Result<std::path::PathBuf, String> {
        emit_progress(&app_for_download, BypassProgressPayload {
            game_id: game_for_download.clone(), stage: "downloading".into(), downloaded_bytes: 0,
            total_bytes: 0, percent: 0.0, speed_bps: 0, message: "Đang tải LuaTools fix...".into(),
        });
        let mut response = client.get(signed_url).send().map_err(|e| format!("Lỗi tải LuaTools fix: {e}"))?;
        if !response.status().is_success() {
            return Err(format!("Signed URL trả về HTTP {}", response.status()));
        }
        let total_bytes = response.content_length().unwrap_or(0);
        let path = std::env::temp_dir().join(format!("lua_tools_fix_{appid}_{fix_id}.zip"));
        let mut output = fs::File::create(&path).map_err(|e| format!("Không tạo được file tạm: {e}"))?;
        let mut buffer = [0_u8; 64 * 1024];
        let started = std::time::Instant::now();
        let mut downloaded = 0_u64;
        loop {
            let read = response.read(&mut buffer).map_err(|e| format!("Không đọc được LuaTools fix: {e}"))?;
            if read == 0 { break; }
            output.write_all(&buffer[..read]).map_err(|e| format!("Không ghi được LuaTools fix: {e}"))?;
            downloaded += read as u64;
            if downloaded == read as u64 || downloaded % (1024 * 1024) < read as u64 {
                let speed = (downloaded as f64 / started.elapsed().as_secs_f64().max(0.001)) as u64;
                emit_progress(&app_for_download, BypassProgressPayload {
                    game_id: game_for_download.clone(), stage: "downloading".into(), downloaded_bytes: downloaded,
                    total_bytes, percent: if total_bytes > 0 { downloaded as f64 * 100.0 / total_bytes as f64 } else { 0.0 },
                    speed_bps: speed, message: "Đang tải LuaTools fix...".into(),
                });
            }
        }
        output.flush().map_err(|e| format!("Không hoàn tất file LuaTools fix: {e}"))?;
        Ok(path)
    }).await.map_err(|e| e.to_string())??;

    let app_for_extract = app.clone();
    let game_for_extract = game_id.clone();
    tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
        let backup_root = install_path.join(".0xolemon_bypass");
        let backup_files = backup_root.join("files");
        if backup_root.exists() {
            return Err("Đã có backup của một bản bypass đang cài hoặc dở dang. Gỡ bản hiện tại trước khi cài lại.".into());
        }
        fs::create_dir_all(&backup_files).map_err(|e| e.to_string())?;
        let mut installed_files = Vec::new();
        let mut backed_up_files = Vec::new();
        emit_progress(&app_for_extract, BypassProgressPayload {
            game_id: game_for_extract.clone(), stage: "extracting".into(), downloaded_bytes: 0,
            total_bytes: 0, percent: 100.0, speed_bps: 0, message: "Đang giải nén LuaTools fix...".into(),
        });
        let file = fs::File::open(&temp).map_err(|e| e.to_string())?;
        let mut archive = zip::ZipArchive::new(file).map_err(|e| format!("LuaTools ZIP không hợp lệ: {e}"))?;
        let extraction_result: Result<(), String> = (|| {
            for index in 0..archive.len() {
                let mut entry = archive.by_index(index).map_err(|e| e.to_string())?;
                if entry.is_dir() { continue; }
                let name = entry.name().replace('\\', "/");
                if name.is_empty() || name.starts_with('/') || name.split('/').any(|part| part.is_empty() || part == "." || part == "..") {
                    return Err(format!("Đường dẫn trong LuaTools ZIP không an toàn: {name}"));
                }
                let relative = Path::new(&name);
                let target = install_path.join(relative);
                if target.exists() {
                    let backup = backup_files.join(relative);
                    if let Some(parent) = backup.parent() { fs::create_dir_all(parent).map_err(|e| e.to_string())?; }
                    fs::copy(&target, &backup).map_err(|e| format!("Không thể backup {}: {e}", name))?;
                    backed_up_files.push(name.clone());
                }
                if let Some(parent) = target.parent() { fs::create_dir_all(parent).map_err(|e| e.to_string())?; }
                let mut output = fs::File::create(&target).map_err(|e| format!("Không thể tạo {}: {e}", name))?;
                std::io::copy(&mut entry, &mut output).map_err(|e| format!("Không thể giải nén {}: {e}", name))?;
                installed_files.push(name);
            }
            Ok(())
        })();
        if let Err(error) = extraction_result {
            for relative in &installed_files {
                let target = install_path.join(relative);
                let backup = backup_files.join(relative);
                if backup.is_file() { let _ = fs::copy(&backup, &target); }
                else if target.is_file() { let _ = fs::remove_file(&target); }
            }
            let _ = fs::remove_dir_all(&backup_root);
            let _ = fs::remove_file(&temp);
            return Err(error);
        }
        let manifest = BypassInstallManifest {
            game_id: game_for_extract.clone(), installed_files, backed_up_files,
            installed_at: chrono::Utc::now().to_rfc3339(),
        };
        fs::write(backup_root.join("manifest.json"), serde_json::to_vec_pretty(&manifest).map_err(|e| e.to_string())?)
            .map_err(|e| e.to_string())?;
        let _ = fs::remove_file(&temp);
        emit_progress(&app_for_extract, BypassProgressPayload {
            game_id: game_for_extract, stage: "finished".into(), downloaded_bytes: 0,
            total_bytes: 0, percent: 100.0, speed_bps: 0, message: "Cài đặt LuaTools fix thành công!".into(),
        });
        Ok(())
    }).await.map_err(|e| e.to_string())??;
    Ok(())
}

#[command]
pub fn uninstall_bypass_fix(
    app: tauri::AppHandle,
    game_id: String,
    custom_path: Option<String>,
) -> Result<(), String> {
    let root = crate::translations::resolve_effective_path(&app, &game_id, custom_path.as_deref())
        .map_err(|e| format!("Không tìm thấy thư mục cài đặt game: {e}"))?;
    let backup_root = root.join(".0xolemon_bypass");
    let manifest_path = backup_root.join("manifest.json");
    let manifest: BypassInstallManifest = serde_json::from_slice(&fs::read(&manifest_path).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    for relative in manifest.installed_files {
        let target = root.join(&relative);
        let backup = backup_root.join("files").join(&relative);
        if backup.is_file() {
            if let Some(parent) = target.parent() { fs::create_dir_all(parent).map_err(|e| format!("Không thể tạo thư mục khôi phục {}: {e}", relative))?; }
            fs::copy(backup, target).map_err(|e| format!("Không thể khôi phục {}: {e}", relative))?;
        } else if target.is_file() {
            fs::remove_file(target).map_err(|e| format!("Không thể xóa file bypass {}: {e}", relative))?;
        }
    }
    fs::remove_dir_all(backup_root).map_err(|e| format!("Không thể xóa backup: {e}"))?;
    Ok(())
}

/// Lists all appids in PROBBI/PROBBINE/Bypass-fix/ with tag summary
///
/// The `app` handle is used to attach an existing LuaTools session to the (public) LuaTools
/// listings call, so signed-in users are counted against their own account/quota. It is
/// unrelated to the launcher's 0xoLemon Discord gate.
#[command]
pub fn get_bypass_index(app: tauri::AppHandle) -> Result<Vec<BypassAppInfo>, String> {
    let token = get_probbi_token();
    let client = build_client()?;
    let headers = auth_headers(&token);

    // Fetch the complete Bypass-fix tree once. The previous implementation
    // fetched one recursive subtree per AppID, which made opening the tab wait
    // on dozens of sequential network requests.
    let url = format!(
        "{HF_API_BASE}/{PROBBI_REPO}/tree/main/{BYPASS_FOLDER}?recursive=true&limit=1000"
    );
    let body = client
        .get(&url)
        .headers(headers.clone())
        .send()
        .map_err(|e| format!("Network: {e}"))?
        .text()
        .map_err(|e| format!("Read: {e}"))?;

    let entries: Vec<HfTreeEntry> = serde_json::from_str(&body)
        .map_err(|e| format!("Parse Bypass-fix tree: {e} — body: {}", &body[..body.len().min(300)]))?;

    let mut hf_games: BTreeMap<String, (Vec<String>, Vec<String>)> = BTreeMap::new();
    let prefix = format!("{BYPASS_FOLDER}/");
    for entry in entries {
        let Some(rel) = entry.path.strip_prefix(&prefix) else { continue };
        let parts: Vec<&str> = rel.split('/').collect();
        if parts.len() < 2 { continue }
        let appid = parts[0].to_string();
        let record = hf_games.entry(appid).or_default();
        if entry.entry_type == "directory" && parts.len() == 2 {
            if !record.0.contains(&parts[1].to_string()) {
                record.0.push(parts[1].to_string());
            }
        } else if entry.entry_type == "file" && parts.len() == 3 && parts[2].ends_with(".7z") {
            let tag = display_bypass_tag(parts[2]);
            if !record.1.contains(&tag) { record.1.push(tag); }
            if !record.0.contains(&parts[1].to_string()) {
                record.0.push(parts[1].to_string());
            }
        } else if entry.entry_type == "file" && parts.len() == 2 && parts[1].ends_with(".7z") {
            let tag = display_bypass_tag(parts[1]);
            if !record.1.contains(&tag) { record.1.push(tag); }
            let latest = "Latest".to_string();
            if !record.0.contains(&latest) {
                record.0.push(latest);
            }
        }
    }
    // The HF tree pass above built the PROBBI half. The sort/map below reassigns `results`,
    // so keep it a plain `let` (no shadowing hazards) and extend with LuaTools next.
    let mut results = hf_games.into_iter().map(|(appid, (mut buildids, all_tags))| {
        buildids.sort();
        BypassAppInfo {
            appid,
            build_count: buildids.len(),
            latest_buildid: buildids.last().cloned().unwrap_or_default(),
            all_tags,
            provider: "probbi".into(),
            name: None,
            header_image: None,
        }
    }).collect::<Vec<_>>();

    // LuaTools exposes a separate public fix catalog. Keep it in the same Others source;
    // the provider field prevents these entries from being sent through the HF installer.
    // The listings endpoint is public — browsing the catalog never needs a LuaTools account.
    // Only the download endpoint does (see install_lua_tools_fix), so we attach the token
    // when one already exists purely to hit the user's own quota instead of the anonymous
    // bucket. A missing session must NOT block the catalog: guest browsing stays available.
    let lua_url = "https://lua.tools/api/denuvo/listings";
    let lua_request = match crate::lua_sources::luatools_access_token_if_present(&app, &client) {
        Ok(Some(token)) => client.get(lua_url).bearer_auth(token),
        _ => client.get(lua_url),
    };
    if let Ok(response) = lua_request.send().and_then(|r| r.json::<LuaToolsListingResponse>()) {
        results.extend(response.games.into_iter().map(|game| BypassAppInfo {
            appid: game.appid,
            build_count: game.fix_count,
            latest_buildid: String::new(),
            all_tags: game.tags.into_iter().map(|tag| tag.name).collect(),
            provider: "lua_tools".into(),
            name: Some(game.name),
            header_image: game.header_image,
        }));
    }

    // Empress fix catalog — public, no auth required, ZIP files from generator.ryuu.lol
    if let Ok(empress_games) = fetch_empress_list(&client) {
        results.extend(empress_games.into_iter().filter(|g| !g.fixes.is_empty()).map(|g| {
            BypassAppInfo {
                appid: g.appid,
                build_count: g.fixes.len(),
                latest_buildid: "Latest".into(),
                all_tags: vec!["Empress Fix".into()],
                provider: "empress".into(),
                name: Some(g.name),
                header_image: None,
            }
        }));
    }

    Ok(results)
}

/// Fetches all builds + tags for a specific appid
#[command]
pub fn get_bypass_builds(appid: String, provider: Option<String>) -> Result<Vec<BypassBuild>, String> {
    if provider.as_deref() == Some("empress") {
        let client = build_client()?;
        let empress_games = fetch_empress_list(&client)?;
        let game = empress_games
            .into_iter()
            .find(|g| g.appid == appid)
            .ok_or_else(|| format!("Empress: không tìm thấy appid {appid}"))?;
        return Ok(game.fixes.into_iter().map(|fix| {
            let tag_label = if fix.badges.is_empty() {
                "Bypass".to_string()
            } else {
                fix.badges.join(" · ")
            };
            BypassBuild {
                buildid: "Latest".to_string(),
                tags: vec![BypassTag {
                    tag: tag_label,
                    filename: fix.filename,
                    href: Some(fix.href),
                }],
            }
        }).collect());
    }
    if provider.as_deref() == Some("lua_tools") {
        let client = build_client()?;
        let url = format!("https://lua.tools/api/denuvo/fixes?appid={appid}");
        let response = client
            .get(url)
            .send()
            .map_err(|e| format!("Network: {e}"))?;
        if !response.status().is_success() {
            return Err(format!("LuaTools HTTP {}", response.status()));
        }
        let data: LuaToolsFixResponse = response.json().map_err(|e| format!("Parse: {e}"))?;
        return Ok(data.fixes.into_iter().map(|fix| BypassBuild {
            buildid: fix.id,
            tags: fix.tags.into_iter().map(|tag| BypassTag {
                tag: tag.name,
                filename: fix.fix_filename.clone().unwrap_or_default(),
                href: None,
            }).collect(),
        }).collect());
    }

    let token = get_probbi_token();
    let client = build_client()?;
    let headers = auth_headers(&token);

    let url = format!(
        "{HF_API_BASE}/{PROBBI_REPO}/tree/main/{BYPASS_FOLDER}/{appid}?recursive=true&limit=300"
    );
    let body = client
        .get(&url)
        .headers(headers)
        .send()
        .map_err(|e| format!("Network: {e}"))?
        .text()
        .map_err(|e| format!("Read: {e}"))?;

    let entries: Vec<HfTreeEntry> = serde_json::from_str(&body)
        .map_err(|e| format!("Parse: {e}"))?;

    let prefix = format!("{BYPASS_FOLDER}/{appid}/");
    let mut map: std::collections::HashMap<String, Vec<BypassTag>> =
        std::collections::HashMap::new();

    for entry in entries {
        if entry.entry_type != "file" || !entry.path.ends_with(".7z") {
            continue;
        }
        let rel = match entry.path.strip_prefix(&prefix) {
            Some(r) => r,
            None => continue,
        };
        // rel = "{buildid}/{tag}.7z"
        let parts: Vec<&str> = rel.splitn(2, '/').collect();
        if parts.len() == 2 {
            let buildid = parts[0].to_string();
            let filename = parts[1].to_string();
            let tag = display_bypass_tag(&filename);
            map.entry(buildid).or_default().push(BypassTag { tag, filename, href: None });
        } else if parts.len() == 1 {
            let filename = parts[0].to_string();
            let tag = display_bypass_tag(&filename);
            map.entry("Latest".to_string()).or_default().push(BypassTag { tag, filename, href: None });
        }
    }

    let mut result: Vec<BypassBuild> = map
        .into_iter()
        .map(|(buildid, tags)| BypassBuild { buildid, tags })
        .collect();
    result.sort_by(|a, b| b.buildid.cmp(&a.buildid)); // newest first
    Ok(result)
}

/// Downloads .7z from PROBBI/Bypass-fix and extracts with password to dest_path
#[command]
pub fn download_bypass_fix(
    appid: String,
    buildid: String,
    tag: String,
    dest_path: String,
) -> Result<(), String> {
    let token = get_probbi_token();
    let client = build_client()?;
    let filename = if tag.to_ascii_lowercase().contains("online-fix") {
        "online-fix.7z".to_string()
    } else {
        format!("{tag}.7z")
    };
    let url = if buildid == "Latest" {
        format!("{HF_DL_BASE}/{PROBBI_REPO}/resolve/main/{BYPASS_FOLDER}/{appid}/{filename}")
    } else {
        format!("{HF_DL_BASE}/{PROBBI_REPO}/resolve/main/{BYPASS_FOLDER}/{appid}/{buildid}/{filename}")
    };

    let mut req = client.get(&url);
    if !token.is_empty() {
        req = req.header(AUTHORIZATION, format!("Bearer {token}"));
    }
    let resp = req.send().map_err(|e| format!("Download: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("HTTP {} downloading bypass", resp.status()));
    }
    let temp_file = std::env::temp_dir()
        .join(format!("bypass_{appid}_{buildid}_{tag}.7z"));
    let mut input = resp;
    let mut output = fs::File::create(&temp_file).map_err(|e| format!("Write temp: {e}"))?;
    std::io::copy(&mut input, &mut output).map_err(|e| format!("Read archive: {e}"))?;

    let dest = Path::new(&dest_path);
    fs::create_dir_all(dest).map_err(|e| format!("Create dir: {e}"))?;

    sevenz_rust::decompress_file_with_password(&temp_file, dest, BYPASS_PASS.into())
        .map_err(|e| format!("Extract 7z: {e}"))?;

    let _ = fs::remove_file(&temp_file);
    Ok(())
}

/// Downloads and installs an Empress fix (plain ZIP, no password).
///
/// `href` is the direct download URL from the `/list` catalog response,
/// e.g. `https://generator.ryuu.lol/fixes/Game Name.zip`.
#[command]
pub async fn install_empress_fix(
    app: tauri::AppHandle,
    game_id: String,
    href: String,
    filename: String,
    custom_path: Option<String>,
) -> Result<(), String> {
    let install_path =
        crate::translations::resolve_effective_path(&app, &game_id, custom_path.as_deref())
            .map_err(|e| format!("Không tìm thấy thư mục cài đặt: {e}"))?;
    let client = build_client()?;

    // Empress fixes live on generator.ryuu.lol, which only serves files to a Discord
    // signed-in user. This is the SAME shape as the LuaTools flow (see
    // install_lua_tools_fix): the session is a separate account, we never fall back to
    // the launcher's own 0xoLemon token, and a missing session must fail with a
    // distinct code so the UI can offer the Discord sign-in instead of a raw error.
    let token = crate::lua_sources::empress_access_token_if_present(&app, &client)?;
    if token.is_none() {
        // Never auto-open a browser from an install action: installing with no Empress
        // session must fail with a clear, actionable error so the UI can prompt the user.
        return Err("EMPRESS_AUTH_REQUIRED".to_string());
    }

    let app_dl = app.clone();
    let gid_dl = game_id.clone();
    let fname_dl = filename.clone();
    let app_for_bytes = app.clone();
    let href_for_bytes = href.clone();
    let client_move = client;

    let temp_path =
        tauri::async_runtime::spawn_blocking(move || -> Result<std::path::PathBuf, String> {
            emit_progress(&app_dl, BypassProgressPayload {
                game_id: gid_dl.clone(), stage: "downloading".into(),
                downloaded_bytes: 0, total_bytes: 0, percent: 0.0, speed_bps: 0,
                message: "Đang tải Empress fix...".into(),
            });
            let safe = fname_dl.replace(['/', '\\', ':'], "_");
            let temp = std::env::temp_dir().join(format!("empress_{safe}"));
            let bytes = crate::lua_sources::empress_fix_download_bytes(
                &app_for_bytes,
                &client_move,
                &href_for_bytes,
            )?;
            let total_bytes = bytes.len() as u64;
            {
                let mut out = fs::File::create(&temp).map_err(|e| format!("Tạo file tạm: {e}"))?;
                out.write_all(&bytes).map_err(|e| format!("Ghi: {e}"))?;
                out.flush().map_err(|e| format!("Flush: {e}"))?;
            }
            emit_progress(&app_dl, BypassProgressPayload {
                game_id: gid_dl, stage: "downloading".into(),
                downloaded_bytes: total_bytes, total_bytes, percent: 100.0, speed_bps: 0,
                message: "Đang tải Empress fix...".into(),
            });
            Ok(temp)
        })
        .await
        .map_err(|e| format!("Spawn: {e}"))??;

    // Extract plain ZIP (no password)
    let app_ex = app.clone();
    let gid_ex = game_id.clone();
    tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
        emit_progress(&app_ex, BypassProgressPayload {
            game_id: gid_ex.clone(), stage: "extracting".into(),
            downloaded_bytes: 0, total_bytes: 0, percent: 100.0, speed_bps: 0,
            message: "Đang giải nén Empress fix...".into(),
        });
        let file = fs::File::open(&temp_path).map_err(|e| format!("Mở ZIP: {e}"))?;
        let mut archive = zip::ZipArchive::new(file).map_err(|e| format!("ZIP không hợp lệ: {e}"))?;
        for i in 0..archive.len() {
            let mut entry = archive.by_index(i).map_err(|e| format!("Entry {i}: {e}"))?;
            let name = entry.name().to_string();
            if name.contains("..") {
                return Err(format!("Đường dẫn không an toàn: {name}"));
            }
            let dest = install_path.join(&name);
            if entry.is_dir() {
                fs::create_dir_all(&dest).map_err(|e| format!("Mkdir: {e}"))?;
            } else {
                if let Some(p) = dest.parent() {
                    fs::create_dir_all(p).map_err(|e| format!("Mkdir: {e}"))?;
                }
                let mut f = fs::File::create(&dest).map_err(|e| format!("Tạo file: {e}"))?;
                std::io::copy(&mut entry, &mut f).map_err(|e| format!("Ghi file: {e}"))?;
            }
        }
        let _ = fs::remove_file(&temp_path);
        emit_progress(&app_ex, BypassProgressPayload {
            game_id: gid_ex, stage: "done".into(),
            downloaded_bytes: 0, total_bytes: 0, percent: 100.0, speed_bps: 0,
            message: "Cài đặt Empress fix thành công!".into(),
        });
        Ok(())
    })
    .await
    .map_err(|e| format!("Spawn: {e}"))?
}
