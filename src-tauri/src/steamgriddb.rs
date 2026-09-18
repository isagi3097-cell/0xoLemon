use crate::secure_keys::with_steamgriddb_key;
use reqwest::blocking::Client;
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    io::Read,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use tauri::State;
use url::Url;

const BASE: &str = "https://www.steamgriddb.com/api/v2";
const TTL: Duration = Duration::from_secs(21600);
const LIMIT: usize = 256;

#[derive(Clone, Copy, Debug, Deserialize, Eq, Hash, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ArtworkType {
    Grid,
    Hero,
    Logo,
    Icon,
}
impl ArtworkType {
    fn path(self) -> &'static str {
        match self {
            Self::Grid => "grids",
            Self::Hero => "heroes",
            Self::Logo => "logos",
            Self::Icon => "icons",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Artwork {
    asset_type: ArtworkType,
    url: String,
    width: Option<u32>,
    height: Option<u32>,
}
#[derive(Deserialize)]
struct ApiResponse {
    success: bool,
    data: Vec<ApiArtwork>,
}
#[derive(Deserialize)]
struct ApiArtwork {
    url: String,
    width: Option<u32>,
    height: Option<u32>,
}
#[derive(Clone)]
struct Cached {
    at: Instant,
    value: Option<Artwork>,
}
#[derive(Clone)]
pub struct SteamGridDbState {
    client: Client,
    cache: Arc<Mutex<HashMap<(u32, ArtworkType), Cached>>>,
}
impl Default for SteamGridDbState {
    fn default() -> Self {
        Self {
            client: Client::builder()
                .connect_timeout(Duration::from_secs(4))
                .timeout(Duration::from_secs(8))
                .user_agent("007Launcher/SteamGridDB")
                .build()
                .expect("valid HTTP configuration"),
            cache: Default::default(),
        }
    }
}

fn endpoint(app_id: u32, kind: ArtworkType) -> String {
    format!("{BASE}/{}/steam/{app_id}", kind.path())
}
fn sanitize(value: &str) -> Option<String> {
    let url = Url::parse(value).ok()?;
    if url.scheme() != "https"
        || !url.username().is_empty()
        || url.password().is_some()
        || url.port().is_some()
    {
        return None;
    }
    match url.host_str()? {
        "cdn2.steamgriddb.com" | "cdn.steamgriddb.com" => Some(url.into()),
        _ => None,
    }
}
/// Resolve the embedded SteamGridDB API key for requests.
/// Key is decoded at runtime from obfuscated bytes embedded in the binary.
fn resolve_secret() -> Result<String, String> {
    let key = with_steamgriddb_key(|k| k.to_string());
    if key.is_empty() {
        return Err(
            "SteamGridDB credentials are not configured; local artwork fallback will be used"
                .to_string(),
        );
    }
    Ok(key)
}


fn status_error(status: reqwest::StatusCode) -> String {
    if status == reqwest::StatusCode::TOO_MANY_REQUESTS {
        "SteamGridDB is rate limited; local artwork fallback will be used"
    } else {
        "SteamGridDB lookup failed; local artwork fallback will be used"
    }
    .into()
}

impl SteamGridDbState {
    fn lookup(&self, app_id: u32, kind: ArtworkType) -> Result<Option<Artwork>, String> {
        if app_id == 0 {
            return Err("A valid Steam App ID is required".into());
        }
        let secret = resolve_secret()?;
        let mut cache = self
            .cache
            .lock()
            .map_err(|_| "Artwork cache is unavailable".to_string())?;
        cache.retain(|_, v| v.at.elapsed() < TTL);
        if let Some(v) = cache.get(&(app_id, kind)) {
            return Ok(v.value.clone());
        }
        let mut response = self
            .client
            .get(endpoint(app_id, kind))
            .bearer_auth(secret)
            .send()
            .map_err(|_| {
                "SteamGridDB is unavailable; local artwork fallback will be used".to_string()
            })?;
        if !response.status().is_success() {
            return Err(status_error(response.status()));
        }
        if response.content_length().is_some_and(|n| n > 1_048_576) {
            return Err(
                "SteamGridDB returned invalid data; local artwork fallback will be used".into(),
            );
        }
        let mut body = Vec::new();
        response
            .take(1_048_577)
            .read_to_end(&mut body)
            .map_err(|_| {
                "SteamGridDB returned invalid data; local artwork fallback will be used".to_string()
            })?;
        if body.len() > 1_048_576 {
            return Err(
                "SteamGridDB returned invalid data; local artwork fallback will be used".into(),
            );
        }
        let parsed: ApiResponse = serde_json::from_slice(&body).map_err(|_| {
            "SteamGridDB returned malformed data; local artwork fallback will be used".to_string()
        })?;
        if !parsed.success {
            return Err("SteamGridDB lookup failed; local artwork fallback will be used".into());
        }
        let value = parsed.data.into_iter().take(8).find_map(|v| {
            sanitize(&v.url).map(|url| Artwork {
                asset_type: kind,
                url,
                width: v.width,
                height: v.height,
            })
        });
        if cache.len() >= LIMIT {
            if let Some(k) = cache.iter().min_by_key(|(_, v)| v.at).map(|(k, _)| *k) {
                cache.remove(&k);
            }
        }
        cache.insert(
            (app_id, kind),
            Cached {
                at: Instant::now(),
                value: value.clone(),
            },
        );
        Ok(value)
    }
}

#[tauri::command]
pub async fn lookup_steamgriddb_artwork(
    state: State<'_, SteamGridDbState>,
    app_id: u32,
    asset_type: ArtworkType,
) -> Result<Option<Artwork>, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || state.lookup(app_id, asset_type))
        .await
        .map_err(|_| "Artwork lookup was interrupted; local fallback will be used".to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn endpoints() {
        assert_eq!(
            endpoint(1, ArtworkType::Grid),
            "https://www.steamgriddb.com/api/v2/grids/steam/1"
        );
        assert_eq!(
            endpoint(1, ArtworkType::Hero),
            "https://www.steamgriddb.com/api/v2/heroes/steam/1"
        );
        assert_eq!(
            endpoint(1, ArtworkType::Logo),
            "https://www.steamgriddb.com/api/v2/logos/steam/1"
        );
        assert_eq!(
            endpoint(1, ArtworkType::Icon),
            "https://www.steamgriddb.com/api/v2/icons/steam/1"
        );
    }
    #[test]
    fn url_policy() {
        assert!(sanitize("https://cdn2.steamgriddb.com/grid/a.png").is_some());
        assert!(sanitize("http://cdn2.steamgriddb.com/a").is_none());
        assert!(sanitize("https://example.com/a").is_none());
        assert!(sanitize("https://cdn2.steamgriddb.com.evil.test/a").is_none());
    }
    #[test]
    fn response_parse() {
        let p: ApiResponse = serde_json::from_str(
            r#"{"success":true,"data":[{"url":"https://cdn2.steamgriddb.com/a.png"}]}"#,
        )
        .unwrap();
        assert!(p.success);
    }
    #[test]
    fn safe_errors() {
        for s in [
            reqwest::StatusCode::UNAUTHORIZED,
            reqwest::StatusCode::TOO_MANY_REQUESTS,
        ] {
            let e = status_error(s).to_lowercase();
            assert!(!e.contains("authorization"));
            assert!(!e.contains("bearer"));
        }
    }
}
