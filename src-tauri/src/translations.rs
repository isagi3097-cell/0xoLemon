use crate::remote_paths;
use reqwest::header::{AUTHORIZATION, USER_AGENT};
use serde::{Deserialize, Serialize};
use sevenz_rust::Password;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::Instant;
use tauri::{AppHandle, Emitter};

const VIETHOA_REPO_ID: &str = "JOINCANE/0XoLemon";

fn build_client_with_token() -> (reqwest::Client, Option<String>) {
    let client = reqwest::Client::new();
    let token = remote_paths::token_for_repo(VIETHOA_REPO_ID);
    (client, token)
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct TranslationInfo {
    pub file_name: String,
    pub path: String,
    pub size: u64,
    #[serde(default)]
    pub download_url: Option<String>,
    #[serde(default)]
    pub source: String,
}

#[derive(Debug, Deserialize)]
struct RevoltGame {
    id: serde_json::Value,
    #[serde(default)]
    team: String,
    #[serde(default)]
    name: String,
    #[serde(default)]
    url: Option<String>,
}

/// Normalize a string for fuzzy matching: lowercase, keep only alphanumeric chars
fn normalize_for_fuzzy(s: &str) -> String {
    s.chars()
        .filter(|c| c.is_alphanumeric())
        .map(|c| c.to_ascii_lowercase())
        .collect()
}

/// Try to find the actual HuggingFace folder name for a game by scanning the repo root.
/// This handles case mismatches and slight name variations.
async fn find_hf_folder_name(
    client: &reqwest::Client,
    repo_id: &str,
    preferred_dir_name: &str,
    token: Option<&str>,
) -> Option<String> {
    let auth_header = token.map(|t| format!("Bearer {t}"));

    let make_req = |url: String| {
        let mut req = client.get(url).header(USER_AGENT, "007Launcher");
        if let Some(ref auth) = auth_header {
            req = req.header(AUTHORIZATION, auth.as_str());
        }
        req
    };

    // First try exact match
    let url = format!(
        "https://huggingface.co/api/datasets/{}/tree/main/{}/Viethoagame",
        repo_id, preferred_dir_name
    );
    if let Ok(res) = make_req(url).send().await {
        if res.status().is_success() {
            return Some(preferred_dir_name.to_string());
        }
    }

    // Fallback: scan root and do fuzzy match
    let root_url = format!("https://huggingface.co/api/datasets/{}/tree/main", repo_id);
    let res = make_req(root_url).send().await.ok()?;
    if !res.status().is_success() {
        return None;
    }

    #[derive(Deserialize)]
    struct HfDir {
        #[serde(rename = "type")]
        entry_type: String,
        path: String,
    }

    let dirs: Vec<HfDir> = res.json().await.ok()?;
    let needle = normalize_for_fuzzy(preferred_dir_name);

    // Find the folder with best matching name (exact fuzzy match preferred)
    for dir in &dirs {
        if dir.entry_type == "directory" {
            let folder_name = dir.path.split('/').last().unwrap_or(&dir.path);
            if normalize_for_fuzzy(folder_name) == needle {
                // Verify it has a Viethoagame subdirectory
                let check_url = format!(
                    "https://huggingface.co/api/datasets/{}/tree/main/{}/Viethoagame",
                    repo_id, folder_name
                );
                if let Ok(res) = make_req(check_url).send().await {
                    if res.status().is_success() {
                        return Some(folder_name.to_string());
                    }
                }
            }
        }
    }
    None
}

#[tauri::command]
pub async fn get_available_translations(
    _app: AppHandle,
    game_id: String,
) -> Result<Vec<TranslationInfo>, String> {
    // Revolt is the authoritative live catalog. The GitHub JSON is only a
    // fallback, so a temporary Revolt outage does not turn into a false miss.
    let client = reqwest::Client::new();
    let sources = [
        "https://cloud.revoltg.app/viethoa/games.json".to_string(),
        "https://raw.githubusercontent.com/isagi3097-cell/steam-metadata/main/translations.json".to_string(),
    ];

    for source_url in sources {
        let response = match client
            .get(&source_url)
            .header(USER_AGENT, "007Launcher")
            .send()
            .await
        {
            Ok(response) if response.status().is_success() => response,
            _ => continue,
        };
        let value: serde_json::Value = match response.json().await {
            Ok(value) => value,
            Err(_) => continue,
        };
        let games = value
            .get("games")
            .and_then(serde_json::Value::as_array)
            .cloned()
            .or_else(|| value.as_array().cloned())
            .unwrap_or_default();

        let mut result = Vec::new();
        for value in games {
            let game: RevoltGame = match serde_json::from_value(value) {
                Ok(game) => game,
                Err(_) => continue,
            };
            let id = game.id.as_str()
                .map(str::to_string)
                .or_else(|| game.id.as_u64().map(|id| id.to_string()));
            if id.as_deref() != Some(game_id.trim()) {
                continue;
            }
            let id = id.unwrap_or_default();
            let team = if game.team.trim().is_empty() { "Revolt" } else { game.team.trim() };
            let download_url = game.url.or_else(|| Some(format!("https://vh.revolt.vn/{team}/{id}/pack.zip")));
            let file_name = format!("{id}_pack.zip");
            result.push(TranslationInfo {
                file_name,
                path: format!("{team}/{id}/pack.zip"),
                size: 0,
                download_url,
                source: if source_url.contains("revolt") { "revolt".into() } else { "github".into() },
            });
        }
        return Ok(result);
    }

    Ok(Vec::new())
}

pub fn find_all_steam_libraries() -> Vec<PathBuf> {
    let mut libraries = Vec::new();
    let mut root_paths = Vec::new();

    if let Some(sp) = crate::steam::get_steam_path() {
        root_paths.push(sp);
    }

    #[cfg(target_os = "windows")]
    {
        use winreg::enums::*;
        use winreg::RegKey;
        let hklm = RegKey::predef(HKEY_LOCAL_MACHINE);
        for subkey in [
            "SOFTWARE\\Valve\\Steam",
            "SOFTWARE\\WOW6432Node\\Valve\\Steam",
        ] {
            if let Ok(key) = hklm.open_subkey(subkey) {
                if let Ok(path_str) = key.get_value::<String, _>("InstallPath") {
                    let pb = PathBuf::from(path_str);
                    if pb.exists() && !root_paths.contains(&pb) {
                        root_paths.push(pb);
                    }
                }
            }
        }
    }

    for root in root_paths {
        if !libraries.contains(&root) {
            libraries.push(root.clone());
        }
        let vdf_path = root.join("steamapps").join("libraryfolders.vdf");
        if let Ok(content) = fs::read_to_string(&vdf_path) {
            for line in content.lines() {
                let trimmed = line.trim();
                if trimmed.starts_with("\"path\"") {
                    let parts: Vec<&str> = trimmed.split('"').collect();
                    if parts.len() >= 4 {
                        let p = PathBuf::from(parts[3].replace("\\\\", "\\"));
                        if p.exists() && !libraries.contains(&p) {
                            libraries.push(p);
                        }
                    }
                }
            }
        }
    }

    libraries
}

pub fn find_steam_game_path(game_id: &str) -> Option<PathBuf> {
    let libraries = find_all_steam_libraries();
    let manifest_name = format!("appmanifest_{}.acf", game_id);

    for lib in libraries {
        let manifest_file = lib.join("steamapps").join(&manifest_name);
        if manifest_file.exists() {
            if let Ok(content) = fs::read_to_string(&manifest_file) {
                for line in content.lines() {
                    let trimmed = line.trim();
                    if trimmed.starts_with("\"installdir\"") {
                        let parts: Vec<&str> = trimmed.split('"').collect();
                        if parts.len() >= 4 {
                            let installdir = parts[3];
                            let game_dir = lib.join("steamapps").join("common").join(installdir);
                            if game_dir.exists() {
                                return Some(game_dir);
                            }
                        }
                    }
                }
            }
        }
    }
    None
}

pub fn get_game_install_path(app: &AppHandle, game_id: &str) -> Result<PathBuf, String> {
    // 1. Check 007Launcher registered install path
    if let Ok(Some(path)) = crate::platform::registered_install_path(app, game_id) {
        if path.exists() {
            return Ok(path);
        }
    }

    // 2. Fallback to Steam library detection
    if let Some(path) = find_steam_game_path(game_id) {
        return Ok(path);
    }

    Err(format!(
        "Game {} is not installed (checked launcher & Steam)",
        game_id
    ))
}

pub fn resolve_effective_path(
    app: &AppHandle,
    game_id: &str,
    custom_path: Option<&str>,
) -> Result<PathBuf, String> {
    if let Some(cp) = custom_path {
        let trimmed = cp.trim();
        if !trimmed.is_empty() {
            let p = PathBuf::from(trimmed);
            if p.exists() && p.is_dir() {
                return Ok(p);
            }
        }
    }
    get_game_install_path(app, game_id)
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct DetectedGamePathInfo {
    pub path: String,
    pub source: String, // "launcher" | "steam"
}

#[tauri::command]
pub fn detect_game_path(
    app: AppHandle,
    game_id: String,
) -> Result<Option<DetectedGamePathInfo>, String> {
    if let Ok(Some(path)) = crate::platform::registered_install_path(&app, &game_id) {
        if path.exists() {
            return Ok(Some(DetectedGamePathInfo {
                path: path.to_string_lossy().to_string(),
                source: "launcher".to_string(),
            }));
        }
    }

    if let Some(path) = find_steam_game_path(&game_id) {
        return Ok(Some(DetectedGamePathInfo {
            path: path.to_string_lossy().to_string(),
            source: "steam".to_string(),
        }));
    }

    Ok(None)
}

#[tauri::command]
pub fn check_game_installed(
    app: AppHandle,
    game_id: String,
    custom_path: Option<String>,
) -> Result<Option<String>, String> {
    match resolve_effective_path(&app, &game_id, custom_path.as_deref()) {
        Ok(path) => Ok(Some(path.to_string_lossy().to_string())),
        Err(_) => Ok(None),
    }
}

#[tauri::command]
pub fn get_translation_status(
    app: AppHandle,
    game_id: String,
    custom_path: Option<String>,
) -> Result<bool, String> {
    let install_path = match resolve_effective_path(&app, &game_id, custom_path.as_deref()) {
        Ok(p) => p,
        Err(_) => return Ok(false),
    };

    let lemon_backup = install_path.join(".lemon_backup");
    let revolt_backup = install_path.join(".revolt_backup");
    let legacy_backup = install_path.join(".viethoa_backup");
    let patch_version = install_path.join(".patch_version");
    let lemon_patch = install_path.join(".lemon_patch");
    let manifest_file = lemon_backup.join("manifest.json");

    Ok(lemon_backup.exists()
        || revolt_backup.exists()
        || legacy_backup.exists()
        || patch_version.exists()
        || lemon_patch.exists()
        || manifest_file.exists())
}

#[derive(Serialize, Deserialize)]
struct LemonPatchManifest {
    game_id: String,
    installed_files: Vec<String>,
    backed_up_files: Vec<String>,
    installed_at: String,
}

fn restore_backup_recursive(
    src_dir: &Path,
    dest_root: &Path,
    backup_root: &Path,
) -> Result<(), String> {
    if !src_dir.exists() {
        return Ok(());
    }
    let entries = fs::read_dir(src_dir).map_err(|e| e.to_string())?;
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            restore_backup_recursive(&path, dest_root, backup_root)?;
        } else {
            let rel = path.strip_prefix(backup_root).map_err(|e| e.to_string())?;
            if rel.to_string_lossy() == "manifest.json" {
                continue;
            }
            let target = dest_root.join(rel);
            if let Some(parent) = target.parent() {
                let _ = fs::create_dir_all(parent);
            }
            let _ = fs::copy(&path, &target);
        }
    }
    Ok(())
}

fn extract_zip_native(archive_path: &Path, dest_path: &Path) -> Result<(), String> {
    let file = fs::File::open(archive_path).map_err(|e| e.to_string())?;
    let mut archive = zip::ZipArchive::new(file).map_err(|e| e.to_string())?;

    for i in 0..archive.len() {
        let mut entry = archive.by_index(i).map_err(|e| e.to_string())?;
        let relative = match entry.enclosed_name() {
            Some(p) => p.to_owned(),
            None => continue,
        };

        if entry.is_dir() {
            let d = dest_path.join(&relative);
            let _ = fs::create_dir_all(&d);
            continue;
        }

        let outpath = dest_path.join(&relative);
        if let Some(parent) = outpath.parent() {
            let _ = fs::create_dir_all(parent);
        }

        let mut outfile = fs::File::create(&outpath).map_err(|e| e.to_string())?;
        std::io::copy(&mut entry, &mut outfile).map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn extract_archive_multi_engine(archive_path: &Path, dest_path: &Path) -> Result<(), String> {
    let native_res = extract_zip_native(archive_path, dest_path);
    if native_res.is_ok() {
        return Ok(());
    }

    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        let seven_zip_paths = [
            PathBuf::from(r"C:\Program Files\7-Zip\7z.exe"),
            PathBuf::from(r"C:\Program Files (x86)\7-Zip\7z.exe"),
        ];

        for sz in seven_zip_paths {
            if sz.exists() {
                let status = std::process::Command::new(&sz)
                    .args(&[
                        "x",
                        archive_path.to_str().unwrap(),
                        &format!("-o{}", dest_path.to_str().unwrap()),
                        "-y",
                    ])
                    .creation_flags(0x08000000)
                    .status();
                if let Ok(st) = status {
                    if st.success() {
                        return Ok(());
                    }
                }
            }
        }

        let path_status = std::process::Command::new("7z")
            .args(&[
                "x",
                archive_path.to_str().unwrap(),
                &format!("-o{}", dest_path.to_str().unwrap()),
                "-y",
            ])
            .creation_flags(0x08000000)
            .status();
        if let Ok(st) = path_status {
            if st.success() {
                return Ok(());
            }
        }

        let winrar_paths = [
            PathBuf::from(r"C:\Program Files\WinRAR\WinRAR.exe"),
            PathBuf::from(r"C:\Program Files (x86)\WinRAR\WinRAR.exe"),
        ];

        for wr in winrar_paths {
            if wr.exists() {
                let dest_arg = format!("{}\\", dest_path.to_str().unwrap());
                let status = std::process::Command::new(&wr)
                    .args(&[
                        "x",
                        "-ibck",
                        "-o+",
                        archive_path.to_str().unwrap(),
                        &dest_arg,
                    ])
                    .creation_flags(0x08000000)
                    .status();
                if let Ok(st) = status {
                    if st.success() {
                        return Ok(());
                    }
                }
            }
        }

        let temp_7zr = std::env::temp_dir()
            .join("007launcher_viethoa")
            .join("7zr.exe");
        if !temp_7zr.exists() {
            if let Ok(client) = reqwest::blocking::Client::builder().build() {
                if let Ok(res) = client.get("https://www.7-zip.org/a/7zr.exe").send() {
                    if res.status().is_success() {
                        if let Ok(bytes) = res.bytes() {
                            let _ = fs::write(&temp_7zr, bytes);
                        }
                    }
                }
            }
        }

        if temp_7zr.exists() {
            let status = std::process::Command::new(&temp_7zr)
                .args(&[
                    "x",
                    archive_path.to_str().unwrap(),
                    &format!("-o{}", dest_path.to_str().unwrap()),
                    "-y",
                ])
                .creation_flags(0x08000000)
                .status();
            if let Ok(st) = status {
                if st.success() {
                    return Ok(());
                }
            }
        }
    }

    native_res
}

#[derive(Clone, Serialize)]
pub struct TranslationProgressPayload {
    pub game_id: String,
    pub stage: String,
    pub downloaded_bytes: u64,
    pub total_bytes: u64,
    pub percent: f64,
    pub speed_bps: u64,
    pub message: String,
}

#[tauri::command]
pub async fn install_translation(
    app: AppHandle,
    game_id: String,
    translation_path: Option<String>,
    download_url: Option<String>,
    custom_path: Option<String>,
) -> Result<(), String> {
    let install_path = resolve_effective_path(&app, &game_id, custom_path.as_deref())
        .map_err(|e| format!("Không tìm thấy thư mục cài đặt game: {}", e))?;

    let backup_path = install_path.join(".lemon_backup");
    fs::create_dir_all(&backup_path).map_err(|e| e.to_string())?;

    let final_url = if let Some(ref url) = download_url {
        if !url.trim().is_empty() {
            url.clone()
        } else {
            let rel = translation_path.as_deref().unwrap_or("pack.zip");
            format!(
                "https://huggingface.co/datasets/{}/resolve/main/{}",
                VIETHOA_REPO_ID, rel
            )
        }
    } else if let Some(ref rel) = translation_path {
        format!(
            "https://huggingface.co/datasets/{}/resolve/main/{}",
            VIETHOA_REPO_ID, rel
        )
    } else {
        return Err("Không có đường dẫn tải bản dịch".to_string());
    };

    let temp_dir = std::env::temp_dir().join("007launcher_viethoa");
    fs::create_dir_all(&temp_dir).map_err(|e| e.to_string())?;

    let is_7z = final_url.ends_with(".7z");
    let ext = if is_7z { "7z" } else { "zip" };
    let temp_file_path = temp_dir.join(format!("{}_patch.{}", game_id, ext));

    let (client, token) = build_client_with_token();
    let mut req = client.get(&final_url).header(USER_AGENT, "007Launcher");
    if final_url.contains("huggingface.co") {
        if let Some(ref t) = token {
            req = req.header(AUTHORIZATION, format!("Bearer {t}"));
        }
    }

    let _ = app.emit(
        "translation-progress",
        TranslationProgressPayload {
            game_id: game_id.clone(),
            stage: "downloading".to_string(),
            downloaded_bytes: 0,
            total_bytes: 0,
            percent: 0.0,
            speed_bps: 0,
            message: "Bắt đầu tải bản dịch...".to_string(),
        },
    );

    let res = req
        .send()
        .await
        .map_err(|e| format!("Lỗi kết nối tải bản dịch: {}", e))?;
    if !res.status().is_success() {
        let err_msg = format!("Máy chủ phản hồi lỗi {}: {}", res.status(), final_url);
        let _ = app.emit(
            "translation-progress",
            TranslationProgressPayload {
                game_id: game_id.clone(),
                stage: "error".to_string(),
                downloaded_bytes: 0,
                total_bytes: 0,
                percent: 0.0,
                speed_bps: 0,
                message: err_msg.clone(),
            },
        );
        return Err(err_msg);
    }

    let total_bytes = res.content_length().unwrap_or(0);
    let mut file = tokio::fs::File::create(&temp_file_path)
        .await
        .map_err(|e| e.to_string())?;

    let mut downloaded_bytes = 0u64;
    let mut last_emit = Instant::now();
    let mut speed_timer = Instant::now();
    let mut bytes_since_speed = 0u64;
    let mut current_speed = 0u64;

    let mut res = res;
    while let Some(chunk) = res.chunk().await.map_err(|e| e.to_string())? {
        tokio::io::AsyncWriteExt::write_all(&mut file, &chunk)
            .await
            .map_err(|e| e.to_string())?;
        downloaded_bytes += chunk.len() as u64;
        bytes_since_speed += chunk.len() as u64;

        if speed_timer.elapsed().as_millis() >= 400 {
            let elapsed_sec = speed_timer.elapsed().as_secs_f64();
            if elapsed_sec > 0.0 {
                current_speed = (bytes_since_speed as f64 / elapsed_sec) as u64;
            }
            bytes_since_speed = 0;
            speed_timer = Instant::now();
        }

        if last_emit.elapsed().as_millis() >= 120
            || (total_bytes > 0 && downloaded_bytes == total_bytes)
        {
            let percent = if total_bytes > 0 {
                (downloaded_bytes as f64 / total_bytes as f64) * 100.0
            } else {
                0.0
            };
            let _ = app.emit(
                "translation-progress",
                TranslationProgressPayload {
                    game_id: game_id.clone(),
                    stage: "downloading".to_string(),
                    downloaded_bytes,
                    total_bytes,
                    percent,
                    speed_bps: current_speed,
                    message: format!(
                        "{:.1} MB / {:.1} MB ({:.1}%)",
                        downloaded_bytes as f64 / 1_048_576.0,
                        total_bytes as f64 / 1_048_576.0,
                        percent
                    ),
                },
            );
            last_emit = Instant::now();
        }
    }
    tokio::io::AsyncWriteExt::flush(&mut file)
        .await
        .map_err(|e| e.to_string())?;
    drop(file);

    let _ = app.emit(
        "translation-progress",
        TranslationProgressPayload {
            game_id: game_id.clone(),
            stage: "backing_up".to_string(),
            downloaded_bytes,
            total_bytes,
            percent: 100.0,
            speed_bps: 0,
            message: "Đang quét và sao lưu các file gốc...".to_string(),
        },
    );

    let install_path_clone = install_path.clone();
    let backup_path_clone = backup_path.clone();
    let temp_file_clone = temp_file_path.clone();
    let game_id_clone = game_id.clone();
    let app_clone = app.clone();

    tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
        let mut installed_files: Vec<String> = Vec::new();
        let mut backed_up_files: Vec<String> = Vec::new();

        if is_7z {
            let password = Password::from("0xoLemon.dll");
            let file = std::fs::File::open(&temp_file_clone).map_err(|e| e.to_string())?;

            sevenz_rust::decompress_with_extract_fn_and_password(
                file,
                &install_path_clone,
                password,
                |entry, reader, dest| {
                    if !entry.is_directory() {
                        let relative_path = entry.name();
                        let dest_path = install_path_clone.join(relative_path);
                        if dest_path.exists() {
                            let backup_file_path = backup_path_clone.join(relative_path);
                            if let Some(parent) = backup_file_path.parent() {
                                let _ = fs::create_dir_all(parent);
                            }
                            let _ = fs::copy(&dest_path, &backup_file_path);
                            backed_up_files.push(relative_path.to_string());
                        }
                        installed_files.push(relative_path.to_string());
                    }
                    sevenz_rust::default_entry_extract_fn(entry, reader, dest)
                },
            )
            .map_err(|e| e.to_string())?;
        } else {
            if let Ok(file) = std::fs::File::open(&temp_file_clone) {
                if let Ok(mut archive) = zip::ZipArchive::new(file) {
                    for i in 0..archive.len() {
                        if let Ok(entry) = archive.by_index(i) {
                            if entry.is_dir() {
                                continue;
                            }
                            if let Some(rel) = entry.enclosed_name() {
                                let rel_str = rel.to_string_lossy().to_string();
                                let dest_path = install_path_clone.join(&rel);
                                if dest_path.exists() {
                                    let backup_file = backup_path_clone.join(&rel);
                                    if let Some(parent) = backup_file.parent() {
                                        let _ = fs::create_dir_all(parent);
                                    }
                                    let _ = fs::copy(&dest_path, &backup_file);
                                    backed_up_files.push(rel_str.clone());
                                }
                                installed_files.push(rel_str);
                            }
                        }
                    }
                }
            }

            let _ = app_clone.emit(
                "translation-progress",
                TranslationProgressPayload {
                    game_id: game_id_clone.clone(),
                    stage: "extracting".to_string(),
                    downloaded_bytes,
                    total_bytes,
                    percent: 100.0,
                    speed_bps: 0,
                    message: "Đang giải nén bản dịch vào thư mục game...".to_string(),
                },
            );

            let extract_res = extract_archive_multi_engine(&temp_file_clone, &install_path_clone);
            if let Err(err) = extract_res {
                let _ = app_clone.emit(
                    "translation-progress",
                    TranslationProgressPayload {
                        game_id: game_id_clone.clone(),
                        stage: "error".to_string(),
                        downloaded_bytes,
                        total_bytes,
                        percent: 100.0,
                        speed_bps: 0,
                        message: format!("Lỗi giải nén: {}", err),
                    },
                );
                return Err(err);
            }
        }

        let manifest = LemonPatchManifest {
            game_id: game_id_clone.clone(),
            installed_files,
            backed_up_files,
            installed_at: chrono::Utc::now().to_rfc3339(),
        };
        if let Ok(manifest_json) = serde_json::to_string_pretty(&manifest) {
            let _ = fs::write(backup_path_clone.join("manifest.json"), manifest_json);
        }

        let patch_info = format!(
            "0xoLemon Vietnamese Patch\nGame: {}\nDate: {}\nStatus: Installed\n",
            game_id_clone,
            chrono::Utc::now().to_rfc3339()
        );
        let _ = fs::write(install_path_clone.join(".patch_version"), &patch_info);
        let _ = fs::write(install_path_clone.join(".lemon_patch"), &patch_info);

        #[cfg(target_os = "windows")]
        {
            let bat_path = install_path_clone.join("caivh.bat");
            if bat_path.exists() {
                use std::os::windows::process::CommandExt;
                let _ = std::process::Command::new("cmd.exe")
                    .args(&["/c", "caivh.bat"])
                    .current_dir(&install_path_clone)
                    .creation_flags(0x08000000)
                    .output();
            }
        }

        let _ = fs::remove_file(&temp_file_clone);

        let _ = app_clone.emit(
            "translation-progress",
            TranslationProgressPayload {
                game_id: game_id_clone,
                stage: "finished".to_string(),
                downloaded_bytes,
                total_bytes,
                percent: 100.0,
                speed_bps: 0,
                message: "Cài đặt Việt Hóa thành công!".to_string(),
            },
        );

        Ok(())
    })
    .await
    .map_err(|e| e.to_string())??;

    Ok(())
}

#[tauri::command]
pub async fn uninstall_translation(
    app: AppHandle,
    game_id: String,
    custom_path: Option<String>,
) -> Result<(), String> {
    let install_path = resolve_effective_path(&app, &game_id, custom_path.as_deref())
        .map_err(|e| format!("Không tìm thấy thư mục cài đặt game: {}", e))?;

    let lemon_backup = install_path.join(".lemon_backup");
    let revolt_backup = install_path.join(".revolt_backup");
    let legacy_backup = install_path.join(".viethoa_backup");

    #[cfg(target_os = "windows")]
    {
        let bat_path = install_path.join("govh.bat");
        if bat_path.exists() {
            use std::os::windows::process::CommandExt;
            let _ = std::process::Command::new("cmd.exe")
                .args(&["/c", "govh.bat"])
                .current_dir(&install_path)
                .creation_flags(0x08000000)
                .output();
            let _ = fs::remove_file(&bat_path);
        }
        let cai_path = install_path.join("caivh.bat");
        if cai_path.exists() {
            let _ = fs::remove_file(&cai_path);
        }
    }

    let manifest_path = lemon_backup.join("manifest.json");
    if manifest_path.exists() {
        if let Ok(content) = fs::read_to_string(&manifest_path) {
            if let Ok(manifest) = serde_json::from_str::<LemonPatchManifest>(&content) {
                for f in manifest.installed_files {
                    let backed_up = lemon_backup.join(&f);
                    let target = install_path.join(&f);
                    if !backed_up.exists() && target.exists() {
                        let _ = fs::remove_file(&target);
                    }
                }
            }
        }
    }

    let revolt_manifest = revolt_backup.join("manifest.txt");
    if revolt_manifest.exists() {
        if let Ok(content) = fs::read_to_string(&revolt_manifest) {
            for line in content.lines() {
                let rel = line.trim();
                if !rel.is_empty() {
                    let backed_up = revolt_backup.join(rel);
                    let target = install_path.join(rel);
                    if !backed_up.exists() && target.exists() {
                        let _ = fs::remove_file(&target);
                    }
                }
            }
        }
    }

    if lemon_backup.exists() {
        restore_backup_recursive(&lemon_backup, &install_path, &lemon_backup)?;
        let _ = fs::remove_dir_all(&lemon_backup);
    }
    if revolt_backup.exists() {
        restore_backup_recursive(&revolt_backup, &install_path, &revolt_backup)?;
        let _ = fs::remove_dir_all(&revolt_backup);
    }
    if legacy_backup.exists() {
        let _ = fs::remove_dir_all(&legacy_backup);
    }

    let _ = fs::remove_file(install_path.join(".patch_version"));
    let _ = fs::remove_file(install_path.join(".lemon_patch"));

    Ok(())
}

#[tauri::command]
pub async fn launch_translation_game(
    app: AppHandle,
    game_id: String,
    custom_path: Option<String>,
    executable: Option<String>,
    launch_options: Option<String>,
) -> Result<(), String> {
    let path_opt = resolve_effective_path(&app, &game_id, custom_path.as_deref()).ok();

    if let Some(ref path) = path_opt {
        if let Some(ref exe_name) = executable {
            let exe_path = path.join(exe_name);
            if exe_path.exists() {
                let mut cmd = std::process::Command::new(&exe_path);
                cmd.current_dir(path);
                if let Some(ref opts) = launch_options {
                    for arg in opts.split_whitespace() {
                        cmd.arg(arg);
                    }
                }
                cmd.spawn()
                    .map_err(|e| format!("Không thể khởi chạy {}: {}", exe_name, e))?;
                return Ok(());
            }
        }
    }

    if game_id.chars().all(|c| c.is_ascii_digit()) {
        let steam_url = format!("steam://rungameid/{}", game_id);
        #[cfg(target_os = "windows")]
        {
            use std::os::windows::process::CommandExt;
            let _ = std::process::Command::new("cmd.exe")
                .args(&["/c", "start", "", &steam_url])
                .creation_flags(0x08000000)
                .spawn();
            return Ok(());
        }
    }

    if let Some(ref path) = path_opt {
        if let Ok(entries) = fs::read_dir(path) {
            for entry in entries.flatten() {
                let p = entry.path();
                if p.is_file()
                    && p.extension()
                        .map_or(false, |ext| ext.eq_ignore_ascii_case("exe"))
                {
                    let file_name = p.file_name().unwrap().to_string_lossy().to_lowercase();
                    if !file_name.contains("crash")
                        && !file_name.contains("unins")
                        && !file_name.contains("unity")
                        && !file_name.contains("update")
                    {
                        let mut cmd = std::process::Command::new(&p);
                        cmd.current_dir(path);
                        if let Some(ref opts) = launch_options {
                            for arg in opts.split_whitespace() {
                                cmd.arg(arg);
                            }
                        }
                        cmd.spawn()
                            .map_err(|e| format!("Không thể khởi chạy: {}", e))?;
                        return Ok(());
                    }
                }
            }
        }
    }

    Err("Không tìm thấy file thực thi hoặc phương thức khởi chạy".to_string())
}
