// depot_downloader.rs — 0xoLemon Depot Downloader backend
// Downloads game depot manifests & keys from HuggingFace dataset (Immaking/Luas/Depotdownloader/)
// and executes DepotDownloaderMod.exe (self-contained .NET 9 binary) to download clean game files.

use once_cell::sync::Lazy;
use reqwest::blocking::Client;
use reqwest::header::{HeaderMap, HeaderValue, AUTHORIZATION};
use serde::{Deserialize, Serialize};
use sha1::{Digest, Sha1};
use std::collections::HashMap;
use std::fs;
use std::io::{BufRead, Read};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{command, AppHandle, Emitter, Manager};
use zip::ZipArchive;

// ─── HuggingFace Config & Auth ───────────────────────────────────────────────

fn get_hf_token() -> String {
    let json_str = include_str!("../huggingface-repos.json");
    let config: serde_json::Value = serde_json::from_str(json_str).unwrap_or_default();
    config["repositories"]
        .as_array()
        .unwrap_or(&vec![])
        .iter()
        .find(|r| {
            let id = r["repoId"].as_str().unwrap_or("");
            id.eq_ignore_ascii_case("Immaking/Luas") || id.eq_ignore_ascii_case("lmmaking/Luas")
        })
        .and_then(|r| r["token"].as_str())
        .unwrap_or("")
        .to_string()
}

/// Steam CDN cell used for depot downloads.
/// `0` lets DepotDownloaderMod pick a random cell, which is what makes downloads
/// intermittently time out. Pinning a stable, geo-close cell (HCMC / Vietnam = 49)
/// gives the same steady CDN routing the Steam client uses on this account's region.
fn steam_cell_id() -> u32 {
    std::env::var("SD_CELL_ID")
        .ok()
        .and_then(|value| value.trim().parse::<u32>().ok())
        .filter(|value| *value > 0)
        .unwrap_or(49)
}

fn build_client() -> Result<Client, String> {
    Client::builder()
        .user_agent("0xoLemon-Launcher/2.0.50 (Windows NT 10.0; Win64; x64)")
        .redirect(reqwest::redirect::Policy::limited(10))
        .timeout(Duration::from_secs(60))
        .build()
        .map_err(|e| format!("HTTP Client Error: {}", e))
}

fn auth_headers(token: &str) -> HeaderMap {
    let mut headers = HeaderMap::new();
    if !token.is_empty() {
        if let Ok(val) = HeaderValue::from_str(&format!("Bearer {}", token)) {
            headers.insert(AUTHORIZATION, val);
        }
    }
    headers
}

fn api_tree_base() -> String {
    "https://huggingface.co/api/datasets/Immaking/Luas/tree/main".to_string()
}

fn raw_base() -> String {
    "https://huggingface.co/datasets/Immaking/Luas/raw/main".to_string()
}

fn pct_encode(s: &str) -> String {
    s.chars()
        .map(|c| match c {
            ' ' => "%20".to_string(),
            '(' => "%28".to_string(),
            ')' => "%29".to_string(),
            _ => c.to_string(),
        })
        .collect()
}

fn catalog_folder_appid(folder_name: &str) -> Option<u32> {
    let open = folder_name.rfind('(')?;
    let close = folder_name.rfind(')')?;
    if close <= open + 1 {
        return None;
    }
    folder_name[open + 1..close].trim().parse::<u32>().ok()
}

fn validate_catalog_identity(appid: u32, folder_name: &str) -> Result<(), String> {
    let folder_appid = catalog_folder_appid(folder_name).ok_or_else(|| {
        format!(
            "DEPOT_CATALOG_INVALID: thư mục kho '{}' không chứa AppID hợp lệ.",
            folder_name
        )
    })?;

    if folder_appid != appid {
        return Err(format!(
            "DEPOT_SELECTION_MISMATCH: game đang chọn là AppID {} nhưng thư mục kho '{}' thuộc AppID {}. Hãy chọn lại game trước khi tải.",
            appid, folder_name, folder_appid
        ));
    }

    Ok(())
}

// ─── Types ────────────────────────────────────────────────────────────────────

#[derive(Deserialize, Debug)]
struct HfNode {
    #[serde(rename = "type")]
    node_type: String,
    path: String,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct DepotGameItem {
    pub appid: u32,
    pub title: String,
    pub folder_name: String,
    pub banner_url: Option<String>,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct DepotManifestInfo {
    pub depot_id: u32,
    pub manifest_gid: String,
    pub manifest_file: String,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct DepotBuildOption {
    pub build_id: String,
    pub version: Option<String>,
    pub build_date: Option<String>,
    pub manifests: Vec<DepotManifestInfo>,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct DepotGameDetail {
    pub appid: u32,
    pub title: String,
    pub folder_name: String,
    pub builds: Vec<DepotBuildOption>,
    pub has_key: bool,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct DepotDownloadProgressEvent {
    pub event_type: String, // "start" | "depot-start" | "progress" | "log" | "depot-done" | "paused" | "resumed" | "complete" | "error" | "cancelled"
    pub appid: u32,
    pub build_id: String,
    pub depot_id: Option<String>,
    pub message: Option<String>,
    pub current_depot_index: usize,
    pub total_depots: usize,
    pub progress_percent: Option<f64>,
    pub speed_mbps: Option<f64>,
    pub transferred_bytes: Option<u64>,
    pub total_bytes: Option<u64>,
    pub success: Option<bool>,
    #[serde(default)]
    pub phase: Option<String>,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct DepotDownloaderStatus {
    pub is_downloading: bool,
    pub is_paused: bool,
    pub can_resume: bool,
    pub active_appid: Option<u32>,
    pub active_build_id: Option<String>,
    pub destination_dir: Option<String>,
}

#[derive(Serialize, Deserialize, Debug, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct DepotInstallState {
    pub appid: u32,
    pub installed_build_id: Option<String>,
    pub manifests: HashMap<String, String>,
    pub completed_unix: Option<u64>,
    pub has_depot_state: bool,
}

// ─── Active Download State ───────────────────────────────────────────────────

static ACTIVE_DOWNLOAD: Lazy<Mutex<Option<ActiveDownloadState>>> = Lazy::new(|| Mutex::new(None));
static CANCEL_REQUESTED: Lazy<AtomicBool> = Lazy::new(|| AtomicBool::new(false));
static PAUSE_REQUESTED: Lazy<AtomicBool> = Lazy::new(|| AtomicBool::new(false));

#[derive(Clone)]
struct ActiveDownloadState {
    appid: u32,
    folder_name: String,
    build_id: String,
    destination_dir: String,
    max_downloads: u32,
    verify_all: bool,
    child_process_id: Option<u32>,
    paused: bool,
    selections: Option<Vec<SelectiveDepotSelection>>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PipelineOutcome {
    Completed,
    Paused,
}

fn launcher_depot_state_dir(destination_dir: &Path) -> PathBuf {
    destination_dir.join(".DepotDownloader").join("0xolemon")
}

fn version_state_path(destination_dir: &Path) -> PathBuf {
    launcher_depot_state_dir(destination_dir).join("version-state.json")
}

fn manifest_cache_dir(destination_dir: &Path, build_id: &str) -> PathBuf {
    launcher_depot_state_dir(destination_dir)
        .join("versions")
        .join(format!("BuildID_{}", build_id))
}

/// Scan a launcher manifest cache folder and return all `.manifest` files as DepotManifestInfo.
/// Used as offline fallback when HF service is unreachable (mirrors HubcapTools
/// "MRC down → served from depotcache only" logic).
fn scan_local_manifest_cache(cache_dir: &Path) -> Result<Vec<DepotManifestInfo>, String> {
    if !cache_dir.is_dir() {
        return Ok(Vec::new());
    }
    let entries = fs::read_dir(cache_dir).map_err(|e| {
        format!("Không đọc được cache manifest cục bộ {}: {e}", cache_dir.display())
    })?;
    let mut manifests = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        let fname = path
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("")
            .to_string();
        if !fname.ends_with(".manifest") {
            continue;
        }
        let stem = fname.trim_end_matches(".manifest");
        if let Some(up) = stem.find('_') {
            let depot_str = &stem[..up];
            let gid_str = &stem[up + 1..];
            if let Ok(depot_id) = depot_str.parse::<u32>() {
                manifests.push(DepotManifestInfo {
                    depot_id,
                    manifest_gid: gid_str.to_string(),
                    manifest_file: fname,
                });
            }
        }
    }
    manifests.sort_by_key(|m| m.depot_id);
    Ok(manifests)
}

/// Copy any `.manifest` files the user placed manually into
/// `<dest>/.DepotDownloader/` into the launcher's versioned cache so they are
/// preserved across retries (mirrors HubcapTools "PRESERVE on-disk manifest").
fn preserve_native_manifests_to_cache(destination_dir: &Path, cache_dir: &Path) {
    let native_dir = destination_dir.join(".DepotDownloader");
    if !native_dir.is_dir() {
        return;
    }
    let Ok(entries) = fs::read_dir(&native_dir) else { return };
    for entry in entries.flatten() {
        let src = entry.path();
        if src
            .extension()
            .and_then(|e| e.to_str())
            .map(|e| e.eq_ignore_ascii_case("manifest"))
            != Some(true)
        {
            continue;
        }
        let fname = src.file_name().unwrap_or_default();
        let dst = cache_dir.join(fname);
        // Only copy if launcher cache does NOT yet have this file — never overwrite
        if !dst.exists() {
            let _ = fs::copy(&src, &dst);
        }
    }
}

fn read_install_state_path(destination_dir: &Path, appid: u32) -> DepotInstallState {
    let state_path = version_state_path(destination_dir);
    if let Ok(bytes) = fs::read(&state_path) {
        if let Ok(state) = serde_json::from_slice::<DepotInstallState>(&bytes) {
            if state.appid == appid {
                return state;
            }
        }
    }
    DepotInstallState {
        appid,
        installed_build_id: None,
        manifests: HashMap::new(),
        completed_unix: None,
        has_depot_state: destination_dir.join(".DepotDownloader").is_dir(),
    }
}

fn write_install_state(
    destination_dir: &Path,
    appid: u32,
    build_id: &str,
    manifests: &[DepotManifestInfo],
) -> Result<(), String> {
    let state_dir = launcher_depot_state_dir(destination_dir);
    fs::create_dir_all(&state_dir)
        .map_err(|e| format!("Could not create Depot state folder: {e}"))?;
    let manifest_map = manifests
        .iter()
        .map(|m| (m.depot_id.to_string(), m.manifest_gid.clone()))
        .collect::<HashMap<_, _>>();
    let completed_unix = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .ok()
        .map(|value| value.as_secs());
    let state = DepotInstallState {
        appid,
        installed_build_id: Some(build_id.to_string()),
        manifests: manifest_map,
        completed_unix,
        has_depot_state: true,
    };
    let bytes = serde_json::to_vec_pretty(&state)
        .map_err(|e| format!("Could not serialize Depot version state: {e}"))?;
    let path = version_state_path(destination_dir);
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, bytes).map_err(|e| format!("Could not write Depot version state: {e}"))?;
    if path.exists() {
        let _ = fs::remove_file(&path);
    }
    fs::rename(&tmp, &path).map_err(|e| format!("Could not commit Depot version state: {e}"))
}

/// Seed DepotDownloaderMod's native manifest cache rather than using
/// `-manifestfile`. In this fork, `-manifestfile` replaces `oldManifest` with
/// the supplied target manifest, which prevents A -> B deleted-file diffing.
/// The normal code path loads `<depot>_<gid>.manifest` plus its raw SHA-1 from
/// `.DepotDownloader`, preserving the real previous manifest from depot.config.
pub(crate) fn seed_native_manifest_cache(
    destination_dir: &Path,
    manifest_path: &Path,
) -> Result<PathBuf, String> {
    let file_name = manifest_path
        .file_name()
        .ok_or_else(|| "Manifest cache source has no file name".to_string())?;
    let native_dir = destination_dir.join(".DepotDownloader");
    fs::create_dir_all(&native_dir)
        .map_err(|e| format!("Could not create DepotDownloader native manifest cache: {e}"))?;

    let native_path = native_dir.join(file_name);
    if manifest_path != native_path {
        fs::copy(manifest_path, &native_path).map_err(|e| {
            format!(
                "Could not seed native DepotDownloader manifest {}: {e}",
                native_path.display()
            )
        })?;
    }

    let bytes = fs::read(&native_path).map_err(|e| {
        format!(
            "Could not hash native DepotDownloader manifest {}: {e}",
            native_path.display()
        )
    })?;
    let digest = Sha1::digest(&bytes);
    let sha_path = native_dir.join(format!("{}.sha", file_name.to_string_lossy()));
    fs::write(&sha_path, digest.as_slice()).map_err(|e| {
        format!(
            "Could not write native DepotDownloader manifest checksum {}: {e}",
            sha_path.display()
        )
    })?;
    Ok(native_path)
}

/// Compatibility migration for downloads completed by older launcher builds:
/// replay every cached manifest for the recorded BuildID into the fork's
/// `.DepotDownloader` cache so depot.config can resolve the true old manifest.
fn seed_previous_build_manifests(destination_dir: &Path, build_id: &str) -> Result<usize, String> {
    let cache = manifest_cache_dir(destination_dir, build_id);
    if !cache.is_dir() {
        return Ok(0);
    }
    let mut seeded = 0usize;
    let entries = fs::read_dir(&cache).map_err(|e| {
        format!(
            "Could not read cached BuildID manifests {}: {e}",
            cache.display()
        )
    })?;
    for entry in entries {
        let entry = entry.map_err(|e| format!("Could not inspect cached BuildID manifest: {e}"))?;
        let path = entry.path();
        if path
            .extension()
            .and_then(|value| value.to_str())
            .map(|value| value.eq_ignore_ascii_case("manifest"))
            != Some(true)
        {
            continue;
        }
        seed_native_manifest_cache(destination_dir, &path)?;
        seeded += 1;
    }
    Ok(seeded)
}

// ─── DepotDownloader Binary Resolution ───────────────────────────────────────

pub fn resolve_depot_downloader_exe(app: &AppHandle) -> Result<PathBuf, String> {
    // 1. Check if packaged or installed via sff_packages
    if let Some(installed) =
        crate::sff_packages::resolve_installed_entrypoint("depot-downloader-mod")
    {
        if installed.is_file() {
            return Ok(installed);
        }
    }

    // 2. Check in src-tauri/binaries/ (development/direct release single-file executable)
    //    and inside the installed bundle (resource_dir), where `binaries/**/*` is
    //    copied by `bundle.resources` in tauri.conf.json.
    let binaries_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("binaries");
    let mut candidates = Vec::new();
    if let Ok(resource_dir) = app.path().resource_dir() {
        // Match both the `binaries/**/*` layout and a `resources/binaries/**/*` one.
        for bundled in [resource_dir.join("binaries"), resource_dir.join("resources").join("binaries")]
        {
            candidates.push(bundled.join("DepotDownloaderMod-x86_64-pc-windows-msvc.exe"));
            candidates.push(
                bundled
                    .join("_ddmod_pub")
                    .join("DepotDownloaderMod.exe"),
            );
        }
    }
    candidates.push(binaries_dir.join("DepotDownloaderMod-x86_64-pc-windows-msvc.exe"));
    candidates.push(
        binaries_dir
            .join("_ddmod_pub")
            .join("DepotDownloaderMod.exe"),
    );
    candidates.push(
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("target")
            .join("release")
            .join("DepotDownloaderMod.exe"),
    );
    candidates.push(PathBuf::from(
        r"E:\Among Us DepotDownloader\Among Us (945360)\DepotDownloaderMod\DepotDownloaderMod.exe",
    ));

    for candidate in &candidates {
        if candidate.is_file() {
            return Ok(candidate.clone());
        }
    }

    // 3. Fallback: try on-demand feature package download
    crate::sff_packages::ensure_feature_package("depot-downloader-mod")
}

// ─── Commands ───────────────────────────────────────────────────────────────

/// List all games available under the `Depotdownloader/` catalog on HuggingFace.
#[command]
pub async fn depot_downloader_get_catalog() -> Result<Vec<DepotGameItem>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let client = build_client()?;
        let token = get_hf_token();
        let url = format!("{}/Depotdownloader", api_tree_base());

        let resp = client
            .get(&url)
            .headers(auth_headers(&token))
            .send()
            .map_err(|e| format!("Không thể tải danh sách kho Depot: {}", e))?;

        if !resp.status().is_success() {
            return Err(format!("Lỗi kết nối máy chủ kho (HTTP {})", resp.status()));
        }

        let nodes: Vec<HfNode> = resp
            .json()
            .map_err(|e| format!("Lỗi phân tích dữ liệu kho: {}", e))?;

        let mut items = Vec::new();

        for node in nodes {
            if node.node_type != "directory" {
                continue;
            }
            let folder = node.path.split('/').last().unwrap_or("").to_string();
            // Format is: "<Game Title> (<AppID>)"
            if let Some(open_paren) = folder.rfind('(') {
                if let Some(close_paren) = folder.rfind(')') {
                    if close_paren > open_paren {
                        let appid_str = &folder[open_paren + 1..close_paren].trim();
                        let title = folder[..open_paren].trim().to_string();
                        if let Ok(appid) = appid_str.parse::<u32>() {
                            if appid > 0 {
                                let banner_url = Some(format!(
                                    "https://cdn.cloudflare.steamstatic.com/steam/apps/{}/header.jpg",
                                    appid
                                ));
                                items.push(DepotGameItem {
                                    appid,
                                    title: if title.is_empty() { format!("Game {}", appid) } else { title },
                                    folder_name: folder,
                                    banner_url,
                                });
                            }
                        }
                    }
                }
            }
        }

        items.sort_by(|a, b| a.title.to_lowercase().cmp(&b.title.to_lowercase()));
        Ok(items)
    })
    .await
    .map_err(|e| format!("Task error: {}", e))?
}

/// Fetch build versions, dates, manifests, and key status for a selected game.
#[command]
pub async fn depot_downloader_get_game_detail(
    appid: u32,
    folder_name: String,
) -> Result<DepotGameDetail, String> {
    validate_catalog_identity(appid, &folder_name)?;
    tauri::async_runtime::spawn_blocking(move || {
        let client = build_client()?;
        let token = get_hf_token();

        let rel_path = format!("Depotdownloader/{}/{}", folder_name, appid);
        let url = format!("{}/{}", api_tree_base(), pct_encode(&rel_path));

        let resp = client
            .get(&url)
            .headers(auth_headers(&token))
            .send()
            .map_err(|e| format!("Lỗi kết nối kho game: {}", e))?;

        if !resp.status().is_success() {
            return Err(format!(
                "Không tìm thấy dữ liệu game (HTTP {})",
                resp.status()
            ));
        }

        let nodes: Vec<HfNode> = resp
            .json()
            .map_err(|e| format!("Lỗi đọc cấu trúc game: {}", e))?;

        let mut raw_build_ids: Vec<String> = Vec::new();
        let mut has_key = false;

        for node in &nodes {
            let leaf = node.path.split('/').last().unwrap_or("");
            if node.node_type == "directory" {
                if let Some(stripped) = leaf
                    .strip_prefix("BuildID_")
                    .or_else(|| leaf.strip_prefix("BuildId_"))
                    .or_else(|| leaf.strip_prefix("buildid_"))
                {
                    raw_build_ids.push(stripped.to_string());
                }
            } else if node.node_type == "file" && leaf.ends_with(".key") {
                has_key = true;
            }
        }

        raw_build_ids.sort_by(|a, b| {
            b.parse::<u64>()
                .unwrap_or(0)
                .cmp(&a.parse::<u64>().unwrap_or(0))
        });

        let mut builds = Vec::new();
        for bid in &raw_build_ids {
            let build_rel = format!("Depotdownloader/{}/{}/BuildID_{}", folder_name, appid, bid);
            let build_url = format!("{}/{}", api_tree_base(), pct_encode(&build_rel));

            let mut manifests: Vec<DepotManifestInfo> = Vec::new();
            let mut version: Option<String> = None;

            if let Ok(b_resp) = client.get(&build_url).headers(auth_headers(&token)).send() {
                if b_resp.status().is_success() {
                    if let Ok(b_nodes) = b_resp.json::<Vec<HfNode>>() {
                        for file in &b_nodes {
                            let fname = file.path.split('/').last().unwrap_or("").to_string();
                            if fname.ends_with(".manifest") {
                                let stem = fname.trim_end_matches(".manifest");
                                if let Some(up) = stem.find('_') {
                                    let depot_str = &stem[..up];
                                    let gid_str = &stem[up + 1..];
                                    if let Ok(depot_id) = depot_str.parse::<u32>() {
                                        manifests.push(DepotManifestInfo {
                                            depot_id,
                                            manifest_gid: gid_str.to_string(),
                                            manifest_file: fname,
                                        });
                                    }
                                }
                            } else if fname == "version.txt" {
                                let ver_rel = format!(
                                    "Depotdownloader/{}/{}/BuildID_{}/version.txt",
                                    folder_name, appid, bid
                                );
                                let ver_url = format!("{}/{}", raw_base(), pct_encode(&ver_rel));
                                if let Ok(vr) =
                                    client.get(&ver_url).headers(auth_headers(&token)).send()
                                {
                                    if vr.status().is_success() {
                                        version = vr.text().ok().map(|t| t.trim().to_string());
                                    }
                                }
                            }
                        }
                    }
                }
            }

            manifests.sort_by(|a, b| a.depot_id.cmp(&b.depot_id));

            builds.push(DepotBuildOption {
                build_id: bid.clone(),
                version,
                build_date: None,
                manifests,
            });
        }

        // Try to fetch real update dates from SteamCMD API
        if let Ok(steamcmd_resp) = client
            .get(format!("https://api.steamcmd.net/v1/info/{}", appid))
            .send()
        {
            if steamcmd_resp.status().is_success() {
                if let Ok(json) = steamcmd_resp.json::<serde_json::Value>() {
                    if let Some(branches) = json
                        .get("data")
                        .and_then(|d| d.get(appid.to_string()))
                        .and_then(|a| a.get("depots"))
                        .and_then(|d| d.get("branches"))
                        .and_then(|b| b.as_object())
                    {
                        let mut date_map = HashMap::new();
                        for (_branch_name, branch_data) in branches {
                            if let Some(bid) = branch_data.get("buildid").and_then(|v| v.as_str()) {
                                if let Some(tupdate) =
                                    branch_data.get("timeupdated").and_then(|v| v.as_str())
                                {
                                    date_map.insert(bid.to_string(), tupdate.to_string());
                                }
                            }
                        }

                        for build in &mut builds {
                            if let Some(date_str) = date_map.get(&build.build_id) {
                                build.build_date = Some(date_str.clone());
                            }
                        }
                    }
                }
            }
        }

        Ok(DepotGameDetail {
            appid,
            title: folder_name
                .split('(')
                .next()
                .unwrap_or(&folder_name)
                .trim()
                .to_string(),
            folder_name,
            builds,
            has_key,
        })
    })
    .await
    .map_err(|e| format!("Task error: {}", e))?
}

/// Download a file from HuggingFace to a local path.
fn download_hf_raw_file(
    client: &Client,
    rel_path: &str,
    dest: &Path,
    token: &str,
) -> Result<(), String> {
    let url = format!("{}/{}", raw_base(), pct_encode(rel_path));
    let mut req = client.get(&url);
    if !token.is_empty() {
        req = req.bearer_auth(token);
    }
    let resp = req
        .send()
        .map_err(|e| format!("Lỗi tải tệp {}: {}", rel_path, e))?;

    if !resp.status().is_success() {
        return Err(format!(
            "Máy chủ từ chối tải tệp {} (HTTP {})",
            rel_path,
            resp.status()
        ));
    }

    let bytes = resp
        .bytes()
        .map_err(|e| format!("Lỗi đọc dữ liệu: {}", e))?;
    fs::write(dest, &bytes).map_err(|e| format!("Lỗi ghi tệp ra đĩa: {}", e))
}

/// Start a background DepotDownloaderMod task from a complete, immutable job snapshot.
fn launch_download_task(app: AppHandle, job: ActiveDownloadState) {
    let app_clone = app.clone();
    tauri::async_runtime::spawn(async move {
        let is_selective = job.selections.is_some();
        let total_depots = job.selections.as_ref().map(|s| s.len()).unwrap_or(0);
        let total_required = job
            .selections
            .as_ref()
            .map(|s| s.iter().map(|item| item.size).sum::<u64>())
            .unwrap_or(0);

        let result = if let Some(ref sel) = job.selections {
            run_selective_download_pipeline(
                &app_clone,
                job.appid,
                &job.folder_name,
                sel,
                &job.destination_dir,
                job.max_downloads,
                job.verify_all,
            )
        } else {
            run_download_pipeline(
                &app_clone,
                job.appid,
                &job.folder_name,
                &job.build_id,
                &job.destination_dir,
                job.max_downloads,
                job.verify_all,
            )
        };

        match result {
            Ok(PipelineOutcome::Completed) => {
                if let Ok(mut active) = ACTIVE_DOWNLOAD.lock() {
                    *active = None;
                }
                let _ = app_clone.emit(
                    "depot-download-progress",
                    DepotDownloadProgressEvent {
                        event_type: "complete".to_string(),
                        appid: job.appid,
                        build_id: job.build_id,
                        depot_id: None,
                        message: Some(if is_selective {
                            "Tải hoàn tất các depot đã chọn!".to_string()
                        } else {
                            "Tải hoàn tất toàn bộ depots của game!".to_string()
                        }),
                        current_depot_index: total_depots,
                        total_depots,
                        progress_percent: Some(100.0),
                        speed_mbps: None,
                        transferred_bytes: None,
                        total_bytes: if total_required > 0 {
                            Some(total_required)
                        } else {
                            None
                        },
                        success: Some(true),
                        phase: None,
                    },
                );
            }
            Ok(PipelineOutcome::Paused) => {
                if let Ok(mut active) = ACTIVE_DOWNLOAD.lock() {
                    if let Some(state) = active.as_mut() {
                        state.child_process_id = None;
                        state.paused = true;
                    }
                }
                let _ = app_clone.emit(
                    "depot-download-progress",
                    DepotDownloadProgressEvent {
                        event_type: "paused".to_string(),
                        appid: job.appid,
                        build_id: job.build_id,
                        depot_id: None,
                        message: Some(if is_selective {
                            "Đã tạm dừng tải. Dữ liệu hiện có được giữ nguyên.".to_string()
                        } else {
                            "Đã tạm dừng. Dữ liệu hiện có, .DepotDownloader và staging được giữ nguyên để tiếp tục.".to_string()
                        }),
                        current_depot_index: 0,
                        total_depots,
                        progress_percent: None,
                        speed_mbps: None,
                        transferred_bytes: None,
                        total_bytes: if total_required > 0 { Some(total_required) } else { None },
                        success: None,
                        phase: None,
                    },
                );
            }
            Err(error) => {
                let was_cancelled = CANCEL_REQUESTED.load(Ordering::SeqCst);
                if let Ok(mut active) = ACTIVE_DOWNLOAD.lock() {
                    *active = None;
                }
                let _ = app_clone.emit(
                    "depot-download-progress",
                    DepotDownloadProgressEvent {
                        event_type: if was_cancelled {
                            "cancelled".to_string()
                        } else {
                            "error".to_string()
                        },
                        appid: job.appid,
                        build_id: job.build_id,
                        depot_id: None,
                        message: Some(if was_cancelled {
                            "Tiến trình tải đã bị hủy bởi người dùng.".to_string()
                        } else {
                            error
                        }),
                        current_depot_index: 0,
                        total_depots,
                        progress_percent: None,
                        speed_mbps: None,
                        transferred_bytes: None,
                        total_bytes: if total_required > 0 {
                            Some(total_required)
                        } else {
                            None
                        },
                        success: Some(false),
                        phase: None,
                    },
                );
            }
        }
    });
}

/// Start downloading game files directly via DepotDownloaderMod.
#[command]
pub async fn depot_downloader_start_download(
    app: AppHandle,
    appid: u32,
    folder_name: String,
    build_id: String,
    destination_dir: String,
    max_downloads: Option<u32>,
    verify_all: Option<bool>,
) -> Result<String, String> {
    validate_catalog_identity(appid, &folder_name)?;
    let max_concurrency = max_downloads.unwrap_or(64).clamp(1, 256);
    let do_verify = verify_all.unwrap_or(true);

    let job = ActiveDownloadState {
        appid,
        folder_name,
        build_id,
        destination_dir,
        max_downloads: max_concurrency,
        verify_all: do_verify,
        child_process_id: None,
        paused: false,
        selections: None,
    };

    {
        let mut active = ACTIVE_DOWNLOAD.lock().map_err(|_| "Lock error")?;
        if active.is_some() {
            return Err(
                "Đang có một tiến trình tải hoặc một phiên tạm dừng chưa hoàn tất.".to_string(),
            );
        }
        CANCEL_REQUESTED.store(false, Ordering::SeqCst);
        PAUSE_REQUESTED.store(false, Ordering::SeqCst);
        *active = Some(job.clone());
    }

    launch_download_task(app, job);
    Ok("Depot download started".to_string())
}

/// Pause by stopping the DepotDownloaderMod child process while preserving the
/// game files, .DepotDownloader/depot.config, staging, and cached manifests.
#[command]
pub fn depot_downloader_pause_download() -> Result<bool, String> {
    PAUSE_REQUESTED.store(true, Ordering::SeqCst);
    CANCEL_REQUESTED.store(false, Ordering::SeqCst);
    let mut active = ACTIVE_DOWNLOAD.lock().map_err(|_| "Lock error")?;
    let state = active
        .as_mut()
        .ok_or_else(|| "Không có tiến trình DepotDownloader đang chạy.".to_string())?;
    if state.paused {
        return Ok(true);
    }
    if let Some(pid) = state.child_process_id {
        #[cfg(target_os = "windows")]
        {
            use std::os::windows::process::CommandExt;
            let _ = Command::new("taskkill")
                .args(["/F", "/T", "/PID", &pid.to_string()])
                .creation_flags(0x08000000)
                .status();
        }
        #[cfg(not(target_os = "windows"))]
        {
            let _ = pid;
        }
    }
    Ok(true)
}

/// Resume the exact paused job. DepotDownloaderMod re-opens its existing
/// .DepotDownloader state and verifies/reuses already-valid chunks.
#[command]
pub async fn depot_downloader_resume_download(app: AppHandle) -> Result<String, String> {
    let job = {
        let mut active = ACTIVE_DOWNLOAD.lock().map_err(|_| "Lock error")?;
        let state = active
            .as_mut()
            .ok_or_else(|| "Không có phiên tải nào để tiếp tục.".to_string())?;
        if !state.paused {
            return Err("Tiến trình DepotDownloader chưa ở trạng thái tạm dừng.".to_string());
        }
        state.paused = false;
        state.child_process_id = None;
        state.clone()
    };

    CANCEL_REQUESTED.store(false, Ordering::SeqCst);
    PAUSE_REQUESTED.store(false, Ordering::SeqCst);
    let _ = app.emit(
        "depot-download-progress",
        DepotDownloadProgressEvent {
            event_type: "resumed".to_string(),
            appid: job.appid,
            build_id: job.build_id.clone(),
            depot_id: None,
            message: Some(
                "Đang tiếp tục: kiểm tra dữ liệu đã có rồi chỉ tải các chunk còn thiếu/sai."
                    .to_string(),
            ),
            current_depot_index: 0,
            total_depots: 0,
            progress_percent: None,
            speed_mbps: None,
            transferred_bytes: None,
            total_bytes: None,
            success: None,
            phase: None,
        },
    );
    launch_download_task(app, job);
    Ok("Depot download resumed".to_string())
}

/// Read launcher-owned version metadata without touching DepotDownloader's own
/// compressed depot.config format.
#[command]
pub fn depot_downloader_get_install_state(
    appid: u32,
    destination_dir: String,
) -> Result<DepotInstallState, String> {
    Ok(read_install_state_path(Path::new(&destination_dir), appid))
}

/// Return locally-cached manifests for a given appid + build_id.
/// Frontend uses this to show an "Offline ready" badge and to know whether a
/// download can proceed without the HF service (HubcapTools-style depotcache).
#[command]
pub fn depot_downloader_get_cached_manifests(
    build_id: String,
    destination_dir: String,
) -> Result<Vec<DepotManifestInfo>, String> {
    let dest = Path::new(&destination_dir);
    let clean_build_id = build_id
        .strip_prefix("BuildID_")
        .or_else(|| build_id.strip_prefix("BuildId_"))
        .or_else(|| build_id.strip_prefix("buildid_"))
        .unwrap_or(&build_id)
        .trim();
    let cache = manifest_cache_dir(dest, clean_build_id);
    // Also honour manifests placed manually in .DepotDownloader/
    preserve_native_manifests_to_cache(dest, &cache);
    scan_local_manifest_cache(&cache)
}

fn run_download_pipeline(
    app: &AppHandle,
    appid: u32,
    folder_name: &str,
    build_id: &str,
    destination_dir: &str,
    max_concurrency: u32,
    do_verify: bool,
) -> Result<PipelineOutcome, String> {
    let exe = resolve_depot_downloader_exe(app)?;
    let client = build_client()?;
    let token = get_hf_token();

    // Create target dir
    let dest_path = PathBuf::from(destination_dir);
    fs::create_dir_all(&dest_path).map_err(|e| format!("Không thể tạo thư mục lưu game: {}", e))?;

    // Clean build ID
    let clean_build_id = build_id
        .strip_prefix("BuildID_")
        .or_else(|| build_id.strip_prefix("BuildId_"))
        .or_else(|| build_id.strip_prefix("buildid_"))
        .unwrap_or(build_id)
        .trim();

    let installed_state = read_install_state_path(&dest_path, appid);
    let is_version_switch = installed_state
        .installed_build_id
        .as_deref()
        .map(|current| current != clean_build_id)
        .unwrap_or(false);
    let effective_verify = do_verify || is_version_switch;

    // Keep target manifests beside the working copy so A -> B -> A can reuse
    // historical metadata without depending on the OS temp directory.
    let manifest_cache = manifest_cache_dir(&dest_path, clean_build_id);
    fs::create_dir_all(&manifest_cache)
        .map_err(|e| format!("Không thể tạo cache manifest theo BuildID: {e}"))?;

    if let Some(previous_build) = installed_state.installed_build_id.as_deref() {
        let _ = seed_previous_build_manifests(&dest_path, previous_build)?;
    }

    let start_message = if is_version_switch {
        format!(
            "Chuyển phiên bản {} → {}: giữ nguyên dữ liệu hiện có, .DepotDownloader/staging và bắt buộc verify chunk trước khi tải phần khác biệt.",
            installed_state.installed_build_id.as_deref().unwrap_or("unknown"),
            clean_build_id
        )
    } else {
        "Đang tải các file mã khóa (Key) và Manifest từ kho lưu trữ...".to_string()
    };

    let _ = app.emit(
        "depot-download-progress",
        DepotDownloadProgressEvent {
            event_type: "start".to_string(),
            appid,
            build_id: clean_build_id.to_string(),
            depot_id: None,
            message: Some(start_message),
            current_depot_index: 0,
            total_depots: 0,
            progress_percent: Some(0.0),
            speed_mbps: None,
            transferred_bytes: None,
            total_bytes: None,
            success: None,
            phase: None,
        },
    );

    // Download .key
    let key_rel = format!("Depotdownloader/{}/{}/{}.key", folder_name, appid, appid);
    let key_local = manifest_cache.join(format!("{}.key", appid));
    if !key_local.is_file() {
        download_hf_raw_file(&client, &key_rel, &key_local, &token)?;
    }

    // ── Preserve any manifests the user placed manually into .DepotDownloader/ ──
    // Mirrors HubcapTools "PRESERVE on-disk manifest" — copy to versioned cache
    // BEFORE any network call so they survive even if HF lookup succeeds and
    // would otherwise overwrite them later.
    preserve_native_manifests_to_cache(&dest_path, &manifest_cache);

    // ── Query manifests for this BuildID from HF (primary path) ──────────────
    let build_rel = format!(
        "Depotdownloader/{}/{}/BuildID_{}",
        folder_name, appid, clean_build_id
    );
    let build_url = format!("{}/{}", api_tree_base(), pct_encode(&build_rel));

    let manifests: Vec<DepotManifestInfo> = match client
        .get(&build_url)
        .headers(auth_headers(&token))
        .send()
    {
        Err(net_err) => {
            // Network unreachable — try local cache first (MRC down path)
            let cached = scan_local_manifest_cache(&manifest_cache)?;
            if cached.is_empty() {
                return Err(format!(
                    "SERVICE_DOWN_NO_CACHE: Không thể kết nối kho manifest ({net_err}) và không có manifest nào được cache cục bộ cho BuildID {clean_build_id}. Hãy kết nối mạng hoặc đặt file .manifest vào thư mục .DepotDownloader của game."
                ));
            }
            let _ = app.emit(
                "depot-download-progress",
                DepotDownloadProgressEvent {
                    event_type: "service-down-cache-fallback".to_string(),
                    appid,
                    build_id: clean_build_id.to_string(),
                    depot_id: None,
                    message: Some(format!(
                        "⚠ Kho manifest offline — đang dùng {} manifest đã cache cục bộ cho BuildID {clean_build_id}.",
                        cached.len()
                    )),
                    current_depot_index: 0,
                    total_depots: cached.len(),
                    progress_percent: Some(0.0),
                    speed_mbps: None,
                    transferred_bytes: None,
                    total_bytes: None,
                    success: None,
                    phase: Some("cache-fallback".to_string()),
                },
            );
            cached
        }
        Ok(b_resp) => {
            let code = b_resp.status();
            if !code.is_success() {
                // HTTP error — also try local cache before failing
                let cached = scan_local_manifest_cache(&manifest_cache)?;
                if !cached.is_empty() {
                    let _ = app.emit(
                        "depot-download-progress",
                        DepotDownloadProgressEvent {
                            event_type: "service-down-cache-fallback".to_string(),
                            appid,
                            build_id: clean_build_id.to_string(),
                            depot_id: None,
                            message: Some(format!(
                                "⚠ Kho manifest trả lỗi HTTP {code} — đang dùng {} manifest đã cache cục bộ.",
                                cached.len()
                            )),
                            current_depot_index: 0,
                            total_depots: cached.len(),
                            progress_percent: Some(0.0),
                            speed_mbps: None,
                            transferred_bytes: None,
                            total_bytes: None,
                            success: None,
                            phase: Some("cache-fallback".to_string()),
                        },
                    );
                    cached
                } else if code.as_u16() == 404 {
                    return Err(format!(
                        "DEPOT_BUILD_NOT_FOUND: BuildID {} không còn tồn tại trong kho cho {} (AppID {}). Hãy làm mới danh mục, chọn lại game/build rồi tải lại.",
                        clean_build_id, folder_name, appid
                    ));
                } else {
                    let txt = b_resp.text().unwrap_or_default();
                    return Err(format!("Lỗi kết nối máy chủ kho (HTTP {}): {}", code, txt));
                }
            } else {
                // Success — parse manifest list from HF API
                let b_nodes: Vec<HfNode> = b_resp
                    .json()
                    .map_err(|e| format!("Lỗi phân tích manifest nodes: {e}"))?;
                let mut list: Vec<DepotManifestInfo> = Vec::new();
                for file in &b_nodes {
                    let fname = file.path.split('/').last().unwrap_or("").to_string();
                    if fname.ends_with(".manifest") {
                        let stem = fname.trim_end_matches(".manifest");
                        if let Some(up) = stem.find('_') {
                            let depot_str = &stem[..up];
                            let gid_str = &stem[up + 1..];
                            if let Ok(depot_id) = depot_str.parse::<u32>() {
                                list.push(DepotManifestInfo {
                                    depot_id,
                                    manifest_gid: gid_str.to_string(),
                                    manifest_file: fname,
                                });
                            }
                        }
                    }
                }
                // If HF returned success but empty list, still try local cache
                if list.is_empty() {
                    let cached = scan_local_manifest_cache(&manifest_cache)?;
                    if cached.is_empty() {
                        return Err(format!(
                            "Không tìm thấy tệp manifest nào cho BuildID {}",
                            clean_build_id
                        ));
                    }
                    cached
                } else {
                    list
                }
            }
        }
    };

    let mut manifests = manifests;
    manifests.sort_by(|a, b| a.depot_id.cmp(&b.depot_id));
    let total_depots = manifests.len();

    // Iterate through each depot and run DepotDownloaderMod
    for (index, m_info) in manifests.iter().enumerate() {
        if PAUSE_REQUESTED.load(Ordering::SeqCst) {
            return Ok(PipelineOutcome::Paused);
        }
        if CANCEL_REQUESTED.load(Ordering::SeqCst) {
            return Err("Cancelled by user".to_string());
        }

        // Persist each BuildID's manifest instead of leaving it in %TEMP%.
        let manifest_rel = format!("{}/{}", build_rel, m_info.manifest_file);
        let manifest_local = manifest_cache.join(&m_info.manifest_file);
        if !manifest_local.is_file() {
            if let Some(bytes) = fetch_priority_manifest_bytes(
                app,
                appid,
                m_info.depot_id,
                &m_info.manifest_gid,
            ) {
                fs::write(&manifest_local, bytes)
                    .map_err(|e| format!("Could not save provider manifest: {e}"))?;
            } else {
                // Last resort: legacy Hugging Face Depotdownloader mirror.
                download_hf_raw_file(&client, &manifest_rel, &manifest_local, &token)?;
            }
        }
        // Pre-seed the fork's own cache with the target manifest and checksum.
        // This keeps UseManifestFile=false so `previousManifest` comes from the
        // actual InstalledManifestIDs entry and obsolete files can be deleted.
        seed_native_manifest_cache(&dest_path, &manifest_local)?;

        let _ = app.emit(
            "depot-download-progress",
            DepotDownloadProgressEvent {
                event_type: "depot-start".to_string(),
                appid,
                build_id: clean_build_id.to_string(),
                depot_id: Some(m_info.depot_id.to_string()),
                message: Some(format!(
                    "[{}/{}] Bắt đầu tải Depot {}...",
                    index + 1,
                    total_depots,
                    m_info.depot_id
                )),
                current_depot_index: index + 1,
                total_depots,
                progress_percent: Some(((index as f64) / (total_depots as f64)) * 100.0),
                speed_mbps: None,
                transferred_bytes: None,
                total_bytes: None,
                success: None,
                phase: Some("manifest".to_string()),
            },
        );

        // Build command
        let mut cmd = Command::new(&exe);
        cmd.arg("-app")
            .arg(appid.to_string())
            .arg("-depot")
            .arg(m_info.depot_id.to_string())
            .arg("-manifest")
            .arg(&m_info.manifest_gid)
            .arg("-depotkeys")
            .arg(&key_local)
            .arg("-dir")
            .arg(destination_dir)
            .arg("-max-downloads")
            .arg(max_concurrency.to_string())
            .arg("-cellid")
            .arg(steam_cell_id().to_string())
            .arg("-progress")
            .arg("line");

        if effective_verify {
            cmd.arg("-verify-all");
        }

        #[cfg(target_os = "windows")]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
        }

        cmd.stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped());

        let mut child = cmd
            .spawn()
            .map_err(|e| format!("Không thể khởi chạy DepotDownloaderMod: {}", e))?;

        // Record child PID for cancellation
        if let Ok(mut active) = ACTIVE_DOWNLOAD.lock() {
            if let Some(ref mut state) = *active {
                state.child_process_id = Some(child.id());
            }
        }

        let mut current_phase: Option<String> = None;

        let mut last_speed_calc = std::time::Instant::now();
        let mut last_speed_pct: f64 = 0.0;
        let mut dynamic_speed_mbps: Option<f64> = None;

        // Stream stdout line-by-line
        if let Some(stdout) = child.stdout.take() {
            let reader = std::io::BufReader::new(stdout);
            for line in reader.lines().flatten() {
                let trimmed = line.trim().to_string();
                if trimmed.is_empty() {
                    continue;
                }

                if PAUSE_REQUESTED.load(Ordering::SeqCst) {
                    let _ = child.kill();
                    return Ok(PipelineOutcome::Paused);
                }
                if CANCEL_REQUESTED.load(Ordering::SeqCst) {
                    let _ = child.kill();
                    return Err("Cancelled by user".to_string());
                }

                if trimmed.starts_with("Pre-allocating ") {
                    current_phase = Some("pre_allocating".to_string());
                } else if trimmed.starts_with("Validating ") {
                    current_phase = Some("validating".to_string());
                } else if trimmed.starts_with("Downloading depot ") {
                    current_phase = Some("downloading".to_string());
                }

                // Parse percentage from stdout lines (e.g. "12.34%" or "[12.34%]")
                let mut parsed_pct: Option<f64> = None;
                if let Some(pct_idx) = trimmed.find('%') {
                    let before = &trimmed[..pct_idx];
                    let num_str: String = before
                        .chars()
                        .rev()
                        .take_while(|c| c.is_digit(10) || *c == '.')
                        .collect();
                    let num_str: String = num_str.chars().rev().collect();
                    if let Ok(pct) = num_str.parse::<f64>() {
                        // Blend overall progress
                        let depot_fraction = (index as f64) / (total_depots as f64);
                        let depot_weight = 1.0 / (total_depots as f64);
                        let total_pct = (depot_fraction + (pct / 100.0) * depot_weight) * 100.0;
                        parsed_pct = Some(total_pct.min(99.9));
                    }
                }

                // Parse speed from line if available
                let mut parsed_speed_mbps: Option<f64> = None;
                if let Ok(re_speed) =
                    regex::Regex::new(r#"(?i)(\d+(?:\.\d+)?)\s*(kb|mb|gb|kib|mib|gib|b)/s"#)
                {
                    if let Some(cap) = re_speed.captures(&trimmed) {
                        if let (Some(num_m), Some(unit_m)) = (cap.get(1), cap.get(2)) {
                            if let Ok(num) = num_m.as_str().parse::<f64>() {
                                let unit = unit_m.as_str().to_lowercase();
                                let mbps = match unit.as_str() {
                                    "gb" | "gib" => num * 1024.0,
                                    "mb" | "mib" => num,
                                    "kb" | "kib" => num / 1024.0,
                                    _ => num / (1024.0 * 1024.0),
                                };
                                parsed_speed_mbps = Some(mbps);
                            }
                        }
                    }
                }

                // Dynamic speed calculation if stdout line did not provide explicit speed
                if let Some(cur_pct) = parsed_pct {
                    let elapsed = last_speed_calc.elapsed().as_secs_f64();
                    if elapsed >= 0.5 {
                        if cur_pct >= last_speed_pct {
                            let delta_pct = cur_pct - last_speed_pct;
                            // Estimate bytes from percentage delta
                            let estimated_delta_bytes = (delta_pct / 100.0) * 1_000_000_000.0; // scale factor
                            let bps = estimated_delta_bytes / elapsed;
                            dynamic_speed_mbps = Some((bps / (1024.0 * 1024.0)).max(0.1));
                        }
                        last_speed_calc = std::time::Instant::now();
                        last_speed_pct = cur_pct;
                    }
                }

                let effective_speed = parsed_speed_mbps.or(dynamic_speed_mbps);

                let _ = app.emit(
                    "depot-download-progress",
                    DepotDownloadProgressEvent {
                        event_type: "log".to_string(),
                        appid,
                        build_id: clean_build_id.to_string(),
                        depot_id: Some(m_info.depot_id.to_string()),
                        message: Some(trimmed),
                        current_depot_index: index + 1,
                        total_depots,
                        progress_percent: parsed_pct,
                        speed_mbps: effective_speed,
                        transferred_bytes: None,
                        total_bytes: None,
                        success: None,
                        phase: current_phase.clone(),
                    },
                );
            }
        }

        let wait_res = child.wait();
        if PAUSE_REQUESTED.load(Ordering::SeqCst) {
            return Ok(PipelineOutcome::Paused);
        }
        if CANCEL_REQUESTED.load(Ordering::SeqCst) {
            return Err("Cancelled by user".to_string());
        }
        let status = wait_res.map_err(|e| format!("DepotDownloaderMod wait error: {}", e))?;
        if !status.success() {
            return Err(format!(
                "Lỗi trong quá trình tải depot {}: Mã thoát {:?}",
                m_info.depot_id,
                status.code()
            ));
        }

        let _ = app.emit(
            "depot-download-progress",
            DepotDownloadProgressEvent {
                event_type: "depot-done".to_string(),
                appid,
                build_id: clean_build_id.to_string(),
                depot_id: Some(m_info.depot_id.to_string()),
                message: Some(format!("Depot {} hoàn tất.", m_info.depot_id)),
                current_depot_index: index + 1,
                total_depots,
                progress_percent: Some(((index + 1) as f64 / (total_depots as f64)) * 100.0),
                speed_mbps: None,
                transferred_bytes: None,
                total_bytes: None,
                success: Some(true),
                phase: None,
            },
        );
    }

    write_install_state(&dest_path, appid, clean_build_id, &manifests)?;
    Ok(PipelineOutcome::Completed)
}

/// After a Steam-direct depot download finishes, make the game visible to the rest of the
/// launcher exactly like a normal install: register the install record (so it shows up in the
/// Library with a Play button) and create a Steam non-Steam-game shortcut the same way Steam does.
#[command]
pub fn depot_downloader_finalize_install(
    app: AppHandle,
    appid: u32,
    destination_dir: String,
    launch_executable: Option<String>,
    title: Option<String>,
    build_id: Option<String>,
    launch_arguments: Option<Vec<String>>,
) -> Result<FinalizeInstallOutcome, String> {
    let install_root = PathBuf::from(&destination_dir);
    if !install_root.is_dir() {
        return Err(format!(
            "Thư mục cài đặt không tồn tại: {}",
            install_root.display()
        ));
    }

    // Install under the canonical launcher game id (e.g. "geometry-dash") rather than the raw
    // Steam AppID. Library ownership, install discovery and the Steam AppID mapping are all keyed
    // by the launcher id, so registering "322170" produced a game the Library could never show
    // and that the discovery scan could never classify.
    let game_id = crate::remote_paths::canonical_game_id_for_appid(appid)
        .map(str::to_string)
        .unwrap_or_else(|| appid.to_string());

    // The exe path that gets persisted and handed to `launch_game` must stay *relative* to the
    // install root; an absolute path is rejected by the launcher's path-safety check. Only an exe
    // that actually exists inside the install root is kept, otherwise fall back to discovery.
    let executable = launch_executable
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .and_then(|value| normalize_launch_executable(&install_root, value))
        .or_else(|| discover_launch_executable(&install_root))
        .ok_or_else(|| {
            "Không xác định được file chạy (exe) của game để tạo shortcut. Metadata GitHub không có config.launch.".to_string()
        })?;

    // 1. Commit the launcher install marker (`state.0xo`). This is the commit point the whole
    //    launcher reads: without it `launch_game` reports "not installed", install discovery
    //    cannot classify the folder, and the Library shows no Play button.
    crate::job::commit_external_install_marker(
        &install_root,
        &game_id,
        "steam-direct",
        &executable,
    )
    .map_err(|error| error.to_string())?;

    // 2. Register the install record so Library / install-state agree the game exists.
    crate::platform::register_install(
        &app,
        &game_id,
        &install_root,
        "steam-direct",
        &executable,
    )?;

    // 3. Materialise the multi-launch config so Play reads the real launch options
    //    (and their arguments) straight from the GitHub metadata instead of guessing an exe.
    let mut launch_options_written = false;
    if let Some(config) = build_external_launch_config(
        &install_root,
        &game_id,
        &executable,
        launch_arguments.as_deref(),
    ) {
        launch_options_written = true;
        let _ = write_external_launch_config(&install_root, &config);
    }

    // 4. Create the Steam shortcut (shortcuts.vdf) like Steam itself does.
    let shortcut_title = title
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(&game_id)
        .to_string();
    // Let Steam/Windows derive the icon from the game executable itself.
    let shortcut = crate::steam_integration::ensure_game_shortcut(
        &app,
        &game_id,
        &shortcut_title,
        &install_root,
        &executable,
        None,
    );

    // 5. Create the Windows desktop shortcut pointing to the real installed game
    let full_executable = install_root.join(&executable);
    let _ = crate::job::create_desktop_shortcut_for_install(
        &app,
        &game_id,
        &install_root,
        &full_executable,
        &executable,
    );

    Ok(FinalizeInstallOutcome {
        game_id,
        install_path: install_root.display().to_string(),
        launch_executable: executable,
        install_version: build_id
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .unwrap_or("steam-direct")
            .to_string(),
        launch_options_written,
        shortcut_queued: shortcut.as_ref().map(|outcome| outcome.queued).unwrap_or(false),
        shortcut_error: shortcut.err(),
    })
}

/// Accept only an executable that resolves to a real file inside the install root, and return it
/// as a path relative to that root (the form the launcher persists and validates).
fn normalize_launch_executable(install_root: &Path, candidate: &str) -> Option<String> {
    let cleaned = candidate.trim().replace('/', "\\");
    if cleaned.is_empty() {
        return None;
    }

    if let Ok(relative) = Path::new(&cleaned).strip_prefix(install_root) {
        let relative = relative.to_string_lossy().trim_start_matches('\\').to_string();
        return (!relative.is_empty() && install_root.join(&relative).is_file()).then_some(relative);
    }

    let absolute = install_root.join(&cleaned);
    // Reject unstaged downloads: DepotDownloaderMod writes the real files under `.DepotDownloader`.
    if cleaned
        .split('\\')
        .next()
        .is_some_and(|head| head.eq_ignore_ascii_case(".DepotDownloader"))
    {
        return None;
    }
    absolute.is_file().then_some(cleaned)
}

/// Build a single-option launch config (executable + its arguments) from the GitHub metadata.
/// Returns `None` when there is nothing useful to persist beyond the install marker.
fn build_external_launch_config(
    install_root: &Path,
    game_id: &str,
    executable: &str,
    launch_arguments: Option<&[String]>,
) -> Option<crate::launch::GameLaunchConfig> {
    use crate::launch::{GameLaunchConfig, GameLaunchOption, GameLaunchProcess};

    if install_root.join(executable).is_file() {
        // Nothing extra to declare: the install marker's executable already launches the game.
        return launch_arguments.filter(|args| !args.is_empty()).map(|args| {
            GameLaunchConfig {
                schema_version: 1,
                game_id: game_id.to_string(),
                picker_mode: "never".to_string(),
                default_option_id: "default".to_string(),
                options: vec![GameLaunchOption {
                    id: "default".to_string(),
                    title: "Play".to_string(),
                    description: String::new(),
                    recommended: true,
                    processes: vec![GameLaunchProcess {
                        path: executable.to_string(),
                        args: args.to_vec(),
                        working_directory: String::new(),
                        environment: std::collections::HashMap::new(),
                        run_as_admin: false,
                        hidden: None,
                        wait_for_exit: false,
                        delay_before_ms: 0,
                        delay_after_ms: 0,
                        optional: false,
                        role: "main".to_string(),
                    }],
                }],
            }
        });
    }
    None
}

fn write_external_launch_config(
    install_root: &Path,
    config: &crate::launch::GameLaunchConfig,
) -> Result<(), String> {
    let path = install_root.join("0xo-launch.json");
    let json = serde_json::to_string_pretty(config)
        .map_err(|error| format!("Could not serialize launch config: {error}"))?;
    fs::write(&path, json).map_err(|error| format!("Could not write {}: {error}", path.display()))
}


/// Resolve which launcher game id a Steam-direct install for `appid` is stored under.
/// The frontend needs this because the canonical id (e.g. "geometry-dash") differs from the
/// AppID (e.g. 322170) for every game listed in steam_appids_mapping.json.
#[command]
pub fn depot_downloader_resolve_game_id(appid: u32) -> String {
    crate::remote_paths::canonical_game_id_for_appid(appid)
        .map(str::to_string)
        .unwrap_or_else(|| appid.to_string())
}

/// Best-effort discovery of the primary game executable when metadata has no launch config.
/// Prefers an exe whose name matches the install folder, otherwise the largest top-level exe.
fn discover_launch_executable(install_root: &Path) -> Option<String> {
    let folder_raw = install_root
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("");
    let folder_hint = folder_raw
        .split(')')
        .next()
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase()
        .replace(' ', "");

    let entries = fs::read_dir(install_root).ok()?;
    let mut best: Option<(String, u64)> = None;
    let mut hinted: Option<(String, u64)> = None;
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let is_exe = path
            .extension()
            .and_then(|ext| ext.to_str())
            .is_some_and(|ext| ext.eq_ignore_ascii_case("exe"));
        if !is_exe {
            continue;
        }
        let name = path
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or("")
            .to_string();
        let size = entry.metadata().map(|meta| meta.len()).unwrap_or(0);
        if !folder_hint.is_empty() && name.to_ascii_lowercase().replace(' ', "").contains(&folder_hint) {
            if hinted.as_ref().is_none_or(|(_, best_size)| size > *best_size) {
                hinted = Some((name.clone(), size));
            }
        }
        if best.as_ref().is_none_or(|(_, best_size)| size > *best_size) {
            best = Some((name, size));
        }
    }
    hinted.or(best).map(|(name, _)| name)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FinalizeInstallOutcome {
    pub game_id: String,
    pub install_path: String,
    pub launch_executable: String,
    pub install_version: String,
    pub launch_options_written: bool,
    pub shortcut_queued: bool,
    pub shortcut_error: Option<String>,
}

/// Cancel the current active depot download task.
#[command]
pub fn depot_downloader_cancel_download() -> Result<bool, String> {
    CANCEL_REQUESTED.store(true, Ordering::SeqCst);
    PAUSE_REQUESTED.store(false, Ordering::SeqCst);

    let mut clear_immediately = false;
    if let Ok(mut active) = ACTIVE_DOWNLOAD.lock() {
        if let Some(ref mut state) = *active {
            if state.paused && state.child_process_id.is_none() {
                clear_immediately = true;
            }
            if let Some(pid) = state.child_process_id {
                #[cfg(target_os = "windows")]
                {
                    use std::os::windows::process::CommandExt;
                    let _ = Command::new("taskkill")
                        .args(["/F", "/T", "/PID", &pid.to_string()])
                        .creation_flags(0x08000000)
                        .status();
                }
                #[cfg(not(target_os = "windows"))]
                {
                    let _ = pid;
                }
            }
        }
        if clear_immediately {
            *active = None;
        }
    }
    Ok(true)
}

/// Get current download task status.
#[command]
pub fn depot_downloader_get_status() -> Result<DepotDownloaderStatus, String> {
    let active = ACTIVE_DOWNLOAD.lock().map_err(|_| "Lock error")?;
    if let Some(ref state) = *active {
        Ok(DepotDownloaderStatus {
            is_downloading: !state.paused,
            is_paused: state.paused,
            can_resume: state.paused,
            active_appid: Some(state.appid),
            active_build_id: Some(state.build_id.clone()),
            destination_dir: Some(state.destination_dir.clone()),
        })
    } else {
        Ok(DepotDownloaderStatus {
            is_downloading: false,
            is_paused: false,
            can_resume: false,
            active_appid: None,
            active_build_id: None,
            destination_dir: None,
        })
    }
}

// ─── LuaTools-Style Steam Direct & Selective Depot Downloader ────────────────

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct DiskSpaceInfo {
    pub free_bytes: u64,
    pub total_bytes: u64,
    pub drive_root: String,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct DepotBranchManifest {
    pub branch: String,
    pub gid: String,
    pub size: u64,
    pub download_size: u64,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SteamBranchInfo {
    pub name: String,
    pub build_id: String,
    pub time_updated: Option<u64>,
    pub pwd_required: bool,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct VersionHistoryEntry {
    pub build_id: String,
    pub branch: String,
    pub time_updated: Option<u64>,
    pub first_seen: Option<u64>,
    #[serde(default)]
    pub metadata_only: bool,
    pub title: Option<String>,
    pub description: Option<String>,
    pub url: Option<String>,
    pub manifests: HashMap<String, DepotBranchManifest>,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SteamDbPatchNote {
    pub build_id: String,
    pub title: String,
    pub description: String,
    pub published_at: Option<u64>,
    pub url: String,
    pub thumbnail_url: Option<String>,
}

#[derive(Serialize, Deserialize, Debug, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct SteamLibraryAssets {
    pub capsule: HashMap<String, String>,
    pub header: HashMap<String, String>,
    pub hero: HashMap<String, String>,
    pub logo: HashMap<String, String>,
    pub icon: Option<String>,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SteamContentDepot {
    pub depot_id: u64,
    pub name: Option<String>,
    pub size: u64,
    pub download_size: Option<u64>,
    pub os: Option<String>,
    pub os_arch: Option<String>,
    pub language: Option<String>,
    pub dlc_appid: Option<u64>,
    pub is_shared: bool,
    pub from_appid: Option<u64>,
    pub public_manifest_id: Option<String>,
    pub manifests: HashMap<String, DepotBranchManifest>,
    pub has_key: bool,
    pub key: Option<String>,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SteamAppDepotInfo {
    pub appid: u32,
    pub name: String,
    pub depots: Vec<SteamContentDepot>,
    pub dlc_ids: Vec<u64>,
    pub public_build_id: Option<String>,
    pub keys_found: usize,
    pub branches: Vec<SteamBranchInfo>,
    pub history: Vec<VersionHistoryEntry>,
    pub patch_notes: Vec<SteamDbPatchNote>,
    pub localized_names: HashMap<String, String>,
    pub library_assets: SteamLibraryAssets,
    pub supported_languages: Vec<String>,
    pub supported_os: Vec<String>,
    pub source: String,
    /// Default install directory name (from config.installdir)
    pub install_dir: Option<String>,
    /// First launch executable (from config.launch[*].executable, type "default" preferred)
    pub launch_executable: Option<String>,
    /// Launch arguments for the selected launch entry (from config.launch[*].arguments)
    #[serde(default)]
    pub launch_arguments: Vec<String>,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SelectiveDepotSelection {
    pub depot_id: u64,
    pub manifest_id: Option<String>,
    pub manifest_path: Option<String>,
    pub size: u64,
}

/// Check available disk space on the given directory path.
#[command]
pub fn depot_downloader_check_disk_space(target_path: String) -> Result<DiskSpaceInfo, String> {
    let p = PathBuf::from(&target_path);
    let mut cur = p.as_path();
    while !cur.exists() {
        if let Some(parent) = cur.parent() {
            cur = parent;
        } else {
            break;
        }
    }
    let free_bytes = fs2::available_space(cur).unwrap_or(0);
    let total_bytes = fs2::total_space(cur).unwrap_or(0);
    let drive_root = cur
        .components()
        .next()
        .map(|c| c.as_os_str().to_string_lossy().to_string())
        .unwrap_or_default();
    Ok(DiskSpaceInfo {
        free_bytes,
        total_bytes,
        drive_root,
    })
}

/// Extract decryption keys from installed .lua stplug-in files and config.vdf
fn fetched_key_cache() -> &'static std::sync::Mutex<HashMap<u32, HashMap<u64, String>>> {
    static CACHE: std::sync::OnceLock<std::sync::Mutex<HashMap<u32, HashMap<u64, String>>>> =
        std::sync::OnceLock::new();
    CACHE.get_or_init(Default::default)
}

pub fn resolve_keys_for_app(appid: u32) -> HashMap<u64, String> {
    let mut keys = fetched_key_cache()
        .lock()
        .ok()
        .and_then(|cache| cache.get(&appid).cloned())
        .unwrap_or_default();
    let steam_dir = crate::steam::get_steam_path();

    if let Some(ref steam_path) = steam_dir {
        // 1. Check stplug-in/{appid}.lua
        let candidates = [
            steam_path
                .join("config")
                .join("stplug-in")
                .join(format!("{}.lua", appid)),
            steam_path.join("stplug-in").join(format!("{}.lua", appid)),
        ];
        for lua_file in candidates {
            if lua_file.is_file() {
                if let Ok(content) = fs::read_to_string(&lua_file) {
                    extract_keys_from_lua(&content, &mut keys);
                }
            }
        }

        // 2. Check config/config.vdf
        let vdf_path = steam_path.join("config").join("config.vdf");
        if vdf_path.is_file() {
            if let Ok(content) = fs::read_to_string(&vdf_path) {
                extract_keys_from_vdf(&content, &mut keys);
            }
        }
    }

    keys
}

fn extract_keys_from_lua(content: &str, keys: &mut HashMap<u64, String>) {
    if let Ok(re) = regex::Regex::new(
        r#"(?i)addappid\s*\(\s*(\d+)\s*(?:,\s*\d+\s*(?:,\s*["']([0-9a-fA-F]{64})["'])?)?\s*\)"#,
    ) {
        for cap in re.captures_iter(content) {
            if let (Some(id_m), Some(key_m)) = (cap.get(1), cap.get(2)) {
                if let Ok(id) = id_m.as_str().parse::<u64>() {
                    let key = key_m.as_str().to_string();
                    if !key.is_empty() {
                        keys.insert(id, key);
                    }
                }
            }
        }
    }
}

fn extract_keys_from_vdf(content: &str, keys: &mut HashMap<u64, String>) {
    if let Ok(re) =
        regex::Regex::new(r#"(?i)"(\d{3,10})"\s*\{[^}]*"DecryptionKey"\s*"([0-9a-fA-F]{64})""#)
    {
        for cap in re.captures_iter(content) {
            if let (Some(id_m), Some(key_m)) = (cap.get(1), cap.get(2)) {
                if let Ok(id) = id_m.as_str().parse::<u64>() {
                    keys.insert(id, key_m.as_str().to_string());
                }
            }
        }
    }
}

pub fn auto_fetch_all_depot_keys(app: &tauri::AppHandle, appid: u32) {
    let mut keys_found = HashMap::new();

    // 1. Priority 1 (Free - Zero Quota): Hubcap Free APIs pre-check
    if let Ok(Some(hubcap_key)) = crate::lua_sources::get_hubcap_api_key(app) {
        if let Ok(hubcap_keys) = fetch_hubcap_lua_keys(&hubcap_key, appid) {
            for (k, v) in hubcap_keys {
                keys_found.insert(k, v);
            }
        }
    }

    // 2. Secondary: Ryuu
    if let Ok(Some(pkg)) = crate::lua_sources::fetch_ryuu_package(app, appid) {
        extract_keys_from_lua(&pkg.canonical_lua, &mut keys_found);
    }

    // 3. Tertiary: LUIE (LuaTools Direct)
    if let Ok(Some(pkg)) = crate::lua_sources::fetch_luatools_direct_package(
        app,
        appid,
        crate::lua_sources::LuaSourceProvider::Luie,
    ) {
        extract_keys_from_lua(&pkg.canonical_lua, &mut keys_found);
    }

    if !keys_found.is_empty() {
        if let Ok(mut cache) = fetched_key_cache().lock() {
            let entry = cache.entry(appid).or_default();
            for (k, v) in keys_found {
                entry.insert(k, v);
            }
        }
    }
}

#[derive(Debug, Clone, Default)]
pub struct LuaDepotMeta {
    pub manifest_id: Option<String>,
    pub size: Option<u64>,
    pub name: Option<String>,
}

pub fn load_lua_content_for_app(appid: u32) -> Option<String> {
    if let Some(steam_path) = crate::steam::get_steam_path() {
        let candidates = [
            steam_path
                .join("config")
                .join("stplug-in")
                .join(format!("{}.lua", appid)),
            steam_path.join("stplug-in").join(format!("{}.lua", appid)),
        ];
        for path in candidates {
            if path.is_file() {
                if let Ok(content) = fs::read_to_string(&path) {
                    return Some(content);
                }
            }
        }
    }
    None
}

pub fn extract_lua_depot_metadata(content: &str) -> HashMap<u64, LuaDepotMeta> {
    let mut map = HashMap::new();
    // 1. Parse setManifestid(depot_id, "manifest_id", size)
    if let Ok(re) = regex::Regex::new(
        r#"(?i)setmanifestid\s*\(\s*(\d+)\s*,\s*["'](\d+)["'](?:\s*,\s*(\d+))?\s*\)"#,
    ) {
        for cap in re.captures_iter(content) {
            if let (Some(id_m), Some(gid_m)) = (cap.get(1), cap.get(2)) {
                if let Ok(id) = id_m.as_str().parse::<u64>() {
                    let gid = gid_m.as_str().to_string();
                    let size = cap.get(3).and_then(|m| m.as_str().parse::<u64>().ok());
                    let entry = map.entry(id).or_insert_with(LuaDepotMeta::default);
                    entry.manifest_id = Some(gid);
                    if size.is_some() {
                        entry.size = size;
                    }
                }
            }
        }
    }
    // 2. Parse depot names from comments: e.g. addappid(3932690, ...) -- Onimusha WotS - Charm Lion Dog - Depot 3932690
    if let Ok(re) =
        regex::Regex::new(r#"(?i)(?:addappid|setmanifestid)\s*\(\s*(\d+)[^)]*\)\s*--\s*(.+)"#)
    {
        for cap in re.captures_iter(content) {
            if let (Some(id_m), Some(comment_m)) = (cap.get(1), cap.get(2)) {
                if let Ok(id) = id_m.as_str().parse::<u64>() {
                    let comment = comment_m.as_str().trim().to_string();
                    if !comment.is_empty() {
                        let entry = map.entry(id).or_insert_with(LuaDepotMeta::default);
                        if entry.name.is_none() {
                            entry.name = Some(comment);
                        }
                    }
                }
            }
        }
    }
    map
}

pub fn extract_lua_dlc_ids(content: &str) -> Vec<u64> {
    let mut dlcs = Vec::new();
    if let Ok(re) = regex::Regex::new(r#"(?i)addappid\s*\(\s*(\d+)\s*\)"#) {
        for cap in re.captures_iter(content) {
            if let Some(id_m) = cap.get(1) {
                if let Ok(id) = id_m.as_str().parse::<u64>() {
                    dlcs.push(id);
                }
            }
        }
    }
    dlcs
}

/// Resolve decryption keys for a specific appid.
#[command]
pub fn depot_downloader_resolve_depot_keys(appid: u32) -> Result<HashMap<String, String>, String> {
    let keys = resolve_keys_for_app(appid);
    let string_map = keys.into_iter().map(|(k, v)| (k.to_string(), v)).collect();
    Ok(string_map)
}

fn parse_history_entries(json_val: &serde_json::Value) -> Vec<VersionHistoryEntry> {
    let mut history = Vec::new();
    if let Some(hist_arr) = json_val.get("_history").and_then(|h| h.as_array()) {
        for item in hist_arr {
            let build_id = item
                .get("buildId")
                .and_then(|v| {
                    if let Some(s) = v.as_str() {
                        Some(s.to_string())
                    } else if let Some(n) = v.as_u64() {
                        Some(n.to_string())
                    } else {
                        None
                    }
                })
                .unwrap_or_default();
            if build_id.is_empty() {
                continue;
            }
            let branch = item
                .get("branch")
                .and_then(|v| v.as_str())
                .unwrap_or("public")
                .to_string();
            let time_updated = item.get("timeUpdated").and_then(|v| {
                v.as_u64()
                    .or_else(|| v.as_str().and_then(|s| s.parse().ok()))
            });
            let first_seen = item.get("firstSeen").and_then(|v| {
                v.as_u64()
                    .or_else(|| v.as_str().and_then(|s| s.parse().ok()))
            });
            let mut manifests = HashMap::new();
            if let Some(m_obj) = item.get("manifests").and_then(|m| m.as_object()) {
                for (depot_key, m_val) in m_obj {
                    let gid = m_val
                        .get("gid")
                        .and_then(|v| {
                            if let Some(s) = v.as_str() {
                                Some(s.to_string())
                            } else if let Some(n) = v.as_u64() {
                                Some(n.to_string())
                            } else {
                                None
                            }
                        })
                        .unwrap_or_default();
                    let size = m_val
                        .get("size")
                        .and_then(|v| {
                            v.as_u64()
                                .or_else(|| v.as_str().and_then(|s| s.parse().ok()))
                        })
                        .unwrap_or(0);
                    let download_size = m_val
                        .get("download")
                        .and_then(|v| {
                            v.as_u64()
                                .or_else(|| v.as_str().and_then(|s| s.parse().ok()))
                        })
                        .unwrap_or(0);
                    manifests.insert(
                        depot_key.clone(),
                        DepotBranchManifest {
                            branch: branch.clone(),
                            gid,
                            size,
                            download_size,
                        },
                    );
                }
            }
            history.push(VersionHistoryEntry {
                build_id,
                branch,
                time_updated,
                first_seen,
                metadata_only: false,
                title: None,
                description: None,
                url: None,
                manifests,
            });
        }
    }
    history
}

fn xml_tag_value(item: &str, tag: &str) -> Option<String> {
    let open = format!("<{tag}>");
    let close = format!("</{tag}>");
    let start = item.find(&open)? + open.len();
    let end = item[start..].find(&close)? + start;
    Some(item[start..end].trim().to_string())
}

fn decode_xml_text(value: &str) -> String {
    value
        .replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&apos;", "'")
}

fn parse_steamdb_patch_notes(xml: &str) -> Vec<SteamDbPatchNote> {
    let mut notes = Vec::new();
    for item in xml.split("<item>").skip(1) {
        let Some(guid) = xml_tag_value(item, "guid") else { continue };
        let build_id = guid.strip_prefix("build#").unwrap_or(&guid).to_string();
        let Some(title) = xml_tag_value(item, "title") else { continue };
        let Some(url) = xml_tag_value(item, "link") else { continue };
        let description = xml_tag_value(item, "description").unwrap_or_default();
        let published_at = xml_tag_value(item, "pubDate").and_then(|date| {
            chrono::DateTime::parse_from_rfc2822(&date).ok().map(|value| value.timestamp() as u64)
        });
        let thumbnail_url = item
            .split("<media:thumbnail")
            .nth(1)
            .and_then(|part| part.split('>').next())
            .and_then(|attrs| attrs.split("url=\"").nth(1))
            .and_then(|value| value.split('"').next())
            .map(decode_xml_text);
        notes.push(SteamDbPatchNote {
            build_id,
            title: decode_xml_text(&title),
            description: decode_xml_text(&description),
            published_at,
            url: decode_xml_text(&url),
            thumbnail_url,
        });
    }
    notes
}

fn fetch_steamdb_patch_notes(client: &Client, appid: u32) -> Vec<SteamDbPatchNote> {
    let url = format!("https://steamdb.info/api/PatchnotesRSS/?appid={appid}");
    client
        .get(url)
        .send()
        .ok()
        .filter(|response| response.status().is_success())
        .and_then(|response| response.text().ok())
        .map(|xml| parse_steamdb_patch_notes(&xml))
        .unwrap_or_default()
}

fn merge_patch_notes_into_history(
    mut history: Vec<VersionHistoryEntry>,
    patch_notes: &[SteamDbPatchNote],
) -> Vec<VersionHistoryEntry> {
    let known = history
        .iter()
        .map(|entry| entry.build_id.clone())
        .collect::<std::collections::HashSet<_>>();
    for note in patch_notes {
        if known.contains(&note.build_id) {
            continue;
        }
        history.push(VersionHistoryEntry {
            build_id: note.build_id.clone(),
            branch: "steamdb".to_string(),
            time_updated: note.published_at,
            first_seen: note.published_at,
            metadata_only: true,
            title: Some(note.title.clone()),
            description: Some(note.description.clone()),
            url: Some(note.url.clone()),
            manifests: HashMap::new(),
        });
    }
    history.sort_by(|left, right| {
        right
            .time_updated
            .or(right.first_seen)
            .unwrap_or(0)
            .cmp(&left.time_updated.or(left.first_seen).unwrap_or(0))
    });
    history
}

fn parse_steam_app_metadata(
    appid: u32,
    app_data: &serde_json::Value,
    source: &str,
    mut history: Vec<VersionHistoryEntry>,
    patch_notes: Vec<SteamDbPatchNote>,
) -> SteamAppDepotInfo {
    if history.is_empty() {
        history = parse_history_entries(app_data);
    }
    history = merge_patch_notes_into_history(history, &patch_notes);

    let game_name = app_data
        .get("common")
        .and_then(|c| c.get("name"))
        .and_then(|n| n.as_str())
        .unwrap_or("Unknown Game")
        .to_string();

    let localized_names = app_data
        .get("common")
        .and_then(|common| common.get("name_localized"))
        .and_then(|names| names.as_object())
        .map(|names| names.iter().filter_map(|(locale, value)| value.as_str().map(|name| (locale.clone(), name.to_string()))).collect())
        .unwrap_or_default();
    let asset_url = |path: &str| format!("https://shared.cloudflare.steamstatic.com/store_item_assets/steam/apps/{appid}/{path}");
    let asset_map = |value: Option<&serde_json::Value>| {
        let mut result = HashMap::new();
        if let Some(asset) = value {
            for key in ["image2x", "image"] {
                if let Some(images) = asset.get(key).and_then(|images| images.as_object()) {
                    for (locale, path) in images {
                        if !result.contains_key(locale) {
                            if let Some(path) = path.as_str() {
                                result.insert(locale.clone(), asset_url(path));
                            }
                        }
                    }
                }
            }
        }
        result
    };
    let library_assets_full = app_data.get("common").and_then(|common| common.get("library_assets_full"));
    let library_assets = SteamLibraryAssets {
        capsule: asset_map(library_assets_full.and_then(|assets| assets.get("library_capsule"))),
        header: asset_map(library_assets_full.and_then(|assets| assets.get("library_header"))),
        hero: asset_map(library_assets_full.and_then(|assets| assets.get("library_hero"))),
        logo: asset_map(library_assets_full.and_then(|assets| assets.get("library_logo"))),
        icon: app_data.get("common").and_then(|common| common.get("icon")).and_then(|icon| icon.as_str()).map(|icon| format!("https://cdn.cloudflare.steamstatic.com/steamcommunity/public/images/apps/{appid}/{icon}.jpg")),
    };

    // Parse install directory and launch executable from config
    let install_dir = app_data
        .get("config")
        .and_then(|c| c.get("installdir"))
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string());

    // Pick the Windows launch entry from config.launch. Entries are keyed by string index
    // ("0", "1", ...) and iteration order of a JSON object map is not guaranteed, so an
    // explicit ordinal tie-break keeps the choice deterministic.
    let favorite_launch: Option<(u32, bool)> = {
        let mut best: Option<(u32, bool)> = None;
        if let Some(launch_obj) = app_data
            .get("config")
            .and_then(|c| c.get("launch"))
            .and_then(|l| l.as_object())
        {
            for (key, entry) in launch_obj {
                let has_entry_exe = entry
                    .get("executable")
                    .and_then(|e| e.as_str())
                    .is_some_and(|s| !s.is_empty());
                if !has_entry_exe {
                    continue;
                }
                let entry_type = entry.get("type").and_then(|t| t.as_str()).unwrap_or("");
                let os_list = entry
                    .get("config")
                    .and_then(|c| c.get("oslist"))
                    .and_then(|o| o.as_str())
                    .unwrap_or("windows");
                // Skip non-windows launch configs
                if !os_list.contains("windows") && !os_list.is_empty() {
                    continue;
                }
                // Launch option ids must be non-empty so the entry can be referenced later.
                if entry.get("id").and_then(|v| v.as_str()) == Some("") {
                    continue;
                }
                let ordinal = key.parse::<u32>().unwrap_or(u32::MAX);
                let is_default = entry_type == "default" || entry_type.is_empty();
                if best.is_none_or(|(best_ordinal, best_default)| {
                    (is_default, best_default) == (true, false)
                        || (is_default == best_default && ordinal < best_ordinal)
                }) {
                    best = Some((ordinal, is_default));
                }
            }
        }
        best
    };

    let launch_exe: Option<String> = favorite_launch.and_then(|(ordinal, _)| {
        app_data
            .get("config")
            .and_then(|c| c.get("launch"))
            .and_then(|l| l.get(ordinal.to_string()))
            .and_then(|entry| entry.get("executable"))
            .and_then(|e| e.as_str())
            .filter(|s| !s.is_empty())
            .map(|s| s.to_string())
    });

    let launch_arguments: Vec<String> = favorite_launch
        .and_then(|(ordinal, _)| {
            app_data
                .get("config")
                .and_then(|c| c.get("launch"))
                .and_then(|l| l.get(ordinal.to_string()))
                .and_then(|entry| entry.get("arguments"))
                .and_then(|a| a.as_str())
        })
        .map(|args| args.split_whitespace().map(str::to_string).collect())
        .unwrap_or_default();

    let mut supported_languages = Vec::new();
    if let Some(langs) = app_data
        .get("common")
        .and_then(|c| c.get("languages"))
        .and_then(|l| l.as_object())
    {
        for (lang, val) in langs {
            let active = val
                .as_str()
                .map(|s| s == "1" || s == "true")
                .unwrap_or_else(|| val.as_u64().map(|n| n == 1).unwrap_or(false));
            if active {
                supported_languages.push(lang.clone());
            }
        }
    }

    let mut supported_os = Vec::new();
    if let Some(os_str) = app_data
        .get("common")
        .and_then(|c| c.get("oslist"))
        .and_then(|o| o.as_str())
    {
        for part in os_str.split(',') {
            let trimmed = part.trim().to_lowercase();
            if !trimmed.is_empty() && !supported_os.contains(&trimmed) {
                supported_os.push(trimmed);
            }
        }
    }

    // Parse branches
    let mut branches = Vec::new();
    if let Some(branches_obj) = app_data
        .get("depots")
        .and_then(|d| d.get("branches"))
        .and_then(|b| b.as_object())
    {
        for (b_name, b_val) in branches_obj {
            let build_id = b_val
                .get("buildid")
                .and_then(|v| {
                    if let Some(s) = v.as_str() {
                        Some(s.to_string())
                    } else if let Some(n) = v.as_u64() {
                        Some(n.to_string())
                    } else {
                        None
                    }
                })
                .unwrap_or_default();
            let time_updated = b_val
                .get("timeupdated")
                .or_else(|| b_val.get("timebuildupdated"))
                .and_then(|v| {
                    v.as_u64()
                        .or_else(|| v.as_str().and_then(|s| s.parse().ok()))
                });
            let pwd_required = b_val
                .get("pwdrequired")
                .map(|v| v.as_str() == Some("1") || v.as_u64() == Some(1))
                .unwrap_or(false);
            branches.push(SteamBranchInfo {
                name: b_name.clone(),
                build_id,
                time_updated,
                pwd_required,
            });
        }
    }
    branches.sort_by(|a, b| {
        if a.name == "public" {
            std::cmp::Ordering::Less
        } else if b.name == "public" {
            std::cmp::Ordering::Greater
        } else {
            a.name.cmp(&b.name)
        }
    });

    let public_build_id = branches
        .iter()
        .find(|b| b.name == "public")
        .map(|b| b.build_id.clone());

    let mut dlc_ids = Vec::new();
    if let Some(dlc_str) = app_data
        .get("extended")
        .and_then(|e| e.get("listofdlc"))
        .and_then(|v| v.as_str())
    {
        for item in dlc_str.split(',') {
            if let Ok(id) = item.trim().parse::<u64>() {
                dlc_ids.push(id);
            }
        }
    }

    let keys = resolve_keys_for_app(appid);

    let mut depots = Vec::new();
    if let Some(depots_obj) = app_data.get("depots").and_then(|d| d.as_object()) {
        for (depot_key, val) in depots_obj {
            let depot_id = match depot_key.parse::<u64>() {
                Ok(id) => id,
                Err(_) => continue,
            };

            let os = val
                .get("config")
                .and_then(|c| c.get("oslist"))
                .and_then(|v| v.as_str())
                .map(|s| s.to_string());

            let os_arch = val
                .get("config")
                .and_then(|c| c.get("osarch"))
                .and_then(|v| v.as_str())
                .map(|s| s.to_string());

            let language = val
                .get("config")
                .and_then(|c| c.get("language"))
                .and_then(|v| v.as_str())
                .map(|s| s.to_string());

            let dlc_appid = val.get("dlcappid").and_then(|v| {
                if let Some(n) = v.as_u64() {
                    Some(n)
                } else if let Some(s) = v.as_str() {
                    s.parse::<u64>().ok()
                } else {
                    None
                }
            });

            let from_appid = val.get("depotfromapp").and_then(|v| {
                if let Some(n) = v.as_u64() {
                    Some(n)
                } else if let Some(s) = v.as_str() {
                    s.parse::<u64>().ok()
                } else {
                    None
                }
            });
            let is_shared = from_appid.is_some();

            let mut manifests = HashMap::new();
            if let Some(m_obj) = val.get("manifests").and_then(|m| m.as_object()) {
                for (b_name, m_data) in m_obj {
                    let gid = m_data
                        .get("gid")
                        .and_then(|v| {
                            if let Some(s) = v.as_str() {
                                Some(s.to_string())
                            } else if let Some(n) = v.as_u64() {
                                Some(n.to_string())
                            } else {
                                None
                            }
                        })
                        .unwrap_or_default();
                    if !gid.is_empty() {
                        let size = m_data
                            .get("size")
                            .and_then(|v| {
                                v.as_u64()
                                    .or_else(|| v.as_str().and_then(|s| s.parse().ok()))
                            })
                            .unwrap_or(0);
                        let download_size = m_data
                            .get("download")
                            .and_then(|v| {
                                v.as_u64()
                                    .or_else(|| v.as_str().and_then(|s| s.parse().ok()))
                            })
                            .unwrap_or(0);
                        manifests.insert(
                            b_name.clone(),
                            DepotBranchManifest {
                                branch: b_name.clone(),
                                gid,
                                size,
                                download_size,
                            },
                        );
                    }
                }
            }

            let public_manifest_id = manifests.get("public").map(|m| m.gid.clone());
            let size = manifests.get("public").map(|m| m.size).unwrap_or_else(|| {
                val.get("maxsize")
                    .and_then(|v| {
                        if let Some(n) = v.as_u64() {
                            Some(n)
                        } else if let Some(s) = v.as_str() {
                            s.parse::<u64>().ok()
                        } else {
                            None
                        }
                    })
                    .unwrap_or(0)
            });
            let download_size = manifests.get("public").map(|m| m.download_size);

            let depot_name = val
                .get("name")
                .or_else(|| val.get("config").and_then(|c| c.get("name")))
                .and_then(|n| n.as_str())
                .filter(|s| !s.is_empty())
                .map(|s| s.to_string());

            let key_opt = keys.get(&depot_id).cloned();
            let has_key = key_opt.is_some();

            depots.push(SteamContentDepot {
                depot_id,
                name: depot_name,
                size,
                download_size,
                os,
                os_arch,
                language,
                dlc_appid,
                is_shared,
                from_appid,
                public_manifest_id,
                manifests,
                has_key,
                key: key_opt,
            });
        }
    }

    depots.sort_by(|a, b| a.depot_id.cmp(&b.depot_id));

    // Enhance / supplement depots with Lua metadata if available
    if let Some(lua_content) = load_lua_content_for_app(appid) {
        let lua_meta = extract_lua_depot_metadata(&lua_content);
        let mut existing_depot_ids: std::collections::HashSet<u64> =
            depots.iter().map(|d| d.depot_id).collect();

        for d in &mut depots {
            if let Some(meta) = lua_meta.get(&d.depot_id) {
                if d.public_manifest_id.is_none() && meta.manifest_id.is_some() {
                    d.public_manifest_id = meta.manifest_id.clone();
                }
                if d.size == 0 && meta.size.unwrap_or(0) > 0 {
                    d.size = meta.size.unwrap_or(0);
                }
                if d.name.is_none() && meta.name.is_some() {
                    d.name = meta.name.clone();
                }
            }
        }

        // Add any DLC depots declared in Lua that SteamCMD/metadata didn't list under base app
        for (depot_id, meta) in &lua_meta {
            if !existing_depot_ids.contains(depot_id) && *depot_id != (appid as u64) {
                let key_opt = keys.get(depot_id).cloned();
                let has_key = key_opt.is_some();
                let mut manifests = HashMap::new();
                if let Some(ref gid) = meta.manifest_id {
                    manifests.insert(
                        "public".to_string(),
                        DepotBranchManifest {
                            branch: "public".to_string(),
                            gid: gid.clone(),
                            size: meta.size.unwrap_or(0),
                            download_size: 0,
                        },
                    );
                }
                depots.push(SteamContentDepot {
                    depot_id: *depot_id,
                    name: meta.name.clone(),
                    size: meta.size.unwrap_or(0),
                    download_size: None,
                    os: Some("windows".to_string()),
                    os_arch: None,
                    language: None,
                    dlc_appid: Some(*depot_id),
                    is_shared: false,
                    from_appid: None,
                    public_manifest_id: meta.manifest_id.clone(),
                    manifests,
                    has_key,
                    key: key_opt,
                });
                existing_depot_ids.insert(*depot_id);
            }
        }

        for dlc_id in extract_lua_dlc_ids(&lua_content) {
            if !dlc_ids.contains(&dlc_id) && dlc_id != (appid as u64) {
                dlc_ids.push(dlc_id);
            }
        }

        depots.sort_by(|a, b| a.depot_id.cmp(&b.depot_id));
    }

    let keys_found = depots.iter().filter(|d| d.has_key).count();

    SteamAppDepotInfo {
        appid,
        name: game_name,
        depots,
        dlc_ids,
        public_build_id,
        keys_found,
        branches,
        history,
        patch_notes,
        localized_names,
        library_assets,
        supported_languages,
        supported_os,
        source: source.to_string(),
        install_dir,
        launch_executable: launch_exe,
        launch_arguments,
    }
}

#[derive(Deserialize)]
struct SteamRunDepotItem {
    depotid: u64,
    #[serde(default)]
    manifestid: Option<String>,
    #[serde(default)]
    size_bytes: u64,
}

#[derive(Deserialize)]
struct SteamRunDepotResponse {
    #[allow(dead_code)]
    appid: u64,
    depots: Vec<SteamRunDepotItem>,
}

/// Fallback / enhancement source using free manifest.steam.run API.
/// Runs before Hubcap to save paid quota.
fn supplement_depot_info_with_steamrun(appid: u32, info: &mut SteamAppDepotInfo) {
    let client = match build_client() {
        Ok(c) => c,
        Err(_) => return,
    };
    let url = format!("https://manifest.steam.run/api/depot/{}", appid);
    let resp = match client.get(&url).header("User-Agent", "0xoLemon-Launcher/2.0").send() {
        Ok(r) if r.status().is_success() => r,
        _ => return,
    };
    let data: SteamRunDepotResponse = match resp.json() {
        Ok(d) => d,
        Err(_) => return,
    };

    if info.depots.is_empty() {
        let keys = resolve_keys_for_app(appid);
        for item in data.depots {
            let depot_id = item.depotid;
            let manifest_id = item.manifestid.unwrap_or_default();
            let key_opt = keys.get(&depot_id).cloned();
            let has_key = key_opt.is_some();
            let mut manifests = HashMap::new();
            if !manifest_id.is_empty() {
                manifests.insert(
                    "public".to_string(),
                    DepotBranchManifest {
                        branch: "public".to_string(),
                        gid: manifest_id.clone(),
                        size: item.size_bytes,
                        download_size: 0,
                    },
                );
            }
            info.depots.push(SteamContentDepot {
                depot_id,
                name: Some(format!("Depot {}", depot_id)),
                size: item.size_bytes,
                download_size: None,
                os: Some("windows".to_string()),
                os_arch: None,
                language: None,
                dlc_appid: Some(depot_id),
                is_shared: false,
                from_appid: None,
                public_manifest_id: if manifest_id.is_empty() { None } else { Some(manifest_id) },
                manifests,
                has_key,
                key: key_opt,
            });
        }
        info.depots.sort_by(|a, b| a.depot_id.cmp(&b.depot_id));
        info.keys_found = info.depots.iter().filter(|d| d.has_key).count();
    } else {
        for depot in &mut info.depots {
            if depot.public_manifest_id.is_none() {
                if let Some(item) = data.depots.iter().find(|d| d.depotid == depot.depot_id) {
                    if let Some(ref m_id) = item.manifestid {
                        if !m_id.is_empty() {
                            depot.public_manifest_id = Some(m_id.clone());
                            depot.manifests.entry("public".to_string()).or_insert_with(
                                || DepotBranchManifest {
                                    branch: "public".to_string(),
                                    gid: m_id.clone(),
                                    size: if depot.size > 0 { depot.size } else { item.size_bytes },
                                    download_size: 0,
                                },
                            );
                            if depot.size == 0 && item.size_bytes > 0 {
                                depot.size = item.size_bytes;
                            }
                        }
                    }
                }
            }
        }
    }
}

fn supplement_depot_info_with_hubcap(app: &AppHandle, appid: u32, info: &mut SteamAppDepotInfo) {
    if let Ok(Some(hubcap_key)) = crate::lua_sources::get_hubcap_api_key(app) {
        if let Ok(client) = build_client() {
            if let Ok(Some(contents)) =
                crate::lua_sources::fetch_hubcap_app_contents(&client, &hubcap_key, appid)
            {
                let hubcap_map: HashMap<u64, String> = contents
                    .manifests
                    .into_iter()
                    .filter_map(|m| {
                        let depot_id = m.depot_id.parse::<u64>().ok()?;
                        Some((depot_id, m.manifest_id))
                    })
                    .collect();

                if info.depots.is_empty() {
                    let keys = resolve_keys_for_app(appid);
                    for (depot_id, manifest_id) in &hubcap_map {
                        let key_opt = keys.get(depot_id).cloned();
                        let has_key = key_opt.is_some();
                        let mut manifests = HashMap::new();
                        manifests.insert(
                            "public".to_string(),
                            DepotBranchManifest {
                                branch: "public".to_string(),
                                gid: manifest_id.clone(),
                                size: 0,
                                download_size: 0,
                            },
                        );
                        info.depots.push(SteamContentDepot {
                            depot_id: *depot_id,
                            name: Some(format!("Depot {}", depot_id)),
                            size: 0,
                            download_size: None,
                            os: Some("windows".to_string()),
                            os_arch: None,
                            language: None,
                            dlc_appid: Some(*depot_id),
                            is_shared: false,
                            from_appid: None,
                            public_manifest_id: Some(manifest_id.clone()),
                            manifests,
                            has_key,
                            key: key_opt,
                        });
                    }
                    info.depots.sort_by(|a, b| a.depot_id.cmp(&b.depot_id));
                    info.keys_found = info.depots.iter().filter(|d| d.has_key).count();
                } else {
                    for depot in &mut info.depots {
                        if depot.public_manifest_id.is_none() {
                            if let Some(m_id) = hubcap_map.get(&depot.depot_id) {
                                depot.public_manifest_id = Some(m_id.clone());
                                depot.manifests.entry("public".to_string()).or_insert_with(
                                    || DepotBranchManifest {
                                        branch: "public".to_string(),
                                        gid: m_id.clone(),
                                        size: depot.size,
                                        download_size: 0,
                                    },
                                );
                            }
                        }
                    }
                }
            }
        }
    }
}

/// Query live Steam depots metadata from GitHub CDN with fallback to live SteamCMD API & Steam Store API.
#[command]
pub async fn depot_downloader_get_steam_depots(
    app: tauri::AppHandle,
    appid: u32,
) -> Result<SteamAppDepotInfo, String> {
    let client = build_client()?;
    let shard = appid % 1000;

    // Auto-fetch keys from Ryuu, LUIE, and Hubcap in background/blocking thread
    let app_clone = app.clone();
    let _ = tauri::async_runtime::spawn_blocking(move || {
        auto_fetch_all_depot_keys(&app_clone, appid);
    })
    .await;

    // 1. Primary: Fetch from GitHub Raw / jsDelivr CDN
    let default_repo = "isagi3097-cell/steam-metadata";
    let cdn_urls = [
        format!(
            "https://raw.githubusercontent.com/{}/main/data/{:03}/{}.json",
            default_repo, shard, appid
        ),
        format!(
            "https://cdn.jsdelivr.net/gh/{}@main/data/{:03}/{}.json",
            default_repo, shard, appid
        ),
    ];

    for cdn_url in &cdn_urls {
        if let Ok(resp) = client.get(cdn_url).send() {
            if resp.status().is_success() {
                if let Ok(json_val) = resp.json::<serde_json::Value>() {
                    if json_val.get("depots").is_some() || json_val.get("common").is_some() {
                        let history = parse_history_entries(&json_val);
                        let patch_notes = fetch_steamdb_patch_notes(&client, appid);
                        let mut info = parse_steam_app_metadata(
                            appid,
                            &json_val,
                            "github_cdn",
                            history,
                            patch_notes,
                        );
                        supplement_depot_info_with_steamrun(appid, &mut info);
                        supplement_depot_info_with_hubcap(&app, appid, &mut info);
                        return Ok(info);
                    }
                }
            }
        }
    }

    // 2. Fallback: Live SteamCMD API (api.steamcmd.net)
    let url = format!("https://api.steamcmd.net/v1/info/{}", appid);
    if let Ok(resp) = client.get(&url).send() {
        if resp.status().is_success() {
            if let Ok(json) = resp.json::<serde_json::Value>() {
                if let Some(app_data) = json.get("data").and_then(|d| d.get(appid.to_string())) {
                    if app_data.get("depots").is_some() || app_data.get("common").is_some() {
                        let patch_notes = fetch_steamdb_patch_notes(&client, appid);
                        let mut info = parse_steam_app_metadata(
                            appid,
                            app_data,
                            "steamcmd_live",
                            Vec::new(),
                            patch_notes,
                        );
                        supplement_depot_info_with_steamrun(appid, &mut info);
                        supplement_depot_info_with_hubcap(&app, appid, &mut info);
                        return Ok(info);
                    }
                }
            }
        }
    }

    // 3. Fallback: Official Steam Store API
    let store_url = format!(
        "https://store.steampowered.com/api/appdetails?appids={}",
        appid
    );
    if let Ok(resp) = client.get(&store_url).send() {
        if resp.status().is_success() {
            if let Ok(store_json) = resp.json::<serde_json::Value>() {
                if let Some(app_data) = store_json
                    .get(appid.to_string())
                    .and_then(|d| d.get("data"))
                {
                    let game_name = app_data
                        .get("name")
                        .and_then(|n| n.as_str())
                        .unwrap_or("Unknown Game")
                        .to_string();
                    let mut supported_os = Vec::new();
                    if let Some(platforms) = app_data.get("platforms").and_then(|p| p.as_object()) {
                        for (os_name, is_supported) in platforms {
                            if is_supported.as_bool().unwrap_or(false) {
                                supported_os.push(os_name.clone());
                            }
                        }
                    }
                    let mut info = SteamAppDepotInfo {
                        appid,
                        name: game_name,
                        depots: Vec::new(),
                        dlc_ids: Vec::new(),
                        public_build_id: None,
                        keys_found: 0,
                        branches: Vec::new(),
                        history: Vec::new(),
                        patch_notes: Vec::new(),
                        localized_names: HashMap::new(),
                        library_assets: SteamLibraryAssets::default(),
                        supported_languages: Vec::new(),
                        supported_os,
                        source: "steam_store_api".to_string(),
                        install_dir: None,
                        launch_executable: None,
                        launch_arguments: Vec::new(),
                    };
                    supplement_depot_info_with_steamrun(appid, &mut info);
                    supplement_depot_info_with_hubcap(&app, appid, &mut info);
                    return Ok(info);
                }
            }
        }
    }

    Err(format!("Không thể lấy dữ liệu metadata cho AppID {} từ GitHub CDN, SteamCMD API hoặc Steam Store API.", appid))
}

/// Start selective depot downloading (LuaTools style).
#[command]
pub async fn depot_downloader_start_selective_download(
    app: AppHandle,
    appid: u32,
    game_title: String,
    selections: Vec<SelectiveDepotSelection>,
    destination_dir: String,
    max_downloads: Option<u32>,
    verify_all: Option<bool>,
) -> Result<String, String> {
    if selections.is_empty() {
        return Err("Vui lòng chọn ít nhất một depot để tải.".to_string());
    }

    let max_concurrency = max_downloads.unwrap_or(32).clamp(1, 256);
    let do_verify = verify_all.unwrap_or(true);

    // Pre-check disk space
    let total_required: u64 = selections.iter().map(|s| s.size).sum();
    let p = PathBuf::from(&destination_dir);
    let mut cur = p.as_path();
    while !cur.exists() {
        if let Some(parent) = cur.parent() {
            cur = parent;
        } else {
            break;
        }
    }
    let free_space = fs2::available_space(cur).unwrap_or(0);
    if total_required > 0 && free_space > 0 && free_space < total_required {
        return Err(format!(
            "Không đủ dung lượng ổ đĩa: Cần {:.2} GB, chỉ còn {:.2} GB trống.",
            (total_required as f64) / (1024.0 * 1024.0 * 1024.0),
            (free_space as f64) / (1024.0 * 1024.0 * 1024.0)
        ));
    }

    let job = ActiveDownloadState {
        appid,
        folder_name: game_title.clone(),
        build_id: "selective".to_string(),
        destination_dir: destination_dir.clone(),
        max_downloads: max_concurrency,
        verify_all: do_verify,
        child_process_id: None,
        paused: false,
        selections: Some(selections.clone()),
    };

    {
        let mut active = ACTIVE_DOWNLOAD.lock().map_err(|_| "Lock error")?;
        if active.is_some() {
            return Err(
                "Đang có một tiến trình tải hoặc một phiên tạm dừng chưa hoàn tất.".to_string(),
            );
        }
        CANCEL_REQUESTED.store(false, Ordering::SeqCst);
        PAUSE_REQUESTED.store(false, Ordering::SeqCst);
        *active = Some(job.clone());
    }

    launch_download_task(app, job);
    Ok("Selective depot download started".to_string())
}

fn run_selective_download_pipeline(
    app: &AppHandle,
    appid: u32,
    _game_title: &str,
    selections: &[SelectiveDepotSelection],
    destination_dir: &str,
    max_concurrency: u32,
    do_verify: bool,
) -> Result<PipelineOutcome, String> {
    let exe = resolve_depot_downloader_exe(app)?;
    let dest_path = PathBuf::from(destination_dir);
    fs::create_dir_all(&dest_path).map_err(|e| format!("Không thể tạo thư mục lưu game: {}", e))?;

    // 1. Resolve keys and write temp keys file
    let mut keys = resolve_keys_for_app(appid);
    let total_depots = selections.len();
    let total_bytes: u64 = selections.iter().map(|s| s.size).sum();
    let mut completed_bytes: u64 = 0;

    // If any selected depot lacks a key, try all sources automatically
    let missing_any_key = selections.iter().any(|s| !keys.contains_key(&s.depot_id));
    if missing_any_key {
        let _ = app.emit(
            "depot-download-progress",
            DepotDownloadProgressEvent {
                event_type: "log".to_string(),
                appid,
                build_id: "selective".to_string(),
                depot_id: None,
                message: Some("Phát hiện depot chưa có key giải mã trong máy. Đang tự động lấy key từ Ryuu, LUIE, và Hubcap...".to_string()),
                current_depot_index: 0,
                total_depots,
                progress_percent: None,
                speed_mbps: None,
                transferred_bytes: None,
                total_bytes: Some(total_bytes),
                success: None,
                phase: Some("manifest".to_string()),
            },
        );
        auto_fetch_all_depot_keys(app, appid);
        // Re-read keys after fetch
        keys = resolve_keys_for_app(appid);
    }

    let temp_keys_file = dest_path.join(format!("depotkeys_{}.txt", uuid::Uuid::new_v4().simple()));
    {
        let mut content = String::new();
        for (depot_id, key) in &keys {
            content.push_str(&format!("{};{}\n", depot_id, key));
        }
        fs::write(&temp_keys_file, content).map_err(|e| format!("Lỗi ghi file keys tạm: {}", e))?;
    }

    let steam_dir = crate::steam::get_steam_path();

    // Smart Quota Optimization: Check how many selected depots lack cached manifests
    let mut missing_manifests_count = 0;
    for sel in selections {
        if let Some(ref m_id) = sel.manifest_id {
            let in_steam = steam_dir
                .as_ref()
                .map(|s| {
                    crate::steam_manifest_integrity::matches_manifest(
                        &crate::steam_manifest_integrity::manifest_path(
                            &s.join("depotcache"), sel.depot_id, m_id,
                        ),
                        sel.depot_id as u64,
                        m_id,
                    )
                })
                .unwrap_or(false);
            let in_launcher = crate::steam_manifest_integrity::matches_manifest(
                &crate::steam_manifest_integrity::manifest_path(
                    &get_launcher_depotcache_dir(app), sel.depot_id, m_id,
                ),
                sel.depot_id as u64,
                m_id,
            );
            if !in_steam && !in_launcher {
                missing_manifests_count += 1;
            }
        } else {
            missing_manifests_count += 1;
        }
    }

    // If more than 2 depots are missing manifests, optimize quota by downloading 1 bundle ZIP
    if missing_manifests_count > 2 {
        if let Ok(Some(hubcap_key)) = crate::lua_sources::get_hubcap_api_key(app) {
            let mut zip_available = true;
            if let Ok(client) = build_client() {
                if let Ok(Some(contents)) =
                    crate::lua_sources::fetch_hubcap_app_contents(&client, &hubcap_key, appid)
                {
                    if !contents.zip_exists {
                        zip_available = false;
                    }
                }
            }

            if zip_available {
                let _ = app.emit(
                    "depot-download-progress",
                    DepotDownloadProgressEvent {
                        event_type: "log".to_string(),
                        appid,
                        build_id: "selective".to_string(),
                        depot_id: None,
                        message: Some(format!("[Tối ưu Quota] Phát hiện {} depots chưa có manifest. Đang tải trọn gói Bundle ZIP từ Hubcap...", missing_manifests_count)),
                        current_depot_index: 0,
                        total_depots,
                        progress_percent: None,
                        speed_mbps: None,
                        transferred_bytes: None,
                        total_bytes: Some(total_bytes),
                        success: None,
                        phase: Some("manifest".to_string()),
                    },
                );
                match fetch_and_extract_hubcap_bundle(app, &hubcap_key, appid) {
                Ok(count) => {
                    let _ = app.emit(
                        "depot-download-progress",
                        DepotDownloadProgressEvent {
                            event_type: "log".to_string(),
                            appid,
                            build_id: "selective".to_string(),
                            depot_id: None,
                            message: Some(format!("[Tối ưu Quota] Đã giải nén trọn gói {} manifests từ Hubcap vào cache (chỉ tiêu thụ 1 Bundle Quota).", count)),
                            current_depot_index: 0,
                            total_depots,
                            progress_percent: None,
                            speed_mbps: None,
                            transferred_bytes: None,
                            total_bytes: Some(total_bytes),
                            success: None,
                            phase: Some("manifest".to_string()),
                        },
                    );
                }
                Err(err) => {
                    let _ = app.emit(
                        "depot-download-progress",
                        DepotDownloadProgressEvent {
                            event_type: "log".to_string(),
                            appid,
                            build_id: "selective".to_string(),
                            depot_id: None,
                            message: Some(format!("Bundle ZIP không khả dụng ({}), chuyển sang tải manifest đơn cho từng depot.", err)),
                            current_depot_index: 0,
                            total_depots,
                            progress_percent: None,
                            speed_mbps: None,
                            transferred_bytes: None,
                            total_bytes: Some(total_bytes),
                            success: None,
                            phase: Some("manifest".to_string()),
                        },
                    );
                }
            }
        }
    }
    }

    for (index, sel) in selections.iter().enumerate() {
        if CANCEL_REQUESTED.load(Ordering::SeqCst) {
            let _ = fs::remove_file(&temp_keys_file);
            return Err("Cancelled by user".to_string());
        }
        if PAUSE_REQUESTED.load(Ordering::SeqCst) {
            let _ = fs::remove_file(&temp_keys_file);
            return Ok(PipelineOutcome::Paused);
        }

        // Check manifest file in Steam depotcache, local launcher cache, then Hubcap as primary source
        let mut manifest_path_opt: Option<PathBuf> = None;
        let mut target_m_id = sel.manifest_id.clone();
        if target_m_id.is_none() {
            // 1. Try free manifest.steam.run (no API key required)
            if let Ok(client) = build_client() {
                let url = format!("https://manifest.steam.run/api/depot/{}", appid);
                if let Ok(resp) = client
                    .get(&url)
                    .header("User-Agent", "0xoLemon-Launcher/2.0")
                    .header("Accept", "application/json")
                    .send()
                {
                    if resp.status().is_success() {
                        if let Ok(data) = resp.json::<SteamRunDepotResponse>() {
                            if let Some(item) = data.depots.iter().find(|d| d.depotid == sel.depot_id) {
                                if let Some(ref m_id) = item.manifestid {
                                    if !m_id.is_empty() {
                                        target_m_id = Some(m_id.clone());
                                    }
                                }
                            }
                        }
                    }
                }
            }
            // 2. Try Hubcap API if key present
            if target_m_id.is_none() {
                if let Ok(Some(hubcap_key)) = crate::lua_sources::get_hubcap_api_key(app) {
                    if let Ok(client) = build_client() {
                        if let Ok(Some(contents)) =
                            crate::lua_sources::fetch_hubcap_app_contents(&client, &hubcap_key, appid)
                        {
                            if let Some(item) = contents
                                .manifests
                                .iter()
                                .find(|m| m.depot_id == sel.depot_id.to_string())
                            {
                                target_m_id = Some(item.manifest_id.clone());
                            }
                        }
                    }
                }
            }
        }
        if let Some(ref m_id) = target_m_id {
            // 1. Steam depotcache (local — no network)
            if let Some(ref s_dir) = steam_dir {
                let cache_manifest = s_dir
                    .join("depotcache")
                    .join(format!("{}_{}.manifest", sel.depot_id, m_id));
                if crate::steam_manifest_integrity::matches_manifest(
                    &cache_manifest,
                    sel.depot_id as u64,
                    m_id,
                ) {
                    manifest_path_opt = Some(cache_manifest);
                }
            }
            // 2. Local launcher depotcache (previously downloaded — no network)
            if manifest_path_opt.is_none() {
                let local_cache = get_launcher_depotcache_dir(app)
                    .join(format!("{}_{}.manifest", sel.depot_id, m_id));
                if crate::steam_manifest_integrity::matches_manifest(
                    &local_cache,
                    sel.depot_id as u64,
                    m_id,
                ) {
                    manifest_path_opt = Some(local_cache);
                }
            }
            // 3. Provider manifest sources: Ryuu -> LUIE -> Hubcap.
            if manifest_path_opt.is_none() {
                if let Some(bytes) = fetch_priority_manifest_bytes(
                    app,
                    appid,
                    sel.depot_id as u32,
                    m_id,
                ) {
                    let target = get_launcher_depotcache_dir(app)
                        .join(format!("{}_{}.manifest", sel.depot_id, m_id));
                    if crate::steam_manifest_integrity::matches_manifest_bytes(
                        &bytes,
                        sel.depot_id as u64,
                        m_id,
                    ) && crate::lua_live::atomic_write_path(&target, &bytes).is_ok()
                    {
                        manifest_path_opt = Some(target);
                    }
                }
            }
            // 4. Hubcap is already included above; this block remains only for
            // compatibility with older provider packages that do not expose the
            // requested manifest in their archive.
            if manifest_path_opt.is_none() {
                if let Ok(Some(hubcap_key)) = crate::lua_sources::get_hubcap_api_key(app) {
                    let _ = app.emit(
                        "depot-download-progress",
                        DepotDownloadProgressEvent {
                            event_type: "log".to_string(),
                            appid,
                            build_id: "selective".to_string(),
                            depot_id: Some(sel.depot_id.to_string()),
                            message: Some(format!(
                                "[Manifest] Depot {} chưa có cache. Đang tạo manifest từ Hubcap...",
                                sel.depot_id
                            )),
                            current_depot_index: index + 1,
                            total_depots,
                            progress_percent: None,
                            speed_mbps: None,
                            transferred_bytes: None,
                            total_bytes: Some(total_bytes),
                            success: None,
                            phase: Some("manifest".to_string()),
                        },
                    );
                    match fetch_hubcap_manifest_bytes(&hubcap_key, sel.depot_id, m_id) {
                        Ok(bytes) => {
                            let target = get_launcher_depotcache_dir(app)
                                .join(format!("{}_{}.manifest", sel.depot_id, m_id));
                            let valid = crate::steam_manifest_integrity::matches_manifest_bytes(
                                &bytes,
                                sel.depot_id as u64,
                                m_id,
                            );
                            if valid && crate::lua_live::atomic_write_path(&target, &bytes).is_ok() {
                                manifest_path_opt = Some(target);
                                let _ = crate::lua_sources::refresh_hubcap_state_blocking(app);
                            }
                        }
                        Err(err_msg) => {
                            let _ = app.emit(
                                "depot-download-progress",
                                DepotDownloadProgressEvent {
                                    event_type: "log".to_string(),
                                    appid,
                                    build_id: "selective".to_string(),
                                    depot_id: Some(sel.depot_id.to_string()),
                                    message: Some(format!(
                                        "Lưu ý: Không thể tải manifest từ Hubcap ({})",
                                        err_msg
                                    )),
                                    current_depot_index: index + 1,
                                    total_depots,
                                    progress_percent: None,
                                    speed_mbps: None,
                                    transferred_bytes: None,
                                    total_bytes: Some(total_bytes),
                                    success: None,
                                    phase: Some("manifest".to_string()),
                                },
                            );
                        }
                    }
                }
            }
        }

        let _ = app.emit(
            "depot-download-progress",
            DepotDownloadProgressEvent {
                event_type: "depot-start".to_string(),
                appid,
                build_id: "selective".to_string(),
                depot_id: Some(sel.depot_id.to_string()),
                message: Some(format!(
                    "[{}/{}] Đang chuẩn bị tải Depot {}...",
                    index + 1,
                    total_depots,
                    sel.depot_id
                )),
                current_depot_index: index + 1,
                total_depots,
                progress_percent: Some(
                    ((completed_bytes as f64) / (total_bytes.max(1) as f64)) * 100.0,
                ),
                speed_mbps: None,
                transferred_bytes: Some(completed_bytes),
                total_bytes: Some(total_bytes),
                success: None,
                phase: Some("manifest".to_string()),
            },
        );

        let mut cmd = Command::new(&exe);
        cmd.arg("-app")
            .arg(appid.to_string())
            .arg("-depot")
            .arg(sel.depot_id.to_string());

        if let Some(ref gid) = target_m_id {
            cmd.arg("-manifest").arg(gid);
        }

        if temp_keys_file.is_file() {
            cmd.arg("-depotkeys").arg(&temp_keys_file);
        }

        if let Some(ref mf) = manifest_path_opt {
            cmd.arg("-manifestfile").arg(mf);
        }

        cmd.arg("-dir")
            .arg(destination_dir)
            .arg("-max-downloads")
            .arg(max_concurrency.to_string())
            .arg("-cellid")
            .arg(steam_cell_id().to_string())
            .arg("-progress")
            .arg("line");

        if do_verify {
            cmd.arg("-validate");
        }

        #[cfg(target_os = "windows")]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
        }

        cmd.stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped());

        let mut child = cmd
            .spawn()
            .map_err(|e| format!("Không thể khởi chạy DepotDownloaderMod: {}", e))?;

        if let Ok(mut active) = ACTIVE_DOWNLOAD.lock() {
            if let Some(ref mut state) = *active {
                state.child_process_id = Some(child.id());
            }
        }

        let mut last_speed_calc = std::time::Instant::now();
        let mut last_speed_bytes = completed_bytes;
        let mut dynamic_speed_mbps: Option<f64> = None;
        let mut current_phase = "downloading".to_string();

        if let Some(stdout) = child.stdout.take() {
            let reader = std::io::BufReader::new(stdout);
            for line in reader.lines().flatten() {
                let trimmed = line.trim().to_string();
                if trimmed.is_empty() {
                    continue;
                }

                if PAUSE_REQUESTED.load(Ordering::SeqCst) {
                    let _ = child.kill();
                    let _ = fs::remove_file(&temp_keys_file);
                    return Ok(PipelineOutcome::Paused);
                }
                if CANCEL_REQUESTED.load(Ordering::SeqCst) {
                    let _ = child.kill();
                    let _ = fs::remove_file(&temp_keys_file);
                    return Err("Cancelled by user".to_string());
                }

                // Detect Phase
                if trimmed.starts_with("Pre-allocating ") {
                    current_phase = "pre_allocating".to_string();
                } else if trimmed.starts_with("Validating ") {
                    current_phase = "validating".to_string();
                } else if trimmed.starts_with("Downloading depot ") {
                    current_phase = "downloading".to_string();
                }

                // Parse percentage
                let mut parsed_pct: Option<f64> = None;
                if let Some(pct_idx) = trimmed.find('%') {
                    let before = &trimmed[..pct_idx];
                    let num_str: String = before
                        .chars()
                        .rev()
                        .take_while(|c| c.is_digit(10) || *c == '.')
                        .collect();
                    let num_str: String = num_str.chars().rev().collect();
                    if let Ok(pct) = num_str.parse::<f64>() {
                        let depot_fraction = (completed_bytes as f64) / (total_bytes.max(1) as f64);
                        let depot_weight = (sel.size as f64) / (total_bytes.max(1) as f64);
                        let total_pct = (depot_fraction + (pct / 100.0) * depot_weight) * 100.0;
                        parsed_pct = Some(total_pct.min(99.9));
                    }
                }

                // Parse speed from line if available (e.g. "12.4 MB/s", "650 KB/s")
                let mut parsed_speed_mbps: Option<f64> = None;
                if let Ok(re_speed) =
                    regex::Regex::new(r#"(?i)(\d+(?:\.\d+)?)\s*(kb|mb|gb|kib|mib|gib|b)/s"#)
                {
                    if let Some(cap) = re_speed.captures(&trimmed) {
                        if let (Some(num_m), Some(unit_m)) = (cap.get(1), cap.get(2)) {
                            if let Ok(num) = num_m.as_str().parse::<f64>() {
                                let unit = unit_m.as_str().to_lowercase();
                                let mbps = match unit.as_str() {
                                    "gb" | "gib" => num * 1024.0,
                                    "mb" | "mib" => num,
                                    "kb" | "kib" => num / 1024.0,
                                    _ => num / (1024.0 * 1024.0),
                                };
                                parsed_speed_mbps = Some(mbps);
                            }
                        }
                    }
                }

                let transferred = if let Some(pct) = parsed_pct {
                    Some(((total_bytes as f64) * (pct / 100.0)) as u64)
                } else {
                    Some(completed_bytes)
                };

                // Dynamic speed calculation if stdout line did not provide explicit speed
                if let Some(cur_bytes) = transferred {
                    let elapsed = last_speed_calc.elapsed().as_secs_f64();
                    if elapsed >= 0.5 {
                        if cur_bytes > last_speed_bytes {
                            let delta_bytes = cur_bytes - last_speed_bytes;
                            let bps = (delta_bytes as f64) / elapsed;
                            dynamic_speed_mbps = Some((bps / (1024.0 * 1024.0)).max(0.01));
                            last_speed_calc = std::time::Instant::now();
                            last_speed_bytes = cur_bytes;
                        } else if elapsed >= 3.0 {
                            dynamic_speed_mbps = Some(0.0);
                            last_speed_calc = std::time::Instant::now();
                        }
                    }
                }

                let effective_speed = parsed_speed_mbps.or(dynamic_speed_mbps);

                let _ = app.emit(
                    "depot-download-progress",
                    DepotDownloadProgressEvent {
                        event_type: "log".to_string(),
                        appid,
                        build_id: "selective".to_string(),
                        depot_id: Some(sel.depot_id.to_string()),
                        message: Some(trimmed),
                        current_depot_index: index + 1,
                        total_depots,
                        progress_percent: parsed_pct,
                        speed_mbps: effective_speed,
                        transferred_bytes: transferred,
                        total_bytes: Some(total_bytes),
                        success: None,
                        phase: Some(current_phase.clone()),
                    },
                );
            }
        }

        let wait_res = child.wait();
        if PAUSE_REQUESTED.load(Ordering::SeqCst) {
            let _ = fs::remove_file(&temp_keys_file);
            return Ok(PipelineOutcome::Paused);
        }
        if CANCEL_REQUESTED.load(Ordering::SeqCst) {
            let _ = fs::remove_file(&temp_keys_file);
            return Err("Cancelled by user".to_string());
        }
        let status = wait_res.map_err(|e| format!("Lỗi chờ tiến trình depot kết thúc: {}", e))?;
        if !status.success() {
            let _ = fs::remove_file(&temp_keys_file);
            return Err(format!(
                "DepotDownloaderMod kết thúc với mã lỗi {} tại Depot {}",
                status, sel.depot_id
            ));
        }

        completed_bytes += sel.size;
    }

    let _ = fs::remove_file(&temp_keys_file);
    Ok(PipelineOutcome::Completed)
}

// ─── Hubcap Manifest & Keys Fallback Integration ─────────────────────────────

pub fn get_launcher_depotcache_dir(app: &AppHandle) -> PathBuf {
    let dir = app
        .path()
        .app_data_dir()
        .unwrap_or_else(|_| PathBuf::from("."))
        .join("depotcache");
    let _ = fs::create_dir_all(&dir);
    dir
}

/// Resolve a manifest from the configured Lua providers before falling back to
/// the legacy Hugging Face Depotdownloader mirror. Provider packages contain
/// the manifest bytes alongside their Lua/key payload, so this path is shared
/// by Store downloads without changing the Lua Shop flow.
fn fetch_priority_manifest_bytes(
    app: &AppHandle,
    appid: u32,
    depot_id: u32,
    manifest_id: &str,
) -> Option<Vec<u8>> {
    let matches = |package: &crate::lua_sources::CanonicalPackage| {
        package
            .manifests
            .iter()
            .find(|manifest| {
                manifest.depot_id == depot_id && manifest.manifest_gid == manifest_id
            })
            .map(|manifest| manifest.bytes.clone())
    };

    // Provider priority: Ryuu → LUIE → manifest.steam.run (free) → Hubcap (paid key).
    if let Ok(Some(package)) = crate::lua_sources::fetch_ryuu_package(app, appid) {
        if let Some(bytes) = matches(&package) {
            return Some(bytes);
        }
    }
    if let Ok(Some(package)) = crate::lua_sources::fetch_luatools_direct_package(
        app,
        appid,
        crate::lua_sources::LuaSourceProvider::Luie,
    ) {
        if let Some(bytes) = matches(&package) {
            return Some(bytes);
        }
    }
    // Free manifest.steam.run — try before consuming paid Hubcap quota
    if let Ok(client) = build_client() {
        let url = format!(
            "https://manifest.steam.run/api/download_manifest?depot_id={}&manifest_id={}",
            depot_id, manifest_id
        );
        if let Ok(resp) = client
            .get(&url)
            .header("User-Agent", "0xoLemon-Launcher/2.0")
            .header("Accept", "application/octet-stream")
            .send()
        {
            if resp.status().is_success() {
                if let Ok(bytes) = resp.bytes() {
                    let bytes = bytes.to_vec();
                    if crate::steam_manifest_integrity::matches_manifest_bytes(
                        &bytes,
                        depot_id as u64,
                        manifest_id,
                    ) {
                        return Some(bytes);
                    }
                }
            }
        }
    }
    if let Ok(Some(key)) = crate::lua_sources::get_hubcap_api_key(app) {
        if let Ok(bytes) = fetch_hubcap_manifest_bytes(&key, depot_id as u64, manifest_id) {
            if crate::steam_manifest_integrity::matches_manifest_bytes(
                &bytes,
                depot_id as u64,
                manifest_id,
            ) {
                return Some(bytes);
            }
        }
    }
    None
}

pub fn fetch_hubcap_manifest_bytes(
    key: &str,
    depot_id: u64,
    manifest_id: &str,
) -> Result<Vec<u8>, String> {
    let client = build_client()?;
    let url = format!(
        "https://hubcapmanifest.com/api/v1/generate/manifest?depot_id={}&manifest_id={}",
        depot_id, manifest_id
    );
    let resp = client
        .get(&url)
        .header(AUTHORIZATION, format!("Bearer {}", key.trim()))
        .send()
        .map_err(|e| format!("Không thể kết nối Hubcap Manifest API: {}", e))?;

    if resp.status() == reqwest::StatusCode::TOO_MANY_REQUESTS {
        return Err("HUBCAP_RATE_LIMITED: Đã vượt quá giới hạn tạo manifest hôm nay.".to_string());
    }
    if resp.status() == reqwest::StatusCode::UNAUTHORIZED
        || resp.status() == reqwest::StatusCode::FORBIDDEN
    {
        return Err("HUBCAP_KEY_INVALID: Hubcap API Key không hợp lệ hoặc đã hết hạn.".to_string());
    }
    if !resp.status().is_success() {
        return Err(format!("Hubcap Manifest trả về mã HTTP {}", resp.status()));
    }

    let bytes = resp
        .bytes()
        .map_err(|e| format!("Lỗi đọc nội dung manifest từ Hubcap: {}", e))?;
    if bytes.is_empty() {
        return Err("Hubcap trả về manifest rỗng.".to_string());
    }
    Ok(bytes.to_vec())
}

pub fn fetch_and_extract_hubcap_bundle(
    app: &AppHandle,
    key: &str,
    appid: u32,
) -> Result<usize, String> {
    let client = build_client()?;
    let url = format!(
        "https://hubcapmanifest.com/api/v1/generate/appmanifest/{}?branch=public",
        appid
    );
    let resp = client
        .get(&url)
        .header(AUTHORIZATION, format!("Bearer {}", key.trim()))
        .send()
        .map_err(|e| format!("Không thể kết nối Hubcap Bundle API: {}", e))?;

    if !resp.status().is_success() {
        return Err(format!(
            "Hubcap Bundle API trả về mã HTTP {}",
            resp.status()
        ));
    }

    let bytes = resp
        .bytes()
        .map_err(|e| format!("Lỗi tải dữ liệu bundle ZIP: {}", e))?;
    let cursor = std::io::Cursor::new(bytes);
    let mut archive =
        ZipArchive::new(cursor).map_err(|e| format!("Lỗi đọc file ZIP từ Hubcap: {}", e))?;

    let launcher_cache = get_launcher_depotcache_dir(app);
    let mut extracted_manifests = 0;

    for i in 0..archive.len() {
        let mut file = archive
            .by_index(i)
            .map_err(|e| format!("Lỗi đọc file trong ZIP: {}", e))?;
        let name = file.name().to_string();
        let path = Path::new(&name);
        let file_name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");

        if file_name.ends_with(".manifest") {
            let Some((depot_id, manifest_gid)) = crate::steam_manifest_integrity::manifest_identity_from_name(file_name) else {
                continue;
            };
            let mut bytes = Vec::new();
            file.read_to_end(&mut bytes)
                .map_err(|e| format!("Lỗi đọc manifest: {}", e))?;
            if !crate::steam_manifest_integrity::matches_manifest_bytes(&bytes, depot_id, &manifest_gid) {
                continue;
            }
            let dest = launcher_cache.join(file_name);
            fs::write(&dest, bytes).map_err(|e| format!("Lỗi lưu manifest: {}", e))?;
            extracted_manifests += 1;
        } else if file_name.ends_with(".lua") {
            let mut text = String::new();
            file.read_to_string(&mut text)
                .map_err(|_| "DEPOT_LUA_INVALID_ENCODING")?;
            let mut keys = HashMap::new();
            extract_keys_from_lua(&text, &mut keys);
            fetched_key_cache()
                .lock()
                .map_err(|_| "DEPOT_KEY_CACHE_LOCKED")?
                .insert(appid, keys);
        }
    }

    let _ = crate::lua_sources::refresh_hubcap_state_blocking(app);
    Ok(extracted_manifests)
}

pub fn fetch_hubcap_lua_keys(key: &str, appid: u32) -> Result<HashMap<u64, String>, String> {
    let client = build_client()?;
    let url = format!("https://hubcapmanifest.com/api/v1/lua/{}", appid);
    let resp = client
        .get(&url)
        .header(AUTHORIZATION, format!("Bearer {}", key.trim()))
        .send()
        .map_err(|e| format!("Không thể kết nối Hubcap Lua API: {}", e))?;

    if resp.status() == reqwest::StatusCode::TOO_MANY_REQUESTS {
        return Err("HUBCAP_RATE_LIMITED: Đã vượt quá giới hạn tải Lua hôm nay.".to_string());
    }
    if resp.status() == reqwest::StatusCode::UNAUTHORIZED
        || resp.status() == reqwest::StatusCode::FORBIDDEN
    {
        return Err("HUBCAP_KEY_INVALID: Hubcap API Key không hợp lệ hoặc đã hết hạn.".to_string());
    }
    if !resp.status().is_success() {
        return Err(format!("Hubcap Lua trả về mã HTTP {}", resp.status()));
    }

    let text = resp
        .text()
        .map_err(|e| format!("Lỗi đọc nội dung Lua từ Hubcap: {}", e))?;
    let mut keys = HashMap::new();
    extract_keys_from_lua(&text, &mut keys);

    // Provider discovery must never install or overwrite the active Steam Lua.
    if let Ok(mut cache) = fetched_key_cache().lock() {
        let entry = cache.entry(appid).or_default();
        for (k, v) in &keys {
            entry.insert(*k, v.clone());
        }
    }
    Ok(keys)
}

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ProviderQuotaBucket {
    pub used: Option<u64>,
    pub limit: Option<u64>,
    pub remaining: Option<u64>,
}
impl From<crate::lua_sources::HubcapUsageBucket> for ProviderQuotaBucket {
    fn from(v: crate::lua_sources::HubcapUsageBucket) -> Self {
        Self {
            used: v.usage,
            limit: v.limit,
            remaining: v.remaining,
        }
    }
}
#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ProviderQuotaBuckets {
    pub single: ProviderQuotaBucket,
    pub bundle: ProviderQuotaBucket,
    pub daily: ProviderQuotaBucket,
}
#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct DepotHubcapStatus {
    pub configured: bool,
    pub valid: bool,
    pub service_ready: bool,
    pub fetched_at: i64,
    pub stale: bool,
    pub buckets: ProviderQuotaBuckets,
    pub error_code: Option<String>,
}
#[command]
pub async fn depot_downloader_get_hubcap_status(
    app: AppHandle,
) -> Result<DepotHubcapStatus, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = crate::lua_sources::refresh_hubcap_state_blocking(&app)?;
        Ok(DepotHubcapStatus {
            configured: state.configured,
            valid: state.valid,
            service_ready: state.service_ready,
            fetched_at: state
                .last_checked_at
                .as_deref()
                .and_then(|v| chrono::DateTime::parse_from_rfc3339(v).ok())
                .map(|v| v.timestamp_millis())
                .unwrap_or(0),
            stale: state.last_error.is_some() || state.last_checked_at.is_none(),
            buckets: ProviderQuotaBuckets {
                single: state.single.into(),
                bundle: state.bundle.into(),
                daily: state.daily.into(),
            },
            error_code: state.last_error,
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct DepotHubcapSyncResult {
    pub success: bool,
    pub keys_added: usize,
    pub total_keys: usize,
    pub hubcap_configured: bool,
    pub single_quota_remaining: Option<u64>,
    pub single_quota_limit: Option<u64>,
    pub daily_quota_remaining: Option<u64>,
    pub daily_quota_limit: Option<u64>,
    pub message: String,
}

#[command]
pub async fn depot_downloader_sync_hubcap(
    app: AppHandle,
    appid: u32,
) -> Result<DepotHubcapSyncResult, String> {
    let before_keys = resolve_keys_for_app(appid);
    let before_count = before_keys.len();

    // Auto fetch from all sources (Ryuu, LUIE, Hubcap)
    auto_fetch_all_depot_keys(&app, appid);

    let after_keys = resolve_keys_for_app(appid);
    let after_count = after_keys.len();
    let keys_added = after_count.saturating_sub(before_count);

    let state = crate::lua_sources::refresh_hubcap_state_blocking(&app).unwrap_or_default();

    let hubcap_configured = crate::lua_sources::get_hubcap_api_key(&app)
        .map(|k| k.is_some())
        .unwrap_or(false);

    Ok(DepotHubcapSyncResult {
        success: true,
        keys_added,
        total_keys: after_count,
        hubcap_configured,
        single_quota_remaining: state.single.remaining,
        single_quota_limit: state.single.limit,
        daily_quota_remaining: state.daily.remaining,
        daily_quota_limit: state.daily.limit,
        message: format!(
            "Đồng bộ thành công: Đã lấy mới {} keys giải mã từ Ryuu, LUIE và Hubcap.",
            keys_added
        ),
    })
}

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct GameSearchResult {
    pub appid: u32,
    pub name: String,
    pub thumbnail: Option<String>,
}

#[command]
pub async fn depot_downloader_search_games(
    _app: AppHandle,
    query: String,
) -> Result<Vec<GameSearchResult>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let q = query.trim();
        if q.is_empty() {
            return Ok(Vec::new());
        }
        if q.len() > 256 {
            return Err("INVALID_SEARCH_QUERY".into());
        }
        if q.bytes().all(|c| c.is_ascii_digit()) {
            let id = q
                .parse::<u32>()
                .ok()
                .filter(|id| *id > 0)
                .ok_or("INVALID_APP_ID")?;
            return Ok(vec![GameSearchResult {
                appid: id,
                name: format!("AppID {id}"),
                thumbnail: Some(format!(
                    "https://shared.fastly.steamstatic.com/store_item_assets/steam/apps/{id}/header.jpg"
                )),
            }]);
        }
        let client = build_client()?;
        let response = client
            .get("https://store.steampowered.com/api/storesearch/")
            .query(&[("term", q), ("cc", "us"), ("l", "english")])
            .timeout(std::time::Duration::from_secs(8))
            .send()
            .map_err(|_| "SEARCH_NETWORK_ERROR")?;
        if !response.status().is_success() {
            return Err(if response.status().as_u16() == 429 {
                "SEARCH_RATE_LIMITED"
            } else {
                "SEARCH_PROVIDER_UNAVAILABLE"
            }
            .into());
        }
        let value: serde_json::Value = response.json().map_err(|_| "SEARCH_INVALID_RESPONSE")?;
        let items = value
            .get("items")
            .and_then(|v| v.as_array())
            .ok_or("SEARCH_INVALID_RESPONSE")?;
        Ok(items
            .iter()
            .filter_map(|item| {
                if item.get("type").and_then(|v| v.as_str()) != Some("app") {
                    return None;
                }
                let appid = u32::try_from(item.get("id")?.as_u64()?).ok()?;
                let name = item.get("name")?.as_str()?.to_string();
                let thumbnail = item
                    .get("tiny_image")
                    .and_then(|v| v.as_str())
                    .map(str::to_owned)
                    .or_else(|| {
                        Some(format!(
                            "https://shared.fastly.steamstatic.com/store_item_assets/steam/apps/{appid}/header.jpg"
                        ))
                    });
                Some(GameSearchResult {
                    appid,
                    name,
                    thumbnail,
                })
            })
            .collect())
    })
    .await
    .map_err(|error| error.to_string())?
}
