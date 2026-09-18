use super::native::NativeBridge;
use super::store::{regular_boundary, LuaCacheHealth, Store};
use base64::Engine;
use reqwest::blocking::Client;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, HashMap},
    fs,
    io::Read,
    path::{Component, Path, PathBuf},
    sync::{Arc, Condvar, Mutex},
    time::{Duration, Instant},
};

const BODY_LIMIT: u64 = 2 * 1024 * 1024;
const MAX_INFLIGHT: usize = 128;
const MAX_CONCURRENT: usize = 4;

pub(super) fn sha256(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}
fn now() -> i64 {
    chrono::Utc::now().timestamp()
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum Freshness {
    Unknown,
    Fresh,
    Stale,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum Provider {
    SteamStore,
    SteamCmd,
    SteamKit,
    SteamGlobalStats,
    ScopedGseSchema,
}
impl Provider {
    pub fn id(self) -> &'static str {
        match self {
            Self::SteamStore => "steamStore",
            Self::SteamCmd => "steamCmd",
            Self::SteamKit => "steamKit",
            Self::SteamGlobalStats => "steamGlobalStats",
            Self::ScopedGseSchema => "scopedGseSchema",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceObservation {
    pub provider: String,
    pub revision: String,
    pub observed_at: Option<i64>,
    pub expires_at: Option<i64>,
    pub freshness: Freshness,
    pub error_code: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Depot {
    pub depot_id: String,
    pub name: Option<String>,
    pub manifests: BTreeMap<String, String>,
}
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Branch {
    pub name: String,
    pub build_id: Option<String>,
    pub updated_at: Option<i64>,
}
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LaunchOption {
    pub executable: String,
    pub arguments: Option<String>,
    pub os_list: Option<String>,
    pub description: Option<String>,
}
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveRoot {
    pub root: String,
    pub path: String,
    pub pattern: Option<String>,
}
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Achievement {
    pub id: String,
    pub name: Option<String>,
    pub description: Option<String>,
    pub icon_url: Option<String>,
    pub hidden: bool,
    pub maximum: Option<f64>,
    pub global_percent: Option<f64>,
    pub source: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LuaMetadata {
    pub app_id: u32,
    pub name: String,
    pub header_image: Option<String>,
    pub short_description: Option<String>,
    pub app_type: Option<String>,
    pub developers: Vec<String>,
    pub publishers: Vec<String>,
    pub dlc_app_ids: Vec<u32>,
    pub parent_app_id: Option<u32>,
    pub depots: Vec<Depot>,
    pub branches: Vec<Branch>,
    pub launch_options: Vec<LaunchOption>,
    pub save_roots: Vec<SaveRoot>,
    pub achievements: Vec<Achievement>,
}

impl LuaMetadata {
    pub(super) fn covers(&self, old: &Self) -> bool {
        (!self.name.is_empty() || old.name.is_empty())
            && (self.header_image.is_some() || old.header_image.is_none())
            && (self.short_description.is_some() || old.short_description.is_none())
            && (self.app_type.is_some() || old.app_type.is_none())
            && (self.parent_app_id.is_some() || old.parent_app_id.is_none())
            && old.developers.iter().all(|v| self.developers.contains(v))
            && old.publishers.iter().all(|v| self.publishers.contains(v))
            && old.dlc_app_ids.iter().all(|v| self.dlc_app_ids.contains(v))
            && old.depots.iter().all(|v| {
                self.depots.iter().any(|n| {
                    n.depot_id == v.depot_id
                        && v.manifests.keys().all(|k| n.manifests.contains_key(k))
                })
            })
            && old.branches.iter().all(|v| {
                self.branches
                    .iter()
                    .any(|n| n.name == v.name && (n.build_id.is_some() || v.build_id.is_none()))
            })
            && old.launch_options.iter().all(|v| {
                self.launch_options
                    .iter()
                    .any(|n| n.executable == v.executable)
            })
            && old.save_roots.iter().all(|v| {
                self.save_roots
                    .iter()
                    .any(|n| n.root == v.root && n.path == v.path)
            })
            && old.achievements.iter().all(|v| {
                self.achievements.iter().any(|n| {
                    n.id == v.id
                        && (n.name.is_some() || v.name.is_none())
                        && (n.description.is_some() || v.description.is_none())
                        && (n.icon_url.is_some() || v.icon_url.is_none())
                })
            })
    }

    /// Prefer newly observed fields while keeping useful detail missing in a partial response.
    pub(super) fn preserve_quality(&self, newer: &Self) -> Self {
        let mut out = newer.clone();
        if out.name.is_empty() {
            out.name = self.name.clone();
        }
        if out.header_image.is_none() {
            out.header_image = self.header_image.clone();
        }
        if out.short_description.is_none() {
            out.short_description = self.short_description.clone();
        }
        if out.app_type.is_none() {
            out.app_type = self.app_type.clone();
        }
        if out.parent_app_id.is_none() {
            out.parent_app_id = self.parent_app_id;
        }
        for v in &self.developers {
            if !out.developers.contains(v) {
                out.developers.push(v.clone());
            }
        }
        for v in &self.publishers {
            if !out.publishers.contains(v) {
                out.publishers.push(v.clone());
            }
        }
        for v in &self.dlc_app_ids {
            if !out.dlc_app_ids.contains(v) {
                out.dlc_app_ids.push(*v);
            }
        }
        for v in &self.depots {
            if let Some(n) = out.depots.iter_mut().find(|n| n.depot_id == v.depot_id) {
                if n.name.is_none() {
                    n.name = v.name.clone();
                }
                for (k, value) in &v.manifests {
                    n.manifests
                        .entry(k.clone())
                        .or_insert_with(|| value.clone());
                }
            } else {
                out.depots.push(v.clone());
            }
        }
        for v in &self.branches {
            if !out.branches.iter().any(|n| n.name == v.name) {
                out.branches.push(v.clone());
            }
        }
        for v in &self.launch_options {
            if !out
                .launch_options
                .iter()
                .any(|n| n.executable == v.executable)
            {
                out.launch_options.push(v.clone());
            }
        }
        for v in &self.save_roots {
            if !out
                .save_roots
                .iter()
                .any(|n| n.root == v.root && n.path == v.path)
            {
                out.save_roots.push(v.clone());
            }
        }
        for v in &self.achievements {
            if let Some(n) = out.achievements.iter_mut().find(|n| n.id == v.id) {
                if n.name.is_none() {
                    n.name = v.name.clone();
                }
                if n.description.is_none() {
                    n.description = v.description.clone();
                }
                if n.icon_url.is_none() {
                    n.icon_url = v.icon_url.clone();
                }
                if n.maximum.is_none() {
                    n.maximum = v.maximum;
                }
                if n.global_percent.is_none() {
                    n.global_percent = v.global_percent;
                }
                // Anonymous percentages cannot downgrade locally scoped schema identity.
                if v.source == "scopedGseSchema" && n.source != "scopedGseSchema" {
                    n.source = v.source.clone();
                    n.hidden = v.hidden;
                }
            } else {
                out.achievements.push(v.clone());
            }
        }
        out.depots.truncate(512);
        out.branches.truncate(128);
        out.launch_options.truncate(128);
        out.save_roots.truncate(128);
        out.achievements.truncate(5000);
        out
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LuaMetadataResult {
    pub app_id: u32,
    pub locale: String,
    pub data: Option<LuaMetadata>,
    pub freshness: Freshness,
    pub observed_at: Option<i64>,
    pub expires_at: Option<i64>,
    pub source_observations: Vec<SourceObservation>,
    pub winner_provider: Option<String>,
    pub native_steam_kit_available: bool,
    pub error_codes: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LuaImageBlob {
    pub data_url: String,
    pub sha256: String,
    pub mime: String,
    pub size: usize,
    pub from_cache: bool,
    pub source_url: String,
    pub revision: String,
}

type FlightResult<T> = Result<T, String>;
struct Flight<T> {
    value: Mutex<Option<FlightResult<T>>>,
    ready: Condvar,
}
struct SingleFlight<T> {
    entries: Mutex<HashMap<String, Arc<Flight<T>>>>,
}
impl<T: Clone> SingleFlight<T> {
    fn new() -> Self {
        Self {
            entries: Mutex::new(HashMap::new()),
        }
    }
    fn run(&self, key: String, work: impl FnOnce() -> FlightResult<T>) -> FlightResult<T> {
        let (flight, owner) = {
            let mut entries = self.entries.lock().map_err(|_| "LUA_REQUEST_LOCK")?;
            if let Some(f) = entries.get(&key) {
                (f.clone(), false)
            } else {
                if entries.len() >= MAX_INFLIGHT {
                    return Err("LUA_REQUEST_QUEUE_FULL".into());
                }
                let flight = Arc::new(Flight {
                    value: Mutex::new(None),
                    ready: Condvar::new(),
                });
                entries.insert(key.clone(), flight.clone());
                (flight, true)
            }
        };
        if owner {
            let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(work))
                .unwrap_or_else(|_| Err("LUA_PROVIDER_PANIC".into()));
            *flight.value.lock().map_err(|_| "LUA_REQUEST_LOCK")? = Some(result.clone());
            flight.ready.notify_all();
            self.entries
                .lock()
                .map_err(|_| "LUA_REQUEST_LOCK")?
                .remove(&key);
            result
        } else {
            let deadline = Instant::now() + Duration::from_secs(55);
            let mut value = flight.value.lock().map_err(|_| "LUA_REQUEST_LOCK")?;
            while value.is_none() {
                let left = deadline.saturating_duration_since(Instant::now());
                if left.is_zero() {
                    return Err("LUA_REQUEST_WAIT_TIMEOUT".into());
                }
                value = flight
                    .ready
                    .wait_timeout(value, left)
                    .map_err(|_| "LUA_REQUEST_LOCK")?
                    .0;
            }
            value
                .clone()
                .ok_or_else(|| String::from("LUA_REQUEST_MISSING"))?
        }
    }
}

struct Limiter {
    active: Mutex<usize>,
    ready: Condvar,
}
struct Permit<'a>(&'a Limiter);
impl Drop for Permit<'_> {
    fn drop(&mut self) {
        if let Ok(mut active) = self.0.active.lock() {
            *active = active.saturating_sub(1);
            self.0.ready.notify_one();
        }
    }
}
impl Limiter {
    fn acquire(&self) -> Result<Permit<'_>, String> {
        let mut active = self.active.lock().map_err(|_| "LUA_REQUEST_LOCK")?;
        let deadline = Instant::now() + Duration::from_secs(10);
        while *active >= MAX_CONCURRENT {
            let left = deadline.saturating_duration_since(Instant::now());
            if left.is_zero() {
                return Err("LUA_PROVIDER_BUSY".into());
            }
            active = self
                .ready
                .wait_timeout(active, left)
                .map_err(|_| "LUA_REQUEST_LOCK")?
                .0;
        }
        *active += 1;
        Ok(Permit(self))
    }
}

pub(super) struct MetadataService {
    root: PathBuf,
    store: Store,
    client: Client,
    flights: SingleFlight<LuaMetadataResult>,
    source_flights: SingleFlight<()>,
    image_flights: SingleFlight<LuaImageBlob>,
    limiter: Limiter,
    native: Option<NativeBridge>,
    #[cfg(test)]
    requests: std::sync::atomic::AtomicUsize,
}

impl MetadataService {
    pub fn root(&self) -> &Path {
        &self.root
    }
    pub fn open(root: PathBuf) -> Result<Self, String> {
        let store = Store::open(&root)?;
        let client = Client::builder()
            .timeout(Duration::from_secs(10))
            .connect_timeout(Duration::from_secs(4))
            .redirect(reqwest::redirect::Policy::none())
            .user_agent("0xoLemon-LuaMetadata/1")
            .build()
            .map_err(|_| "LUA_HTTP_CLIENT")?;
        Ok(Self {
            root,
            store,
            client,
            flights: SingleFlight::new(),
            source_flights: SingleFlight::new(),
            image_flights: SingleFlight::new(),
            native: None,
            limiter: Limiter {
                active: Mutex::new(0),
                ready: Condvar::new(),
            },
            #[cfg(test)]
            requests: std::sync::atomic::AtomicUsize::new(0),
        })
    }
    pub fn health(&self) -> Result<LuaCacheHealth, String> {
        let mut health = self.store.health()?;
        health.native_steam_kit_available =
            self.native.as_ref().is_some_and(NativeBridge::available);
        Ok(health)
    }
    pub fn with_native(mut self, bridge: NativeBridge) -> Self {
        self.native = Some(bridge);
        self
    }

    pub fn get(
        &self,
        appid: u32,
        locale: &str,
        refresh: bool,
        basic: bool,
    ) -> Result<LuaMetadataResult, String> {
        let locale = validate_input(appid, locale)?;
        self.flights
            .run(format!("{appid}:{locale}:{basic}:{refresh}"), || {
                self.load(appid, &locale, refresh, basic)
            })
    }

    fn load(
        &self,
        appid: u32,
        locale: &str,
        refresh: bool,
        basic: bool,
    ) -> Result<LuaMetadataResult, String> {
        let mut providers = if basic {
            vec![Provider::SteamStore]
        } else {
            vec![
                Provider::SteamStore,
                Provider::SteamCmd,
                Provider::SteamGlobalStats,
                Provider::ScopedGseSchema,
            ]
        };
        if !basic && self.native.is_some() {
            providers.insert(0, Provider::SteamKit);
        }
        let clock = now();
        let previous_winner = if basic {
            None
        } else {
            self.store.winner(appid, locale, clock)?
        };
        if let Some(winner) = previous_winner {
            if let Some(index) = providers.iter().position(|p| *p == winner) {
                providers.swap(0, index);
            }
        }
        let mut rows = Vec::new();
        // Independent read-only sources may run together. All network/native
        // work still shares the four-permit limit and per-source single-flight.
        let mut errors: Vec<String> = std::thread::scope(|scope| {
            providers
                .iter()
                .map(|provider| {
                    scope.spawn(move || {
                        self.refresh_source(appid, locale, *provider, refresh, clock)
                    })
                })
                .collect::<Vec<_>>()
                .into_iter()
                .filter_map(|handle| {
                    handle
                        .join()
                        .unwrap_or_else(|_| Err("LUA_PROVIDER_PANIC".into()))
                        .err()
                })
                .collect()
        });
        let mut winner = None;
        for provider in providers {
            if let Some(row) = self.store.get(appid, locale, provider, clock)? {
                if winner.is_none()
                    && matches!(
                        provider,
                        Provider::SteamStore | Provider::SteamCmd | Provider::SteamKit
                    )
                    && row.data.as_ref().is_some_and(|d| !d.name.is_empty())
                    && row.observation.freshness == Freshness::Fresh
                {
                    winner = Some(provider);
                }
                rows.push(row);
            }
        }
        if let Some(provider) = winner.filter(|p| !basic && Some(*p) != previous_winner) {
            self.store.set_winner(appid, locale, provider, clock)?;
        }
        // Store descriptions remain preferred; technical SteamCMD fields and local schema are additive.
        rows.sort_by_key(|r| match r.observation.provider.as_str() {
            "steamGlobalStats" => 0,
            "steamCmd" => 1,
            "steamKit" => 2,
            "steamStore" => 3,
            _ => 4,
        });
        let mut data: Option<LuaMetadata> = None;
        for row in &rows {
            if let Some(next) = &row.data {
                data = Some(
                    data.as_ref()
                        .map(|old| old.preserve_quality(next))
                        .unwrap_or_else(|| next.clone()),
                );
            }
        }
        if data
            .as_ref()
            .is_some_and(|d| d.name.is_empty() && d.achievements.is_empty() && d.depots.is_empty())
        {
            data = None;
        }
        let observations: Vec<_> = rows.into_iter().map(|r| r.observation).collect();
        for observation in &observations {
            if let Some(error) = &observation.error_code {
                errors.push(format!("{}:{error}", observation.provider));
            }
        }
        let with_data: Vec<_> = observations
            .iter()
            .filter(|o| o.freshness != Freshness::Unknown)
            .collect();
        let freshness = if data.is_none() {
            Freshness::Unknown
        } else if with_data.iter().any(|o| o.freshness == Freshness::Stale) {
            Freshness::Stale
        } else {
            Freshness::Fresh
        };
        let native_steam_kit_available = observations.iter().any(|observation| {
            observation.provider == "steamKit"
                && observation.freshness == Freshness::Fresh
                && observation.error_code.is_none()
        });
        Ok(LuaMetadataResult {
            app_id: appid,
            locale: locale.into(),
            data,
            freshness,
            observed_at: with_data.iter().filter_map(|o| o.observed_at).min(),
            expires_at: with_data.iter().filter_map(|o| o.expires_at).min(),
            source_observations: observations,
            winner_provider: winner.map(|p| p.id().into()),
            native_steam_kit_available,
            error_codes: errors,
        })
    }

    fn refresh_source(
        &self,
        appid: u32,
        locale: &str,
        provider: Provider,
        refresh: bool,
        clock: i64,
    ) -> Result<(), String> {
        let old = self.store.get(appid, locale, provider, clock)?;
        let fetch = refresh
            || old
                .as_ref()
                .map(|row| {
                    row.observation.freshness != Freshness::Fresh && row.retry_after <= clock
                })
                .unwrap_or(true);
        if !fetch {
            return Ok(());
        }
        self.source_flights
            .run(format!("{appid}:{locale}:{}", provider.id()), || {
                let fetched = if provider == Provider::ScopedGseSchema {
                    scoped_schema(appid, locale)
                } else {
                    match self.limiter.acquire() {
                        Ok(_permit) => self.fetch(appid, locale, provider),
                        Err(error) => Err(error),
                    }
                };
                match fetched {
                    Ok(data) => self.store.save(appid, locale, provider, &data, now()),
                    Err(error) => self.store.failure(appid, locale, provider, &error, now()),
                }
            })
    }

    fn fetch(&self, appid: u32, locale: &str, provider: Provider) -> Result<LuaMetadata, String> {
        if provider == Provider::SteamKit {
            let info = self
                .native
                .as_ref()
                .ok_or("LUA_STEAMKIT_COMPONENT_MISSING")?
                .app_info(appid)?;
            return normalize_cmd(appid, &serde_json::json!({"data":{appid.to_string():info}}));
        }
        let url=match provider {
            Provider::SteamStore=>format!("https://store.steampowered.com/api/appdetails?appids={appid}&l={locale}&cc=us"),
            Provider::SteamCmd=>format!("https://api.steamcmd.net/v1/info/{appid}"),
            Provider::SteamGlobalStats=>format!("https://api.steampowered.com/ISteamUserStats/GetGlobalAchievementPercentagesForApp/v2/?gameid={appid}"),
            Provider::ScopedGseSchema=>return Err("INVALID_NETWORK_PROVIDER".into()),
            Provider::SteamKit=>return Err("INVALID_NETWORK_PROVIDER".into()),
        };
        let bytes = self.get_bytes(&url, BODY_LIMIT)?;
        let value: Value = serde_json::from_slice(&bytes).map_err(|_| "PROVIDER_INVALID_JSON")?;
        match provider {
            Provider::SteamStore => normalize_store(appid, &value),
            Provider::SteamCmd => normalize_cmd(appid, &value),
            Provider::SteamGlobalStats => normalize_global(appid, &value),
            _ => Err("INVALID_NETWORK_PROVIDER".into()),
        }
    }

    fn get_bytes(&self, url: &str, limit: u64) -> Result<Vec<u8>, String> {
        #[cfg(test)]
        self.requests
            .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        let response = self.client.get(url).send().map_err(|e| {
            if e.is_timeout() {
                "HTTP_TIMEOUT"
            } else {
                "HTTP_CONNECT"
            }
        })?;
        if !response.status().is_success() {
            return Err(match response.status().as_u16() {
                401 | 403 => "HTTP_FORBIDDEN",
                404 => "HTTP_NOT_FOUND",
                429 => "HTTP_RATE_LIMITED",
                _ => "HTTP_UPSTREAM_ERROR",
            }
            .into());
        }
        if response.content_length().is_some_and(|len| len > limit) {
            return Err("HTTP_BODY_TOO_LARGE".into());
        }
        let mut bytes = Vec::new();
        response
            .take(limit + 1)
            .read_to_end(&mut bytes)
            .map_err(|_| "HTTP_READ")?;
        if bytes.len() as u64 > limit {
            return Err("HTTP_BODY_TOO_LARGE".into());
        }
        Ok(bytes)
    }

    pub fn image(&self, source: &str) -> Result<LuaImageBlob, String> {
        let url = allowed_image_url(source).ok_or("LUA_IMAGE_URL_NOT_ALLOWED")?;
        self.image_flights.run(url.clone(), || {
            if let Some(cached) = self.store.image(&url, now())? {
                if validate_image(&cached.bytes).ok().as_deref() == Some(cached.mime.as_str()) {
                    return Ok(image_blob(
                        url.clone(),
                        cached.bytes,
                        cached.mime,
                        cached.hash,
                        true,
                    ));
                }
            }
            let _permit = self.limiter.acquire()?;
            let bytes = self.get_bytes(&url, 4 * 1024 * 1024)?;
            let mime = validate_image(&bytes)?;
            let hash = self.store.save_image(&url, &bytes, &mime, now())?;
            Ok(image_blob(url.clone(), bytes, mime, hash, false))
        })
    }
}

fn image_blob(
    source_url: String,
    bytes: Vec<u8>,
    mime: String,
    hash: String,
    from_cache: bool,
) -> LuaImageBlob {
    LuaImageBlob {
        data_url: format!(
            "data:{mime};base64,{}",
            base64::engine::general_purpose::STANDARD.encode(&bytes)
        ),
        sha256: hash.clone(),
        revision: hash,
        mime,
        size: bytes.len(),
        source_url,
        from_cache,
    }
}

fn validate_image(bytes: &[u8]) -> Result<String, String> {
    let format = image::guess_format(bytes).map_err(|_| "LUA_IMAGE_FORMAT")?;
    let mime = match format {
        image::ImageFormat::Png => "image/png",
        image::ImageFormat::Jpeg => "image/jpeg",
        image::ImageFormat::WebP => "image/webp",
        _ => return Err("LUA_IMAGE_FORMAT".into()),
    };
    let (width, height) = image::ImageReader::with_format(std::io::Cursor::new(bytes), format)
        .into_dimensions()
        .map_err(|_| "LUA_IMAGE_INVALID")?;
    if width == 0
        || height == 0
        || width > 8192
        || height > 8192
        || u64::from(width) * u64::from(height) > 32_000_000
    {
        return Err("LUA_IMAGE_DIMENSIONS".into());
    }
    Ok(mime.into())
}

pub(super) fn allowed_image_url(input: &str) -> Option<String> {
    if input.len() > 2048 {
        return None;
    }
    let url = url::Url::parse(input).ok()?;
    if url.scheme() != "https"
        || !url.username().is_empty()
        || url.password().is_some()
        || url.port().is_some()
        || url.fragment().is_some()
    {
        return None;
    }
    // Steam uses a numeric `t` revision on artwork. No arbitrary query payload is accepted.
    if url.query().is_some() {
        let pairs: Vec<_> = url.query_pairs().collect();
        if pairs.len() != 1
            || pairs[0].0 != "t"
            || pairs[0].1.is_empty()
            || pairs[0].1.len() > 20
            || !pairs[0].1.bytes().all(|b| b.is_ascii_digit())
        {
            return None;
        }
    }
    if !matches!(
        url.host_str()?,
        "shared.akamai.steamstatic.com"
            | "shared.fastly.steamstatic.com"
            | "shared.cloudflare.steamstatic.com"
            | "cdn.akamai.steamstatic.com"
            | "cdn.cloudflare.steamstatic.com"
            | "cdn.fastly.steamstatic.com"
            | "steamcdn-a.akamaihd.net"
            | "cdn.steamstatic.com"
            | "images.steamusercontent.com"
            | "avatars.steamstatic.com"
            | "avatars.akamai.steamstatic.com"
    ) {
        return None;
    }
    Some(url.to_string())
}

fn validate_input(appid: u32, locale: &str) -> Result<String, String> {
    if appid == 0 {
        return Err("LUA_INVALID_APPID".into());
    }
    let locale = locale.trim().to_ascii_lowercase();
    let locale = match locale.as_str() {
        "en" | "en-us" => "english",
        "vi" | "vi-vn" => "vietnamese",
        "de" | "de-de" => "german",
        "fr" | "fr-fr" => "french",
        "ja" | "ja-jp" => "japanese",
        "ko" | "ko-kr" => "koreana",
        "zh-cn" => "schinese",
        "zh-tw" => "tchinese",
        other => other,
    };
    if !matches!(
        locale,
        "english"
            | "vietnamese"
            | "german"
            | "french"
            | "japanese"
            | "koreana"
            | "schinese"
            | "tchinese"
            | "spanish"
            | "latam"
            | "russian"
            | "portuguese"
            | "brazilian"
            | "italian"
            | "polish"
            | "turkish"
            | "thai"
            | "ukrainian"
            | "czech"
            | "danish"
            | "dutch"
            | "finnish"
            | "greek"
            | "hungarian"
            | "indonesian"
            | "norwegian"
            | "romanian"
            | "swedish"
            | "bulgarian"
            | "arabic"
    ) {
        return Err("LUA_INVALID_LOCALE".into());
    }
    Ok(locale.into())
}

fn string(v: &Value) -> Option<String> {
    let s = v.as_str()?.trim();
    if s.is_empty() {
        return None;
    }
    Some(
        s.chars()
            .filter(|c| !c.is_control() || *c == '\n' || *c == '\t')
            .take(4096)
            .collect(),
    )
}
fn field(v: &Value, key: &str) -> Option<String> {
    string(&v[key])
}
fn number(v: &Value) -> Option<u64> {
    v.as_u64().or_else(|| v.as_str()?.parse().ok())
}
fn real(v: &Value) -> Option<f64> {
    let n = v.as_f64().or_else(|| v.as_str()?.parse().ok())?;
    n.is_finite().then_some(n)
}
fn strings(v: &Value) -> Vec<String> {
    v.as_array()
        .map(|a| a.iter().take(128).filter_map(string).collect())
        .unwrap_or_default()
}
fn values(v: &Value) -> Vec<&Value> {
    match v {
        Value::Array(a) => a.iter().take(512).collect(),
        Value::Object(o) => o.values().take(512).collect(),
        _ => vec![],
    }
}

fn normalize_store(appid: u32, value: &Value) -> Result<LuaMetadata, String> {
    let entry = &value[appid.to_string()];
    if entry["success"].as_bool() != Some(true) {
        return Err("STORE_APP_UNAVAILABLE".into());
    }
    let data = &entry["data"];
    if number(&data["steam_appid"]).is_some_and(|id| id != u64::from(appid)) {
        return Err("PROVIDER_APPID_MISMATCH".into());
    }
    let name = field(data, "name").ok_or("STORE_NAME_MISSING")?;
    Ok(LuaMetadata {
        app_id: appid,
        name,
        header_image: field(data, "header_image").and_then(|u| allowed_image_url(&u)),
        short_description: field(data, "short_description"),
        app_type: field(data, "type"),
        developers: strings(&data["developers"]),
        publishers: strings(&data["publishers"]),
        dlc_app_ids: values(&data["dlc"])
            .into_iter()
            .filter_map(|v| u32::try_from(number(v)?).ok())
            .filter(|id| *id > 0)
            .take(1000)
            .collect(),
        parent_app_id: number(&data["fullgame"]["appid"]).and_then(|v| u32::try_from(v).ok()),
        ..Default::default()
    })
}

fn normalize_cmd(appid: u32, value: &Value) -> Result<LuaMetadata, String> {
    let data = &value["data"][appid.to_string()];
    if !data.is_object() {
        return Err("STEAMCMD_APP_UNAVAILABLE".into());
    }
    if number(&data["appid"]).is_some_and(|id| id != u64::from(appid)) {
        return Err("PROVIDER_APPID_MISMATCH".into());
    }
    let mut out = LuaMetadata {
        app_id: appid,
        name: field(&data["common"], "name").ok_or("STEAMCMD_NAME_MISSING")?,
        app_type: field(&data["common"], "type"),
        parent_app_id: number(&data["common"]["parent"]).and_then(|n| u32::try_from(n).ok()),
        ..Default::default()
    };
    if let Some(dlc) = field(&data["extended"], "listofdlc") {
        out.dlc_app_ids = dlc
            .split(',')
            .filter_map(|v| v.trim().parse::<u32>().ok())
            .filter(|n| *n > 0)
            .take(1000)
            .collect();
    }
    for association in values(&data["common"]["associations"]) {
        if let Some(name) = field(association, "name") {
            match association["type"].as_str() {
                Some("developer") => out.developers.push(name),
                Some("publisher") => out.publishers.push(name),
                _ => (),
            }
        }
    }
    if let Some(depots) = data["depots"].as_object() {
        for (id, depot) in depots
            .iter()
            .filter(|(id, _)| id.parse::<u32>().is_ok())
            .take(512)
        {
            let mut manifests = BTreeMap::new();
            if let Some(branches) = depot["manifests"].as_object() {
                for (branch, manifest) in branches.iter().take(128) {
                    if let Some(gid) = number(&manifest["gid"]).or_else(|| number(manifest)) {
                        manifests.insert(branch.chars().take(128).collect(), gid.to_string());
                    }
                }
            }
            out.depots.push(Depot {
                depot_id: id.clone(),
                name: field(depot, "name"),
                manifests,
            });
        }
        if let Some(branches) = data["depots"]["branches"].as_object() {
            for (name, branch) in branches.iter().take(128) {
                out.branches.push(Branch {
                    name: name.chars().take(128).collect(),
                    build_id: number(&branch["buildid"]).map(|v| v.to_string()),
                    updated_at: number(&branch["timeupdated"]).and_then(|n| i64::try_from(n).ok()),
                });
            }
        }
    }
    for launch in values(&data["config"]["launch"]).into_iter().take(128) {
        if let Some(executable) = field(launch, "executable") {
            out.launch_options.push(LaunchOption {
                executable,
                arguments: field(launch, "arguments"),
                os_list: field(&launch["config"], "oslist"),
                description: field(launch, "description"),
            });
        }
    }
    for save in values(&data["ufs"]["savefiles"]).into_iter().take(128) {
        if let (Some(root), Some(path)) = (field(save, "root"), field(save, "path")) {
            out.save_roots.push(SaveRoot {
                root,
                path,
                pattern: field(save, "pattern"),
            });
        }
    }
    Ok(out)
}

fn normalize_global(appid: u32, value: &Value) -> Result<LuaMetadata, String> {
    let array = value["achievementpercentages"]["achievements"]
        .as_array()
        .ok_or("GLOBAL_STATS_UNAVAILABLE")?;
    let mut out = LuaMetadata {
        app_id: appid,
        ..Default::default()
    };
    for achievement in array.iter().take(5000) {
        if let (Some(id), Some(percent)) =
            (field(achievement, "name"), real(&achievement["percent"]))
        {
            if (0.0..=100.0).contains(&percent) {
                out.achievements.push(Achievement {
                    id,
                    global_percent: Some(percent),
                    source: "steamGlobalStats".into(),
                    ..Default::default()
                });
            }
        }
    }
    Ok(out)
}

fn bounded_read(path: &Path, limit: u64) -> Result<Vec<u8>, String> {
    regular_boundary(path)?;
    let file = fs::File::open(path).map_err(|_| "SCOPED_SCHEMA_UNAVAILABLE")?;
    let metadata = file.metadata().map_err(|_| "SCOPED_SCHEMA_UNAVAILABLE")?;
    if !metadata.is_file() || metadata.len() > limit {
        return Err("SCOPED_SCHEMA_SIZE".into());
    }
    let mut bytes = Vec::new();
    file.take(limit + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "SCOPED_SCHEMA_READ")?;
    if bytes.len() as u64 > limit {
        return Err("SCOPED_SCHEMA_SIZE".into());
    }
    Ok(bytes)
}

fn quoted_values(text: &str, key: &str) -> Vec<String> {
    // Only fixed VDF scalar keys are inspected; no evaluation or includes are supported.
    let pattern = format!(r#"(?i)"{}"\s+"((?:\\.|[^"\\])*)""#, regex::escape(key));
    regex::Regex::new(&pattern)
        .map(|r| {
            r.captures_iter(text)
                .take(64)
                .filter_map(|c| c.get(1).map(|s| s.as_str().replace("\\\\", "\\")))
                .collect()
        })
        .unwrap_or_default()
}

fn scoped_schema(appid: u32, locale: &str) -> Result<LuaMetadata, String> {
    let steam = crate::steam_integration::find_steam_root().ok_or("SCOPED_SCHEMA_UNAVAILABLE")?;
    // Local reads are restricted to the requested Lua-managed game, never every installed game.
    let lua = steam
        .join("config")
        .join("stplug-in")
        .join(format!("{appid}.lua"));
    regular_boundary(&lua)?;
    if !lua.is_file() {
        return Err("SCOPED_SCHEMA_NOT_LUA_GAME".into());
    }
    let mut roots = vec![steam.clone()];
    if let Ok(bytes) = bounded_read(&steam.join("steamapps/libraryfolders.vdf"), 1024 * 1024) {
        for path in quoted_values(&String::from_utf8_lossy(&bytes), "path") {
            let p = PathBuf::from(path);
            if p.is_absolute() && !roots.contains(&p) {
                roots.push(p);
            }
        }
    }
    for root in roots.into_iter().take(32) {
        let manifest = root
            .join("steamapps")
            .join(format!("appmanifest_{appid}.acf"));
        let Ok(bytes) = bounded_read(&manifest, 1024 * 1024) else {
            continue;
        };
        let manifest = String::from_utf8_lossy(&bytes);
        if quoted_values(&manifest, "appid")
            .first()
            .and_then(|s| s.parse::<u32>().ok())
            != Some(appid)
        {
            continue;
        }
        let Some(install) = quoted_values(&manifest, "installdir").into_iter().next() else {
            continue;
        };
        let path = Path::new(&install);
        if path.components().count() != 1
            || !matches!(path.components().next(), Some(Component::Normal(_)))
            || install.contains([':', '/', '\\'])
            || install.ends_with([' ', '.'])
        {
            continue;
        }
        let settings = root
            .join("steamapps/common")
            .join(install)
            .join("steam_settings");
        let Ok(bytes) = bounded_read(&settings.join("achievements.json"), BODY_LIMIT) else {
            continue;
        };
        let value: Value =
            serde_json::from_slice(&bytes).map_err(|_| "SCOPED_SCHEMA_INVALID_JSON")?;
        return normalize_schema(appid, locale, &value);
    }
    Err("SCOPED_SCHEMA_UNAVAILABLE".into())
}

fn localized(value: &Value, locale: &str) -> Option<String> {
    string(value).or_else(|| {
        value.as_object().and_then(|o| {
            o.get(locale)
                .and_then(string)
                .or_else(|| o.get("english").and_then(string))
                .or_else(|| o.values().find_map(string))
        })
    })
}

fn normalize_schema(appid: u32, locale: &str, value: &Value) -> Result<LuaMetadata, String> {
    let array = value.as_array().ok_or("SCOPED_SCHEMA_INVALID_SHAPE")?;
    let mut out = LuaMetadata {
        app_id: appid,
        ..Default::default()
    };
    for entry in array.iter().take(5000) {
        if let Some(id) = field(entry, "name") {
            out.achievements.push(Achievement {
                id,
                name: localized(&entry["displayName"], locale),
                description: localized(&entry["description"], locale),
                icon_url: field(entry, "icon").and_then(|url| allowed_image_url(&url)),
                hidden: entry["hidden"]
                    .as_bool()
                    .unwrap_or_else(|| number(&entry["hidden"]) == Some(1)),
                maximum: real(&entry["progress"]["max_val"]),
                source: "scopedGseSchema".into(),
                ..Default::default()
            });
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::sync::atomic::{AtomicUsize, Ordering};

    #[test]
    fn lua_metadata_inputs_urls_and_schema_are_scoped() {
        assert!(validate_input(0, "english").is_err());
        assert!(validate_input(480, "../secret").is_err());
        assert_eq!(validate_input(480, "vi-VN").unwrap(), "vietnamese");
        for url in [
            "http://shared.akamai.steamstatic.com/a.jpg",
            "https://shared.akamai.steamstatic.com.evil/a.jpg",
            "https://key@shared.akamai.steamstatic.com/a.jpg",
            "https://shared.akamai.steamstatic.com/a.jpg?token=secret",
            "https://127.0.0.1/a.jpg",
        ] {
            assert!(allowed_image_url(url).is_none());
        }
        assert!(allowed_image_url(
            "https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/480/header.jpg"
        )
        .is_some());
        let schema=normalize_schema(480,"german",&json!([{"name":"A","displayName":{"english":"One","german":"Eins"},"description":"Details","hidden":"1"}])).unwrap();
        assert_eq!(schema.achievements[0].name.as_deref(), Some("Eins"));
        assert!(schema.achievements[0].hidden);
    }

    #[test]
    fn lua_metadata_normalizes_technical_fields_without_executing_launches() {
        let data=normalize_cmd(480,&json!({"data":{"480":{"appid":"480","common":{"name":"Spacewar","type":"game"},"depots":{"481":{"manifests":{"public":{"gid":"123"}}},"branches":{"public":{"buildid":"42","timeupdated":"100"}}},"config":{"launch":{"0":{"executable":"game.exe","arguments":"--a","config":{"oslist":"windows"}}}},"ufs":{"savefiles":{"0":{"root":"WinAppDataLocal","path":"Game/Save","pattern":"*.sav"}}}}}})).unwrap();
        assert_eq!(data.depots[0].manifests["public"], "123");
        assert_eq!(data.branches[0].build_id.as_deref(), Some("42"));
        assert_eq!(data.save_roots[0].root, "WinAppDataLocal");
        assert_eq!(data.launch_options[0].executable, "game.exe");
        assert!(normalize_store(
            480,
            &json!({"480":{"success":true,"data":{"steam_appid":481,"name":"Wrong"}}})
        )
        .is_err());
    }

    #[test]
    fn lua_metadata_global_percent_does_not_claim_full_schema() {
        let global = normalize_global(
            480,
            &json!({"achievementpercentages":{"achievements":[{"name":"A","percent":12.5}]}}),
        )
        .unwrap();
        assert!(global.achievements[0].name.is_none());
        let schema = normalize_schema(
            480,
            "english",
            &json!([{"name":"A","displayName":"One","description":"Details"}]),
        )
        .unwrap();
        let merged = schema.preserve_quality(&global);
        assert_eq!(merged.achievements[0].name.as_deref(), Some("One"));
        assert_eq!(merged.achievements[0].global_percent, Some(12.5));
        assert_eq!(merged.achievements[0].source, "scopedGseSchema");
    }

    #[test]
    fn lua_metadata_singleflight_coalesces_concurrent_misses() {
        let flights = Arc::new(SingleFlight::new());
        let calls = Arc::new(AtomicUsize::new(0));
        let start = Arc::new(std::sync::Barrier::new(9));
        let handles: Vec<_> = (0..8)
            .map(|_| {
                let f = flights.clone();
                let c = calls.clone();
                let b = start.clone();
                std::thread::spawn(move || {
                    b.wait();
                    f.run("480:english".into(), || {
                        c.fetch_add(1, Ordering::SeqCst);
                        std::thread::sleep(Duration::from_millis(150));
                        Ok(42)
                    })
                })
            })
            .collect();
        start.wait();
        for handle in handles {
            assert_eq!(handle.join().unwrap().unwrap(), 42);
        }
        assert_eq!(calls.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn lua_metadata_limiter_caps_four_and_releases_after_failure() {
        let limiter = Arc::new(Limiter {
            active: Mutex::new(0),
            ready: Condvar::new(),
        });
        let peak = Arc::new(AtomicUsize::new(0));
        let active = Arc::new(AtomicUsize::new(0));
        let threads: Vec<_> = (0..12)
            .map(|_| {
                let l = limiter.clone();
                let p = peak.clone();
                let a = active.clone();
                std::thread::spawn(move || {
                    let _permit = l.acquire().unwrap();
                    let count = a.fetch_add(1, Ordering::SeqCst) + 1;
                    p.fetch_max(count, Ordering::SeqCst);
                    std::thread::sleep(Duration::from_millis(30));
                    a.fetch_sub(1, Ordering::SeqCst);
                })
            })
            .collect();
        for thread in threads {
            thread.join().unwrap();
        }
        assert!(peak.load(Ordering::SeqCst) <= 4);
        assert_eq!(*limiter.active.lock().unwrap(), 0);
        let flights = SingleFlight::<u32>::new();
        assert_eq!(
            flights
                .run("panic".into(), || panic!("fixture"))
                .unwrap_err(),
            "LUA_PROVIDER_PANIC"
        );
        assert_eq!(flights.run("panic".into(), || Ok(1)).unwrap(), 1);
    }

    #[test]
    #[ignore = "Read-only public HTTP plus exact-owned temporary SQLite cache; run explicitly"]
    fn lua_metadata_live_read_only_smoke() {
        struct Fixture(PathBuf);
        impl Drop for Fixture {
            fn drop(&mut self) {
                for name in [
                    "metadata.sqlite3",
                    "metadata.sqlite3-journal",
                    "metadata.sqlite3-wal",
                    "metadata.sqlite3-shm",
                ] {
                    let _ = fs::remove_file(self.0.join(name));
                }
                let _ = fs::remove_dir(&self.0);
            }
        }
        let root = std::env::temp_dir().join(format!("lua-live-cache-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&root).unwrap();
        let fixture = Fixture(root);
        let service = MetadataService::open(fixture.0.clone()).unwrap();
        let first = service.get(2067920, "english", false, false).unwrap();
        let data = first
            .data
            .as_ref()
            .expect("Public sources must return nonempty metadata for Rogue: Genesia");
        assert!(!data.name.is_empty());
        assert_eq!(data.app_id, 2067920);
        assert!(!first.native_steam_kit_available);
        let request_count = service.requests.load(Ordering::SeqCst);
        assert!(request_count > 0 && request_count <= 3);
        let second = service.get(2067920, "english", false, false).unwrap();
        assert_eq!(
            service.requests.load(Ordering::SeqCst),
            request_count,
            "Second lookup must use success TTL/failure backoff"
        );
        assert_eq!(second.data.as_ref().unwrap().name, data.name);
        for source in &first.source_observations {
            println!(
                "lua_live source={} freshness={:?} observed={} error={}",
                source.provider,
                source.freshness,
                source.observed_at.is_some(),
                source.error_code.as_deref().unwrap_or("none")
            );
        }
        println!("lua_live appid=2067920 actualHttpRequests={request_count} secondReadAddedRequests=0 depots={} branches={} achievements={} cacheEntries={}",data.depots.len(),data.branches.len(),data.achievements.len(),service.health().unwrap().metadata_entries);
    }

    #[test]
    #[ignore = "Real pinned SteamKit process plus public network; run explicitly"]
    fn lua_native_steamkit_production_metadata_smoke() {
        let root = std::env::temp_dir().join(format!("lua-native-live-{}", uuid::Uuid::new_v4()));
        let service = MetadataService::open(root.clone())
            .unwrap()
            .with_native(NativeBridge::new(
                PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources/lua-steamkit"),
            ));
        // This tests metadata for the user's selected game; it is not gameplay evidence.
        let first = service.get(2050650, "english", true, false).unwrap();
        for observation in &first.source_observations {
            println!(
                "lua_native source={} freshness={:?} error={}",
                observation.provider,
                observation.freshness,
                observation.error_code.as_deref().unwrap_or("none")
            );
        }
        assert!(
            first.native_steam_kit_available,
            "Native SteamKit must succeed independently of the HTTP proxy"
        );
        let data = first.data.as_ref().unwrap();
        assert_eq!(data.app_id, 2050650);
        assert!(!data.name.is_empty());
        assert!(!data.depots.is_empty());
        let count = service.requests.load(Ordering::SeqCst);
        let second = service.get(2050650, "english", false, false).unwrap();
        assert!(second.native_steam_kit_available);
        assert_eq!(service.requests.load(Ordering::SeqCst), count);
        assert_eq!(
            first
                .source_observations
                .iter()
                .find(|o| o.provider == "steamKit")
                .unwrap()
                .revision,
            second
                .source_observations
                .iter()
                .find(|o| o.provider == "steamKit")
                .unwrap()
                .revision
        );
        println!("lua_native appid=2050650 depots={} branches={} nativeVerified=true secondReadAddedHttpRequests=0", data.depots.len(),data.branches.len());
        drop(service);
        for name in [
            "metadata.sqlite3",
            "metadata.sqlite3-journal",
            "metadata.sqlite3-wal",
            "metadata.sqlite3-shm",
        ] {
            let path = root.join(name);
            if path.exists() {
                fs::remove_file(path).unwrap();
            }
        }
        fs::remove_dir(root).unwrap();
    }
}
