//! Direct Steam API proxy commands.
//!
//! These Tauri commands call external APIs directly from the Rust backend
//! (avoids CORS, no Render backend needed).
//!
//! Endpoints used:
//!  • Steam News (public):      api.steampowered.com/ISteamNews/GetNewsForApp/v2
//!  • Steam Store API:          store.steampowered.com/api/appdetails   ← DLC, devs, pubs, genres
//!  • steam-metadata CDN:       raw.githubusercontent.com/isagi3097-cell/steam-metadata
//!  • Global achievement %:     api.steampowered.com/ISteamUserStats/GetGlobalAchievementPercentagesForApp/v2

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::time::Duration;

const STEAM_METADATA_CDN: &str =
    "https://raw.githubusercontent.com/isagi3097-cell/steam-metadata/main/data";

// ── Types returned to the frontend ────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SteamNewsItem {
    pub gid: String,
    pub title: String,
    pub url: String,
    pub author: String,
    /// Short plaintext excerpt (HTML stripped)
    pub excerpt: String,
    /// Full raw news content (HTML / BBCode)
    pub contents: String,
    /// ISO 8601 date string
    pub date: String,
    pub feed_type: u8,
    pub thumbnail: Option<String>,
    pub tags: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SteamAppMeta {
    pub appid: u32,
    pub name: Option<String>,
    pub install_dir: Option<String>,
    pub os_list: Vec<String>,
    pub tags: Vec<String>,
    pub developers: Vec<String>,
    pub publishers: Vec<String>,
    pub website: Option<String>,
    pub branches: Vec<SteamBranchInfo>,
    pub dlc: Vec<u32>,
    pub release_date: Option<String>,
    pub launch_executables: Vec<String>,
    pub launch_options: Vec<String>,
    pub header_image: Option<String>,
    pub hero_image: Option<String>,
    pub logo_image: Option<String>,
    pub capsule_image: Option<String>,
}

/// Resolves Steam store assets, supporting modern hashed assets,
/// nested { image: { english: "..." } }, and library_assets_full.
pub fn resolve_steam_metadata_asset(root: &Value, id: u32, key: &str, fallback_file: &str) -> String {
    let extract_path = |val: &Value| -> Option<String> {
        if let Some(s) = val.as_str() {
            if !s.is_empty() { return Some(s.to_string()); }
        }
        if let Some(obj) = val.as_object() {
            let target = obj.get("image").and_then(Value::as_object).unwrap_or(obj);
            for lang in &["english", "vietnamese", "default", "schinese", "tchinese", "japanese", "koreana"] {
                if let Some(s) = target.get(*lang).and_then(Value::as_str) {
                    if !s.is_empty() { return Some(s.to_string()); }
                }
            }
            for (_k, v) in target {
                if let Some(s) = v.as_str() {
                    if !s.is_empty() { return Some(s.to_string()); }
                }
            }
        }
        None
    };

    let common = root.get("common");
    let path = common
        .and_then(|c| c.get("library_assets_full"))
        .and_then(|laf| laf.get(key))
        .and_then(|item| item.get("image2x").or_else(|| item.get("image")).or(Some(item)))
        .and_then(extract_path)
        .or_else(|| common.and_then(|c| c.get(key)).and_then(extract_path));

    if let Some(p) = path {
        if p.starts_with("http://") || p.starts_with("https://") {
            p
        } else {
            format!("https://shared.fastly.steamstatic.com/store_item_assets/steam/apps/{id}/{p}")
        }
    } else {
        format!("https://shared.fastly.steamstatic.com/store_item_assets/steam/apps/{id}/{fallback_file}")
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SteamBranchInfo {
    pub name: String,
    pub build_id: String,
    pub time_updated: Option<i64>,
    pub password_required: bool,
}

pub fn get_steam_web_api_key() -> String {
    if let Ok(key) = std::env::var("STEAM_WEB_API_KEY") {
        let trimmed = key.trim();
        if !trimmed.is_empty() {
            return trimmed.to_string();
        }
    }
    // Hardcoded obfuscated Steam Web API Key provided by user ("C8389A6AE249466D0A5234DC9D2D23C6")
    let enc: [u8; 32] = [
        25, 98, 105, 98, 99, 27, 108, 27, 31, 104, 110, 99, 110, 108, 108, 30,
        106, 27, 111, 104, 105, 110, 30, 25, 99, 30, 104, 30, 104, 105, 25, 108,
    ];
    let mask: u8 = 0x5a;
    let bytes: Vec<u8> = enc.iter().map(|b| b ^ mask).collect();
    String::from_utf8(bytes).unwrap_or_else(|_| "C8389A6AE249466D0A5234DC9D2D23C6".to_string())
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SteamAchievementGlobal {
    pub name: String,
    pub percent: f64,
    #[serde(default)]
    pub display_name: Option<String>,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub icon: Option<String>,
    #[serde(default)]
    pub icon_gray: Option<String>,
    #[serde(default)]
    pub hidden: bool,
}

// ── Internal Steam API response types ─────────────────────────────────────

#[derive(Debug, Deserialize)]
struct SteamNewsResponse {
    appnews: Option<SteamNewsPayload>,
}
#[derive(Debug, Deserialize)]
struct SteamNewsPayload {
    newsitems: Vec<SteamNewsItemRaw>,
}
#[derive(Debug, Deserialize)]
struct SteamNewsItemRaw {
    #[serde(default)]
    gid: String,
    #[serde(default)]
    title: String,
    #[serde(default)]
    url: String,
    #[serde(default)]
    author: String,
    #[serde(default)]
    contents: String,
    #[serde(default)]
    date: i64,
    feedtype: Option<u8>,
    #[serde(default)]
    tags: Option<serde_json::Value>,
}

#[derive(Debug, Deserialize)]
struct SteamAchievementsResponse {
    achievementpercentages: Option<SteamAchievementsPayload>,
}
#[derive(Debug, Deserialize)]
struct SteamAchievementsPayload {
    achievements: Vec<SteamAchievementRaw>,
}
#[derive(Debug, Deserialize)]
struct SteamAchievementRaw {
    name: String,
    percent: f64,
}

// ── steam-metadata raw JSON (subset we care about) ────────────────────────

#[derive(Debug, Deserialize, Default)]
struct MetaJson {
    #[serde(rename = "name")]
    name: Option<String>,
    #[serde(rename = "installdir")]
    install_dir: Option<String>,
    #[serde(rename = "oslist")]
    os_list: Option<String>,
    #[serde(rename = "tags")]
    tags: Option<Vec<MetaTag>>,
    #[serde(rename = "developers")]
    developers: Option<Vec<String>>,
    #[serde(rename = "publishers")]
    publishers: Option<Vec<String>>,
    #[serde(rename = "website")]
    website: Option<String>,
    #[serde(rename = "dlc")]
    dlc: Option<Vec<u32>>,
    #[serde(rename = "release_date")]
    release_date: Option<String>,
    #[serde(rename = "branches")]
    branches: Option<serde_json::Value>,
    #[serde(rename = "_history")]
    history: Option<Vec<serde_json::Value>>,
    #[serde(rename = "extended")]
    extended: Option<MetaExtended>,
    #[serde(rename = "config")]
    config: Option<serde_json::Value>,
}

#[derive(Debug, Deserialize)]
struct MetaExtended {
    #[serde(rename = "listofdlc")]
    listofdlc: Option<String>,
}

#[derive(Debug, Deserialize)]
struct MetaTag {
    name: Option<String>,
    #[serde(rename = "tagid")]
    _tagid: Option<u32>,
}

// ── HTTP helper ────────────────────────────────────────────────────────────

fn build_client() -> reqwest::blocking::Client {
    reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(10))
        .user_agent("0xoLemon-Launcher/2.0")
        .build()
        .unwrap_or_default()
}

fn strip_html(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let mut in_tag = false;
    for ch in input.chars() {
        match ch {
            '<' => in_tag = true,
            '>' => in_tag = false,
            _ if !in_tag => out.push(ch),
            _ => {}
        }
    }
    // Collapse whitespace
    out.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn unix_to_iso(ts: i64) -> String {
    use std::time::{Duration, UNIX_EPOCH};
    let secs = u64::try_from(ts).unwrap_or(0);
    let d = UNIX_EPOCH + Duration::from_secs(secs);
    // Format as ISO 8601 (simple version without chrono dependency)
    let secs_since_epoch = d
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    // Convert to rough YYYY-MM-DD using integer math
    let days = secs_since_epoch / 86400;
    let mut y = 1970u32;
    let mut rem_days = days as u32;
    loop {
        let leap = (y % 4 == 0 && y % 100 != 0) || y % 400 == 0;
        let year_days = if leap { 366 } else { 365 };
        if rem_days < year_days { break; }
        rem_days -= year_days;
        y += 1;
    }
    let leap = (y % 4 == 0 && y % 100 != 0) || y % 400 == 0;
    let month_days = [31u32, if leap { 29 } else { 28 }, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    let mut m = 0usize;
    let mut rem = rem_days;
    while m < 12 && rem >= month_days[m] {
        rem -= month_days[m];
        m += 1;
    }
    format!("{:04}-{:02}-{:02}", y, m + 1, rem + 1)
}

fn thumbnail_from_contents(contents: &str) -> Option<String> {
    // 1. Check for {STEAM_CLAN_IMAGE}/... or {STEAM_CLAN_LOC_IMAGE}/...
    // "{STEAM_CLAN_IMAGE}/" = 19 bytes, so start of path = idx + 19
    if let Some(idx) = contents.find("{STEAM_CLAN_IMAGE}/") {
        let rest = &contents[idx + 19..];
        let end = rest
            .find(|c: char| c.is_whitespace() || c == '[' || c == ']' || c == '"' || c == '\'')
            .unwrap_or(rest.len());
        let path = rest[..end].trim().trim_matches(|c| c == ']' || c == '"' || c == '\'');
        if !path.is_empty() {
            return Some(format!("https://clan.akamai.steamstatic.com/images/{}", path));
        }
    }
    // "{STEAM_CLAN_LOC_IMAGE}/" = 23 bytes, so start of path = idx + 23
    if let Some(idx) = contents.find("{STEAM_CLAN_LOC_IMAGE}/") {
        let rest = &contents[idx + 23..];
        let end = rest
            .find(|c: char| c.is_whitespace() || c == '[' || c == ']' || c == '"' || c == '\'')
            .unwrap_or(rest.len());
        let path = rest[..end].trim().trim_matches(|c| c == ']' || c == '"' || c == '\'');
        if !path.is_empty() {
            return Some(format!("https://clan.akamai.steamstatic.com/images/{}", path));
        }
    }
    // 2. Check for [img]...[/img]
    if let Some(start) = contents.to_ascii_lowercase().find("[img]") {
        let rest = &contents[start + 5..];
        if let Some(end) = rest.to_ascii_lowercase().find("[/img]") {
            let mut url = rest[..end].trim().to_string();
            if url.starts_with("{STEAM_CLAN_IMAGE}/") {
                // "{STEAM_CLAN_IMAGE}/" = 19 bytes
                url = format!("https://clan.akamai.steamstatic.com/images/{}", &url[19..]);
            }
            if url.starts_with("http://") || url.starts_with("https://") {
                return Some(url);
            }
        }
    }
    // 3. Look for the first <img src="..." pattern
    let lower = contents.to_ascii_lowercase();
    if let Some(start) = lower.find("<img ") {
        let rest = &contents[start..];
        if let Some(src_start) = rest.to_ascii_lowercase().find("src=\"") {
            let after = &rest[src_start + 5..];
            if let Some(end) = after.find('"') {
                let url = &after[..end];
                if url.starts_with("http") {
                    return Some(url.to_string());
                }
            }
        }
    }
    None
}

// ── Tauri Commands ─────────────────────────────────────────────────────────

/// Fetch official news & patch notes for a Steam app from the public Steam News API.
/// Prioritizes official developer clan announcements to avoid 3rd party syndication spam.
#[tauri::command]
pub fn get_steam_news(appid: String, count: Option<u32>) -> Result<Vec<SteamNewsItem>, String> {
    let n = count.unwrap_or(8).min(20);
    if !appid.chars().all(|c| c.is_ascii_digit()) {
        return Err("Invalid appid".into());
    }
    let client = build_client();

    let parse_news = |body: &str| -> Vec<SteamNewsItem> {
        let parsed: SteamNewsResponse = match serde_json::from_str(body) {
            Ok(p) => p,
            Err(_) => return Vec::new(),
        };
        parsed
            .appnews
            .map(|n| n.newsitems)
            .unwrap_or_default()
            .into_iter()
            .map(|raw| {
                let excerpt = strip_html(&raw.contents)
                    .replace("{STEAM_CLAN_IMAGE}", "")
                    .replace("{STEAM_CLAN_LOC_IMAGE}", "")
                    .chars()
                    .take(280)
                    .collect::<String>();
                let thumbnail = thumbnail_from_contents(&raw.contents);
                let tags: Vec<String> = match raw.tags {
                    Some(serde_json::Value::Array(arr)) => arr
                        .into_iter()
                        .filter_map(|t| match t {
                            serde_json::Value::String(s) => Some(s),
                            serde_json::Value::Object(m) => m
                                .get("tag")
                                .and_then(|v| v.as_str())
                                .map(|s| s.to_string()),
                            _ => None,
                        })
                        .collect(),
                    _ => Vec::new(),
                };
                SteamNewsItem {
                    gid: raw.gid,
                    title: raw.title,
                    url: raw.url,
                    author: raw.author,
                    excerpt,
                    contents: raw.contents,
                    date: unix_to_iso(raw.date),
                    feed_type: raw.feedtype.unwrap_or(0),
                    thumbnail,
                    tags,
                }
            })
            .collect()
    };

    // 1. Try official community announcements first (patch notes & dev updates only)
    let official_url = format!(
        "https://api.steampowered.com/ISteamNews/GetNewsForApp/v2/?appid={}&count={}&feeds=steam_community_announcements&format=json",
        appid, n
    );
    if let Ok(resp) = client.get(&official_url).send() {
        if resp.status().is_success() {
            if let Ok(body) = resp.text() {
                let items = parse_news(&body);
                if !items.is_empty() {
                    return Ok(items);
                }
            }
        }
    }

    // 2. Fallback: if no official announcements exist (e.g. very old games), fetch general news
    let fallback_url = format!(
        "https://api.steampowered.com/ISteamNews/GetNewsForApp/v2/?appid={}&count={}&maxlength=600&format=json",
        appid, n
    );
    let body = client
        .get(&fallback_url)
        .send()
        .map_err(|e| format!("Network error: {e}"))?
        .text()
        .map_err(|e| format!("Read error: {e}"))?;

    Ok(parse_news(&body))
}

/// Fetch app metadata from the steam-metadata GitHub CDN repo.
/// Falls back gracefully if the JSON isn't available.
#[tauri::command]
pub fn get_steam_app_metadata(appid: String) -> Result<SteamAppMeta, String> {
    let id: u32 = appid
        .parse()
        .map_err(|_| "Invalid appid".to_string())?;

    let shard = id % 1000;
    let url = format!("{}/{:03}/{}.json", STEAM_METADATA_CDN, shard, id);

    let client = build_client();
    let resp = client
        .get(&url)
        .send()
        .map_err(|e| format!("Network error: {e}"))?;

    if !resp.status().is_success() {
        return Err(format!("Metadata not found (HTTP {})", resp.status()));
    }

    let body = resp.text().map_err(|e| format!("Read error: {e}"))?;
    let raw: Value = serde_json::from_str(&body).map_err(|e| format!("Parse error: {e}"))?;
    let meta: MetaJson = serde_json::from_value(raw.clone()).map_err(|e| format!("Parse error: {e}"))?;
    let common = raw.get("common").and_then(Value::as_object);
    let config = raw.get("config").and_then(Value::as_object);

    let common_name = common
        .and_then(|value| value.get("name"))
        .and_then(Value::as_str)
        .map(str::to_string);
    let install_dir = meta.install_dir.clone().or_else(|| {
        config
            .and_then(|value| value.get("installdir"))
            .and_then(Value::as_str)
            .map(str::to_string)
    });

    // Parse OS list
    let os_list = meta
        .os_list
        .as_deref()
        .unwrap_or("")
        .split(',')
        .filter(|s| !s.is_empty())
        .map(|s| s.trim().to_string())
        .collect();

    // Parse tags
    let tags = meta
        .tags
        .unwrap_or_default()
        .into_iter()
        .filter_map(|t| t.name)
        .collect();

    let mut launch_executables = Vec::new();
    let mut launch_options = Vec::new();
    if let Some(serde_json::Value::Object(config)) = &meta.config {
        if let Some(serde_json::Value::Object(launches)) = config.get("launch") {
            for launch in launches.values() {
                if let serde_json::Value::Object(entry) = launch {
                    if let Some(executable) = entry.get("executable").and_then(|v| v.as_str()) {
                        if !launch_executables.iter().any(|value: &String| value == executable) {
                            launch_executables.push(executable.to_string());
                        }
                    }
                    if let Some(arguments) = entry.get("arguments").and_then(|v| v.as_str()) {
                        if !launch_options.iter().any(|value: &String| value == arguments) {
                            launch_options.push(arguments.to_string());
                        }
                    }
                }
            }
        }
    }

    // Parse branches from JSON value
    let mut branches: Vec<SteamBranchInfo> = Vec::new();
    let branches_value = meta.branches.or_else(|| {
        raw.get("depots").and_then(|value| value.get("branches")).cloned()
    });
    if let Some(serde_json::Value::Object(map)) = branches_value {
        for (name, val) in map {
            let build_id = val
                .get("BuildID")
                .and_then(|v| v.as_str())
                .unwrap_or("0")
                .to_string();
            let time_updated = val
                .get("TimeUpdated")
                .and_then(|v| v.as_str())
                .and_then(|s| s.parse::<i64>().ok());
            let password_required = val
                .get("pwdrequired")
                .and_then(|v| v.as_str())
                .map(|s| s == "1")
                .unwrap_or(false);
            branches.push(SteamBranchInfo {
                name,
                build_id,
                time_updated,
                password_required,
            });
        }
        // public branch first
        branches.sort_by(|a, b| {
            if a.name == "public" { std::cmp::Ordering::Less }
            else if b.name == "public" { std::cmp::Ordering::Greater }
            else { a.name.cmp(&b.name) }
        });
    }

    // Parse DLCs
    let dlc = meta
        .extended
        .and_then(|e| e.listofdlc)
        .unwrap_or_default()
        .split(',')
        .filter(|s| !s.is_empty())
        .filter_map(|s| s.parse().ok())
        .collect();

    let header_image = Some(resolve_steam_metadata_asset(&raw, id, "header_image", "header.jpg"));
    let hero_image = Some(resolve_steam_metadata_asset(&raw, id, "library_hero", "library_hero.jpg"));
    let logo_image = Some(resolve_steam_metadata_asset(&raw, id, "library_logo", "logo.png"));
    let capsule_image = Some(resolve_steam_metadata_asset(&raw, id, "library_capsule", "library_600x900.jpg"));

    Ok(SteamAppMeta {
        appid: id,
        name: meta.name.or(common_name),
        install_dir,
        os_list,
        tags,
        developers: meta.developers.unwrap_or_default(),
        publishers: meta.publishers.unwrap_or_default(),
        website: meta.website,
        branches,
        dlc,
        release_date: meta.release_date,
        launch_executables,
        launch_options,
        header_image,
        hero_image,
        logo_image,
        capsule_image,
    })
}

/// Fetch global achievements for a Steam app.
/// Combines schema metadata (display name, description, official icons) with global unlock percentages.
#[tauri::command]
pub fn get_steam_global_achievements(appid: String) -> Result<Vec<SteamAchievementGlobal>, String> {
    if !appid.chars().all(|c| c.is_ascii_digit()) {
        return Err("Invalid appid".into());
    }
    let client = build_client();

    // 1. Fetch percentages
    let pct_url = format!(
        "https://api.steampowered.com/ISteamUserStats/GetGlobalAchievementPercentagesForApp/v2/?gameid={}&format=json",
        appid
    );
    let mut pct_map: std::collections::HashMap<String, f64> = std::collections::HashMap::new();
    if let Ok(resp) = client.get(&pct_url).send() {
        if resp.status().is_success() {
            if let Ok(body) = resp.text() {
                if let Ok(parsed) = serde_json::from_str::<SteamAchievementsResponse>(&body) {
                    if let Some(payload) = parsed.achievementpercentages {
                        for a in payload.achievements {
                            pct_map.insert(a.name, a.percent);
                        }
                    }
                }
            }
        }
    }

    // 2. Fetch schema with Steam Web API key
    let api_key = get_steam_web_api_key();
    let schema_url = format!(
        "https://api.steampowered.com/ISteamUserStats/GetSchemaForGame/v2/?key={}&appid={}&l=english",
        api_key, appid
    );
    let mut schema_items: Vec<SteamAchievementGlobal> = Vec::new();
    if let Ok(resp) = client.get(&schema_url).send() {
        if resp.status().is_success() {
            if let Ok(body) = resp.text() {
                if let Ok(root) = serde_json::from_str::<Value>(&body) {
                    if let Some(arr) = root
                        .get("game")
                        .and_then(|g| g.get("availableGameStats"))
                        .and_then(|s| s.get("achievements"))
                        .and_then(|a| a.as_array())
                    {
                        for item in arr {
                            let name = item.get("name").and_then(|v| v.as_str()).unwrap_or("").to_string();
                            let display_name = item
                                .get("displayName")
                                .and_then(|v| v.as_str())
                                .unwrap_or(&name)
                                .to_string();
                            let description = item
                                .get("description")
                                .and_then(|v| v.as_str())
                                .unwrap_or("")
                                .to_string();
                            let icon = item.get("icon").and_then(|v| v.as_str()).unwrap_or("").to_string();
                            let icon_gray = item.get("icongray").and_then(|v| v.as_str()).unwrap_or("").to_string();
                            let hidden = item.get("hidden").and_then(|v| v.as_i64()).unwrap_or(0) != 0;
                            let percent = pct_map.get(&name).copied().unwrap_or(0.0);

                            schema_items.push(SteamAchievementGlobal {
                                name,
                                percent,
                                display_name: Some(display_name),
                                description: Some(description),
                                icon: if !icon.is_empty() { Some(icon) } else { None },
                                icon_gray: if !icon_gray.is_empty() { Some(icon_gray) } else { None },
                                hidden,
                            });
                        }
                    }
                }
            }
        }
    }

    if !schema_items.is_empty() {
        schema_items.sort_by(|a, b| b.percent.partial_cmp(&a.percent).unwrap_or(std::cmp::Ordering::Equal));
        return Ok(schema_items);
    }

    // Fallback: if schema was unavailable, use global percentages
    let mut fallback_items: Vec<SteamAchievementGlobal> = pct_map
        .into_iter()
        .map(|(name, percent)| SteamAchievementGlobal {
            name,
            percent,
            display_name: None,
            description: None,
            icon: None,
            icon_gray: None,
            hidden: false,
        })
        .collect();
    fallback_items.sort_by(|a, b| b.percent.partial_cmp(&a.percent).unwrap_or(std::cmp::Ordering::Equal));
    Ok(fallback_items)
}

// ── Steam Store Detail (appdetails API) ────────────────────────────────────
//
// Much cleaner than parsing the nested steam-metadata JSON.
// Returns: name, DLC ids, developers, publishers, genres, release date, website.

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SteamDlcItem {
    pub appid: u32,
    pub name: String,
    pub header_image: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SteamScreenshotItem {
    pub id: u32,
    pub path_thumbnail: String,
    pub path_full: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SteamMovieItem {
    pub id: u32,
    pub name: String,
    pub thumbnail: String,
    pub mp4_480: Option<String>,
    pub mp4_max: Option<String>,
    pub webm_max: Option<String>,
    #[serde(default)]
    pub hls_h264: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SteamRequirements {
    pub minimum: Option<String>,
    pub recommended: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SystemSpecs {
    pub os: String,
    pub cpu: String,
    pub ram_gb: f32,
    pub gpu: String,
    pub directx: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SteamStoreDetail {
    pub appid: u32,
    pub name: String,
    pub short_description: Option<String>,
    pub detailed_description: Option<String>,
    pub about_the_game: Option<String>,
    pub dlc: Vec<u32>,
    pub dlc_details: Vec<SteamDlcItem>,
    pub developers: Vec<String>,
    pub publishers: Vec<String>,
    pub genres: Vec<String>,
    #[serde(default)]
    pub categories: Vec<String>,
    #[serde(default)]
    pub drm_notice: Option<String>,
    #[serde(default)]
    pub ext_user_account_notice: Option<String>,
    #[serde(default)]
    pub supported_languages: Option<String>,
    pub release_date: Option<String>,
    pub website: Option<String>,
    pub header_image: Option<String>,
    pub hero_image: Option<String>,
    pub logo_image: Option<String>,
    pub capsule_image: Option<String>,
    pub icon_image: Option<String>,
    pub screenshots: Vec<SteamScreenshotItem>,
    pub movies: Vec<SteamMovieItem>,
    pub pc_requirements: Option<SteamRequirements>,
    pub review_score: Option<u32>,
    pub review_score_desc: Option<String>,
    pub review_percentage: Option<u32>,
    pub metacritic_score: Option<u32>,
    pub metacritic_url: Option<String>,
    pub total_reviews: Option<u32>,
}

/// Fetch rich game metadata from the steam-metadata GitHub CDN repo.
/// Extracts official high-res assets (hero, logo, capsule 600x900) from library_assets_full,
/// plus DLC details (names & banners) from their respective JSON files.
fn fetch_from_steam_metadata_repo(id: u32) -> Result<SteamStoreDetail, String> {
    let shard = id % 1000;
    let url = format!("{}/{:03}/{}.json", STEAM_METADATA_CDN, shard, id);
    let client = build_client();
    let resp = client
        .get(&url)
        .send()
        .map_err(|e| format!("CDN network error: {e}"))?;

    if !resp.status().is_success() {
        return Err(format!("Metadata not found in repo (HTTP {})", resp.status()));
    }

    let body = resp.text().map_err(|e| format!("CDN read error: {e}"))?;
    let root: Value = serde_json::from_str(&body).map_err(|e| format!("CDN parse error: {e}"))?;

    let name = root
        .get("common")
        .and_then(|c| c.get("name"))
        .or_else(|| root.get("extended").and_then(|e| e.get("gamename")))
        .and_then(|v| v.as_str())
        .unwrap_or("Unknown")
        .to_string();

    let mut dlc_set: Vec<u32> = Vec::new();
    // 1. From extended.listofdlc ("4024620,4024630,4193060,5001840")
    if let Some(list_str) = root.get("extended").and_then(|e| e.get("listofdlc")).and_then(|v| v.as_str()) {
        for part in list_str.split(',') {
            if let Ok(dlc_id) = part.trim().parse::<u32>() {
                if !dlc_set.contains(&dlc_id) {
                    dlc_set.push(dlc_id);
                }
            }
        }
    }
    // 2. From depots.*.dlcappid
    if let Some(depots) = root.get("depots").and_then(|d| d.as_object()) {
        for (_k, v) in depots {
            if let Some(dlc_val) = v.get("dlcappid") {
                if let Some(dlc_id) = dlc_val.as_u64().map(|n| n as u32).or_else(|| dlc_val.as_str().and_then(|s| s.parse::<u32>().ok())) {
                    if !dlc_set.contains(&dlc_id) {
                        dlc_set.push(dlc_id);
                    }
                }
            }
        }
    }
    dlc_set.sort_unstable();

    let mut developers: Vec<String> = Vec::new();
    let mut publishers: Vec<String> = Vec::new();

    if let Some(dev) = root.get("extended").and_then(|e| e.get("developer")).and_then(|v| v.as_str()) {
        for s in dev.split(',') {
            let t = s.trim().to_string();
            if !t.is_empty() && !developers.contains(&t) { developers.push(t); }
        }
    }
    if let Some(publ) = root.get("extended").and_then(|e| e.get("publisher")).and_then(|v| v.as_str()) {
        for s in publ.split(',') {
            let t = s.trim().to_string();
            if !t.is_empty() && !publishers.contains(&t) { publishers.push(t); }
        }
    }

    if developers.is_empty() || publishers.is_empty() {
        if let Some(assoc) = root.get("common").and_then(|c| c.get("associations")).and_then(|a| a.as_object()) {
            for (_k, v) in assoc {
                let a_type = v.get("type").and_then(|s| s.as_str()).unwrap_or("");
                let a_name = v.get("name").and_then(|s| s.as_str()).unwrap_or("");
                if !a_name.is_empty() {
                    let name_str = a_name.to_string();
                    if a_type == "developer" && !developers.contains(&name_str) {
                        developers.push(name_str);
                    } else if a_type == "publisher" && !publishers.contains(&name_str) {
                        publishers.push(name_str);
                    }
                }
            }
        }
    }

    let hero_image = Some(resolve_steam_metadata_asset(&root, id, "library_hero", "library_hero.jpg"));
    let logo_image = Some(resolve_steam_metadata_asset(&root, id, "library_logo", "logo.png"));
    let capsule_image = Some(resolve_steam_metadata_asset(&root, id, "library_capsule", "library_600x900.jpg"));
    let header_image = Some(resolve_steam_metadata_asset(&root, id, "header_image", "header.jpg"));

    let icon_image = root
        .get("common")
        .and_then(|c| c.get("clienticon"))
        .and_then(|v| v.as_str())
        .map(|icon| format!("https://shared.fastly.steamstatic.com/store_item_assets/steam/apps/{id}/{icon}.ico"))
        .or_else(|| {
            root.get("common")
                .and_then(|c| c.get("icon"))
                .and_then(|v| v.as_str())
                .map(|icon| format!("https://cdn.cloudflare.steamstatic.com/steamcommunity/public/images/apps/{id}/{icon}.jpg"))
        });

    let website = root
        .get("extended")
        .and_then(|e| e.get("homepage"))
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());

    // Fetch detailed DLC names & banners for the first 6 DLCs
    let mut dlc_details: Vec<SteamDlcItem> = Vec::new();
    for &dlc_id in dlc_set.iter().take(6) {
        let dlc_shard = dlc_id % 1000;
        let dlc_url = format!("{}/{:03}/{}.json", STEAM_METADATA_CDN, dlc_shard, dlc_id);
        let mut dlc_name = format!("DLC {dlc_id}");
        let mut dlc_img = format!("https://shared.fastly.steamstatic.com/store_item_assets/steam/apps/{dlc_id}/header.jpg");

        if let Ok(dlc_resp) = client.get(&dlc_url).send() {
            if dlc_resp.status().is_success() {
                if let Ok(dlc_body) = dlc_resp.text() {
                    if let Ok(dlc_root) = serde_json::from_str::<Value>(&dlc_body) {
                        if let Some(n) = dlc_root.get("common").and_then(|c| c.get("name")).and_then(|v| v.as_str()) {
                            if !n.is_empty() { dlc_name = n.to_string(); }
                        }
                        if let Some(h) = dlc_root
                            .get("common")
                            .and_then(|c| c.get("header_image"))
                            .and_then(|h| h.get("english").or_else(|| h.get("default")))
                            .and_then(|v| v.as_str())
                        {
                            dlc_img = format!("https://shared.fastly.steamstatic.com/store_item_assets/steam/apps/{dlc_id}/{h}");
                        }
                    }
                }
            }
        }

        dlc_details.push(SteamDlcItem {
            appid: dlc_id,
            name: dlc_name,
            header_image: Some(dlc_img),
        });
    }

    // Reviews and metacritic from GitHub metadata JSON
    let review_score: Option<u32> = root
        .get("common")
        .and_then(|c| c.get("review_score"))
        .and_then(|v| v.as_str())
        .and_then(|s| s.parse().ok());

    let review_percentage: Option<u32> = root
        .get("common")
        .and_then(|c| c.get("review_percentage"))
        .and_then(|v| v.as_str())
        .and_then(|s| s.parse().ok());

    let review_score_desc = match review_score {
        Some(9) => Some("Overwhelmingly Positive".to_string()),
        Some(8) => Some("Very Positive".to_string()),
        Some(7) => Some("Positive".to_string()),
        Some(6) => Some("Mostly Positive".to_string()),
        Some(5) => Some("Mixed".to_string()),
        Some(4) => Some("Mostly Negative".to_string()),
        Some(3) | Some(2) | Some(1) => Some("Very Negative".to_string()),
        _ => None,
    };

    let metacritic_score: Option<u32> = root
        .get("common")
        .and_then(|c| c.get("metacritic_score"))
        .and_then(|v| v.as_str())
        .and_then(|s| s.parse().ok());

    let metacritic_url: Option<String> = root
        .get("common")
        .and_then(|c| c.get("metacritic_fullurl"))
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());

    let release_date: Option<String> = root
        .get("common")
        .and_then(|c| c.get("steam_release_date"))
        .and_then(|v| v.as_str())
        .and_then(|s| s.parse::<i64>().ok())
        .and_then(|ts| {
            chrono::DateTime::from_timestamp(ts, 0).map(|dt| dt.format("%d %b, %Y").to_string())
        });

    Ok(SteamStoreDetail {
        appid: id,
        name,
        short_description: None,
        detailed_description: None,
        about_the_game: None,
        dlc: dlc_set,
        dlc_details,
        developers,
        publishers,
        genres: Vec::new(),
        categories: Vec::new(),
        drm_notice: None,
        ext_user_account_notice: None,
        supported_languages: None,
        release_date,
        website,
        header_image,
        hero_image,
        logo_image,
        capsule_image,
        icon_image,
        screenshots: Vec::new(),
        movies: Vec::new(),
        pc_requirements: None,
        review_score,
        review_score_desc,
        review_percentage,
        metacritic_score,
        metacritic_url,
        total_reviews: None,
    })
}

fn create_fallback_store_detail(id: u32) -> SteamStoreDetail {
    let header_image = Some(format!("https://shared.fastly.steamstatic.com/store_item_assets/steam/apps/{id}/header.jpg"));
    let hero_image = Some(format!("https://shared.fastly.steamstatic.com/store_item_assets/steam/apps/{id}/library_hero.jpg"));
    let capsule_image = Some(format!("https://shared.fastly.steamstatic.com/store_item_assets/steam/apps/{id}/capsule_616x353.jpg"));
    let logo_image = Some(format!("https://shared.fastly.steamstatic.com/store_item_assets/steam/apps/{id}/logo.png"));

    SteamStoreDetail {
        appid: id,
        name: format!("App {id}"),
        short_description: None,
        detailed_description: None,
        about_the_game: None,
        dlc: Vec::new(),
        dlc_details: Vec::new(),
        developers: Vec::new(),
        publishers: Vec::new(),
        genres: Vec::new(),
        categories: Vec::new(),
        drm_notice: None,
        ext_user_account_notice: None,
        supported_languages: None,
        release_date: None,
        website: None,
        header_image,
        hero_image,
        logo_image,
        capsule_image,
        icon_image: None,
        screenshots: Vec::new(),
        movies: Vec::new(),
        pc_requirements: None,
        review_score: None,
        review_score_desc: None,
        review_percentage: None,
        metacritic_score: None,
        metacritic_url: None,
        total_reviews: None,
    }
}

/// Fetch rich game metadata. Combines steam-metadata GitHub CDN with Steam Store API.
#[tauri::command]
pub fn get_steam_store_detail(appid: String) -> Result<SteamStoreDetail, String> {
    if !appid.chars().all(|c| c.is_ascii_digit()) {
        return Err("Invalid appid".into());
    }
    let id: u32 = appid.parse().map_err(|_| "Invalid appid".to_string())?;

    // Start with the GitHub metadata repo (unblocked in Vietnam, includes library_assets_full and DLCs)
    let mut base_detail = fetch_from_steam_metadata_repo(id).unwrap_or_else(|_| create_fallback_store_detail(id));

    // Priority endpoints: store.akamai.steamstatic.com is completely unblocked in Vietnam, followed by standard regions
    let endpoints = [
        format!("https://store.akamai.steamstatic.com/api/appdetails?appids={id}&cc=us&l=english"),
        format!("https://store.akamai.steamstatic.com/api/appdetails?appids={id}&cc=sg&l=english"),
        format!("https://store.akamai.steamstatic.com/api/appdetails?appids={id}&cc=vn&l=english"),
        format!("https://store.steampowered.com/api/appdetails?appids={id}&cc=us&l=english"),
        format!("https://store.steampowered.com/api/appdetails?appids={id}&cc=sg&l=english"),
    ];

    let client = build_client();
    let mut store_api_success = false;

    for url in &endpoints {
        match client
            .get(url)
            .header("Accept-Language", "en-US,en;q=0.9")
            .header("Cookie", "birthtime=568022401; lastagecheckage=1-January-1988; mature_content=1")
            .send()
        {
            Ok(resp) if resp.status().is_success() => {
                if let Ok(body) = resp.text() {
                    if let Ok(root) = serde_json::from_str::<Value>(&body) {
                        if let Some(entry) = root.get(&appid) {
                            if entry.get("success").and_then(|v| v.as_bool()).unwrap_or(false) {
                                if let Some(data) = entry.get("data") {
                                    store_api_success = true;
                                    if base_detail.short_description.is_none() {
                                        base_detail.short_description = data
                                            .get("short_description")
                                            .and_then(|v| v.as_str())
                                            .map(|s| s.to_string());
                                    }
                                    if let Some(desc) = data.get("about_the_game").and_then(|v| v.as_str()) {
                                        base_detail.about_the_game = Some(desc.to_string());
                                    }
                                    if let Some(desc) = data.get("detailed_description").and_then(|v| v.as_str()) {
                                        base_detail.detailed_description = Some(desc.to_string());
                                    }
                                    if let Some(ss_arr) = data.get("screenshots").and_then(|v| v.as_array()) {
                                        base_detail.screenshots = ss_arr.iter().filter_map(|item| {
                                            let id = item.get("id").and_then(|v| v.as_u64()).unwrap_or(0) as u32;
                                            let thumb = item.get("path_thumbnail").and_then(|v| v.as_str()).unwrap_or("").to_string();
                                            let full = item.get("path_full").and_then(|v| v.as_str()).unwrap_or("").to_string();
                                            if !full.is_empty() {
                                                Some(SteamScreenshotItem { id, path_thumbnail: thumb, path_full: full })
                                            } else {
                                                None
                                            }
                                        }).collect();
                                    }
                                    if let Some(m_arr) = data.get("movies").and_then(|v| v.as_array()) {
                                        base_detail.movies = m_arr.iter().filter_map(|item| {
                                            let id = item.get("id").and_then(|v| v.as_u64()).unwrap_or(0) as u32;
                                            let name = item.get("name").and_then(|v| v.as_str()).unwrap_or("").to_string();
                                            let thumb = item.get("thumbnail").and_then(|v| v.as_str()).unwrap_or("").to_string();
                                            let hls_h264 = item.get("hls_h264").and_then(|v| v.as_str()).map(|s| s.to_string());
                                            let mp4_max = item.get("mp4")
                                                .and_then(|m| m.get("max"))
                                                .and_then(|v| v.as_str())
                                                .map(|s| s.to_string())
                                                .or_else(|| if id > 0 { Some(format!("https://video.akamai.steamstatic.com/store_trailers/{id}/movie_max.mp4")) } else { None });
                                            let mp4_480 = item.get("mp4")
                                                .and_then(|m| m.get("480"))
                                                .and_then(|v| v.as_str())
                                                .map(|s| s.to_string())
                                                .or_else(|| if id > 0 { Some(format!("https://video.akamai.steamstatic.com/store_trailers/{id}/movie480.mp4")) } else { None });
                                            let webm_max = item.get("webm").and_then(|w| w.get("max")).and_then(|v| v.as_str()).map(|s| s.to_string());
                                            Some(SteamMovieItem { id, name, thumbnail: thumb, mp4_480, mp4_max, webm_max, hls_h264 })
                                        }).collect();
                                    }
                                    if let Some(pc) = data.get("pc_requirements") {
                                        let min = pc.get("minimum").and_then(|v| v.as_str()).map(|s| s.to_string());
                                        let rec = pc.get("recommended").and_then(|v| v.as_str()).map(|s| s.to_string());
                                        base_detail.pc_requirements = Some(SteamRequirements { minimum: min, recommended: rec });
                                    }
                                    if let Some(cats) = data.get("categories").and_then(|v| v.as_array()) {
                                        base_detail.categories = cats.iter().filter_map(|c| c.get("description").and_then(|d| d.as_str()).map(|s| s.to_string())).collect();
                                    }
                                    if let Some(drm) = data.get("drm_notice").and_then(|v| v.as_str()) {
                                        base_detail.drm_notice = Some(drm.to_string());
                                    }
                                    if let Some(notice) = data.get("ext_user_account_notice").and_then(|v| v.as_str()) {
                                        base_detail.ext_user_account_notice = Some(notice.to_string());
                                    }
                                    if let Some(langs) = data.get("supported_languages").and_then(|v| v.as_str()) {
                                        base_detail.supported_languages = Some(langs.to_string());
                                    }
                                    if base_detail.genres.is_empty() {
                                        base_detail.genres = data
                                            .get("genres")
                                            .and_then(|v| v.as_array())
                                            .map(|arr| {
                                                 arr.iter()
                                                    .filter_map(|g| g.get("description").and_then(|d| d.as_str()).map(|s| s.to_string()))
                                                    .collect()
                                            })
                                            .unwrap_or_default();
                                    }
                                    if base_detail.release_date.is_none() {
                                        base_detail.release_date = data
                                            .get("release_date")
                                            .and_then(|v| v.get("date"))
                                            .and_then(|v| v.as_str())
                                            .map(|s| s.to_string());
                                    }
                                    if let Some(meta) = data.get("metacritic") {
                                        if let Some(score) = meta.get("score").and_then(|v| v.as_u64()) {
                                            base_detail.metacritic_score = Some(score as u32);
                                        }
                                        if let Some(m_url) = meta.get("url").and_then(|v| v.as_str()) {
                                            base_detail.metacritic_url = Some(m_url.to_string());
                                        }
                                    }
                                    if let Some(recs) = data.get("recommendations").and_then(|r| r.get("total")).and_then(|v| v.as_u64()) {
                                        base_detail.total_reviews = Some(recs as u32);
                                    }

                                    // Break out as we successfully obtained store data!
                                    break;
                                }
                            }
                        }
                    }
                }
            }
            Ok(_) => {}
            Err(_) => {
                // If this endpoint failed, continue to next fallback endpoint
                continue;
            }
        }
    }

    // Fallback: If store API was unreachable, query unblocked api.steamcmd.net
    if !store_api_success && (base_detail.developers.is_empty() || base_detail.genres.is_empty() || base_detail.short_description.is_none()) {
        let cmd_url = format!("https://api.steamcmd.net/v1/info/{id}");
        if let Ok(resp) = client.get(&cmd_url).send() {
            if resp.status().is_success() {
                if let Ok(body) = resp.text() {
                    if let Ok(root) = serde_json::from_str::<Value>(&body) {
                        if let Some(entry) = root.get("data").and_then(|d| d.get(&appid)) {
                            if let Some(common) = entry.get("common") {
                                if base_detail.name == format!("App {id}") || base_detail.name.is_empty() {
                                    if let Some(n) = common.get("name").and_then(|v| v.as_str()) {
                                        base_detail.name = n.to_string();
                                    }
                                }
                            }
                            if let Some(ext) = entry.get("extended") {
                                if base_detail.developers.is_empty() {
                                    if let Some(dev) = ext.get("developer").and_then(|v| v.as_str()) {
                                        base_detail.developers = dev.split(',').map(|s| s.trim().to_string()).filter(|s| !s.is_empty()).collect();
                                    }
                                }
                                if base_detail.publishers.is_empty() {
                                    if let Some(publ) = ext.get("publisher").and_then(|v| v.as_str()) {
                                        base_detail.publishers = publ.split(',').map(|s| s.trim().to_string()).filter(|s| !s.is_empty()).collect();
                                    }
                                }
                                if base_detail.website.is_none() {
                                    base_detail.website = ext.get("homepage").and_then(|v| v.as_str()).map(|s| s.to_string());
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    // Ensure default screenshots exist if none were populated
    if base_detail.screenshots.is_empty() {
        base_detail.screenshots = vec![
            SteamScreenshotItem {
                id: 1,
                path_thumbnail: format!("https://shared.fastly.steamstatic.com/store_item_assets/steam/apps/{id}/header.jpg"),
                path_full: format!("https://shared.fastly.steamstatic.com/store_item_assets/steam/apps/{id}/header.jpg"),
            },
            SteamScreenshotItem {
                id: 2,
                path_thumbnail: format!("https://shared.fastly.steamstatic.com/store_item_assets/steam/apps/{id}/capsule_616x353.jpg"),
                path_full: format!("https://shared.fastly.steamstatic.com/store_item_assets/steam/apps/{id}/capsule_616x353.jpg"),
            },
            SteamScreenshotItem {
                id: 3,
                path_thumbnail: format!("https://cdn.akamai.steamstatic.com/steam/apps/{id}/page_bg_generated_v6b.jpg"),
                path_full: format!("https://cdn.akamai.steamstatic.com/steam/apps/{id}/page_bg_generated_v6b.jpg"),
            },
        ];
    }

    Ok(base_detail)
}

/// Detect host PC system specifications for game compatibility check.
#[tauri::command]
pub fn get_system_specs() -> Result<SystemSpecs, String> {
    #[cfg(windows)]
    {
        use winapi::um::sysinfoapi::{GlobalMemoryStatusEx, MEMORYSTATUSEX};
        use std::mem::zeroed;

        let ram_gb = unsafe {
            let mut mem_status: MEMORYSTATUSEX = zeroed();
            mem_status.dwLength = std::mem::size_of::<MEMORYSTATUSEX>() as u32;
            if GlobalMemoryStatusEx(&mut mem_status) != 0 {
                ((mem_status.ullTotalPhys as f64 / (1024.0 * 1024.0 * 1024.0)) * 10.0).round() as f32 / 10.0
            } else {
                16.0
            }
        };

        let mut cpu = std::env::var("PROCESSOR_IDENTIFIER").unwrap_or_else(|_| "x86_64 Processor".into());
        let mut gpu = "DirectX 12 Compatible Graphics".to_string();

        use std::os::windows::process::CommandExt;
        if let Ok(output) = std::process::Command::new("powershell")
            .args(["-NoProfile", "-Command", "Get-CimInstance Win32_Processor | Select-Object -ExpandProperty Name; Get-CimInstance Win32_VideoController | Select-Object -ExpandProperty Name"])
            .creation_flags(0x08000000)
            .output()
        {
            if output.status.success() {
                let text = String::from_utf8_lossy(&output.stdout);
                let lines: Vec<&str> = text.lines().map(|l| l.trim()).filter(|l| !l.is_empty()).collect();
                if let Some(first) = lines.first() {
                    cpu = first.to_string();
                }
                if lines.len() > 1 {
                    gpu = lines[1].to_string();
                }
            }
        }

        Ok(SystemSpecs {
            os: "Windows 10 / 11 (64-bit)".to_string(),
            cpu,
            ram_gb,
            gpu,
            directx: "DirectX 12".to_string(),
        })
    }
    #[cfg(not(windows))]
    {
        Ok(SystemSpecs {
            os: "Non-Windows OS".to_string(),
            cpu: "x86_64 Processor".to_string(),
            ram_gb: 16.0,
            gpu: "Vulkan / Metal GPU".to_string(),
            directx: "Vulkan".to_string(),
        })
    }
}

// ── Publisher / Similar Games ───────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PublisherGameItem {
    pub appid: u32,
    pub name: String,
    pub header_image: String,
}

/// Fetch other games by the same publisher using Steam search API.
#[tauri::command]
pub fn get_games_by_publisher(publisher: String, exclude_appid: u32) -> Vec<PublisherGameItem> {
    if publisher.trim().is_empty() {
        return Vec::new();
    }
    let client = build_client();
    let encoded = publisher.trim().replace(' ', "+");

    // Try akamai endpoint first (unblocked in Vietnam), then fallback
    let endpoints = [
        format!("https://store.akamai.steamstatic.com/search/results/?publisher={encoded}&json=1&count=12"),
        format!("https://store.steampowered.com/search/results/?publisher={encoded}&json=1&count=12"),
    ];

    for url in &endpoints {
        if let Ok(resp) = client
            .get(url)
            .header("Accept-Language", "en-US,en;q=0.9")
            .send()
        {
            if resp.status().is_success() {
                if let Ok(body) = resp.text() {
                    if let Ok(root) = serde_json::from_str::<Value>(&body) {
                        if let Some(items) = root.get("items").and_then(|v| v.as_array()) {
                            let results: Vec<PublisherGameItem> = items
                                .iter()
                                .filter_map(|item| {
                                    let appid = item.get("id")
                                        .or_else(|| item.get("appid"))
                                        .and_then(|v| v.as_u64())
                                        .map(|n| n as u32)?;
                                    if appid == exclude_appid || appid == 0 {
                                        return None;
                                    }
                                    let name = item.get("name")
                                        .and_then(|v| v.as_str())
                                        .unwrap_or("")
                                        .to_string();
                                    if name.is_empty() {
                                        return None;
                                    }
                                    let header_image = format!(
                                        "https://shared.fastly.steamstatic.com/store_item_assets/steam/apps/{appid}/header.jpg"
                                    );
                                    Some(PublisherGameItem { appid, name, header_image })
                                })
                                .take(8)
                                .collect();
                            if !results.is_empty() {
                                return results;
                            }
                        }
                    }
                }
            }
        }
    }
    Vec::new()
}

// ── Post-Download Scan ───────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExtraFileInfo {
    pub name: String,
    pub rel_path: String,
    pub size_kb: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PostDownloadScanResult {
    pub translations: Vec<ExtraFileInfo>,
    pub bypass_files: Vec<ExtraFileInfo>,
}

/// Scan a game folder for Vietnamese translation patches and bypass/fix files.
#[tauri::command]
pub fn scan_game_folder_for_extras(folder: String) -> PostDownloadScanResult {
    use std::fs;
    use std::path::Path;

    let mut translations = Vec::new();
    let mut bypass_files = Vec::new();

    let base = Path::new(&folder);
    if !base.exists() {
        return PostDownloadScanResult { translations, bypass_files };
    }

    let translation_patterns = [
        "viet", "vi_", "vietnam", "vietnamese", "bản việt", "viethoá",
        "translation", "patch", "localize", "locale",
    ];
    let bypass_patterns = [
        "crack", "bypass", "fix", "goldberg", "gse", "emu", "emulator",
        "unlock", "nodvd", "no_dvd", "no-dvd", "steamfix", "steam_fix",
        "skidrow", "codex", "repack", "setup",
    ];

    fn walk(dir: &std::path::Path, base: &std::path::Path, translations: &mut Vec<ExtraFileInfo>, bypass: &mut Vec<ExtraFileInfo>, t_pats: &[&str], b_pats: &[&str]) {
        let Ok(entries) = std::fs::read_dir(dir) else { return };
        for entry in entries.flatten() {
            let path = entry.path();
            let name_lower = path.file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("")
                .to_lowercase();
            if path.is_dir() {
                walk(&path, base, translations, bypass, t_pats, b_pats);
                continue;
            }
            let rel = path.strip_prefix(base).unwrap_or(&path).to_string_lossy().to_string();
            let size_kb = path.metadata().map(|m| m.len() / 1024).unwrap_or(0);
            let info = ExtraFileInfo { name: name_lower.clone(), rel_path: rel, size_kb };
            if t_pats.iter().any(|p| name_lower.contains(p)) {
                translations.push(info);
            } else if b_pats.iter().any(|p| name_lower.contains(p)) {
                bypass.push(info);
            }
        }
    }

    walk(base, base, &mut translations, &mut bypass_files, &translation_patterns, &bypass_patterns);

    PostDownloadScanResult { translations, bypass_files }
}
