//! Lua-only policy and local provider observations. Reading never refreshes a
//! provider, writes settings, installs a runtime or changes Steam configuration.
use std::collections::BTreeSet;
use std::fs;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Manager};

use crate::lua_runtime_profiles::{LuaRuntimeComponentHealth, LuaRuntimeComponentStatus};
use crate::lua_sources::{HubcapKeyState, HubcapUsageBucket, LuaSourceSettingsState};

const SCHEMA_VERSION: u32 = 1;
const MAX_HISTORY: usize = 64;
const MAX_STATE_BYTES: u64 = 256 * 1024;
const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;
const PROVIDERS: [&str; 10] = [
    "hubcap",
    "huggingFace",
    "openLua",
    "sushi",
    "githubMirrors",
    "steamTools",
    "ryuu",
    "luie",
    "twentyTwoCloud",
    "skyflare",
];
static STATE_LOCK: OnceLock<Mutex<()>> = OnceLock::new();
static REFRESH_IN_FLIGHT: AtomicBool = AtomicBool::new(false);

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LuaExperienceSettingsInput {
    pub provider_order: Vec<String>,
    pub pinned_provider: Option<String>,
    pub health_ttl_seconds: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LuaExperienceSettings {
    pub schema_version: u32,
    pub provider_order: Vec<String>,
    pub pinned_provider: Option<String>,
    pub health_ttl_seconds: u32,
    pub confirmation_policy: String,
    pub change_impacts: LuaChangeImpacts,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LuaChangeImpacts {
    pub provider_selection: String,
    pub runtime_profile: String,
    pub steam_compatibility: String,
}

impl Default for LuaExperienceSettings {
    fn default() -> Self {
        Self {
            schema_version: SCHEMA_VERSION,
            provider_order: PROVIDERS.iter().map(|value| value.to_string()).collect(),
            pinned_provider: None,
            health_ttl_seconds: 300,
            confirmation_policy: "manual".into(),
            change_impacts: LuaChangeImpacts {
                provider_selection: "applyNow".into(),
                runtime_profile: "relaunchGame".into(),
                steam_compatibility: "restartSteam".into(),
            },
        }
    }
}

fn normalize_settings(input: LuaExperienceSettingsInput) -> Result<LuaExperienceSettings, String> {
    if input.provider_order.len() > PROVIDERS.len() {
        return Err("Too many Lua providers in the preference list".into());
    }
    let mut seen = BTreeSet::new();
    let mut provider_order = Vec::new();
    for provider in input.provider_order {
        if !PROVIDERS.contains(&provider.as_str()) {
            return Err("Unknown Lua provider; the existing policy was not changed".into());
        }
        if seen.insert(provider.clone()) {
            provider_order.push(provider);
        }
    }
    for provider in PROVIDERS {
        if seen.insert(provider.to_string()) {
            provider_order.push(provider.to_string());
        }
    }
    if input
        .pinned_provider
        .as_ref()
        .is_some_and(|id| !PROVIDERS.contains(&id.as_str()))
    {
        return Err("Unknown pinned Lua provider; no fallback was selected".into());
    }
    Ok(LuaExperienceSettings {
        provider_order,
        pinned_provider: input.pinned_provider,
        health_ttl_seconds: input.health_ttl_seconds.clamp(60, 3600),
        ..LuaExperienceSettings::default()
    })
}

fn state_path(app: &AppHandle, name: &str) -> Result<PathBuf, String> {
    let path = app
        .path()
        .app_data_dir()
        .map(|root| root.join("lua-sources").join(name))
        .map_err(|_| "Could not resolve Lua policy storage")?;
    ensure_plain_path(&path)?;
    Ok(path)
}

fn ensure_plain_path(path: &std::path::Path) -> Result<(), String> {
    for ancestor in path.ancestors() {
        let metadata = match fs::symlink_metadata(ancestor) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(_) => return Err("Could not inspect Lua diagnostics path".into()),
        };
        if metadata.file_type().is_symlink() {
            return Err("Lua diagnostics rejects redirected paths".into());
        }
        #[cfg(windows)]
        {
            use std::os::windows::fs::MetadataExt;
            if metadata.file_attributes() & 0x400 != 0 {
                return Err("Lua diagnostics rejects reparse points".into());
            }
        }
    }
    Ok(())
}

fn read_bounded(path: &std::path::Path) -> Result<Option<Vec<u8>>, String> {
    use std::io::Read;
    let file = match fs::File::open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => {
            return Err("Could not read Lua policy state; existing data was preserved".into())
        }
    };
    if file
        .metadata()
        .map_err(|_| "Could not inspect Lua policy state")?
        .len()
        > MAX_STATE_BYTES
    {
        return Err("Lua policy state exceeds its size limit".into());
    }
    let mut bytes = Vec::new();
    file.take(MAX_STATE_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "Could not read Lua policy state")?;
    if bytes.len() as u64 > MAX_STATE_BYTES {
        return Err("Lua policy state exceeds its size limit".into());
    }
    Ok(Some(bytes))
}

pub fn read_experience_settings(app: &AppHandle) -> Result<LuaExperienceSettings, String> {
    let Some(bytes) = read_bounded(&state_path(app, "experience-policy.json")?)? else {
        return Ok(LuaExperienceSettings::default());
    };
    let settings: LuaExperienceSettings = serde_json::from_slice(&bytes)
        .map_err(|_| "Lua policy state is invalid; existing data was preserved")?;
    if settings.schema_version != SCHEMA_VERSION {
        return Err("Unsupported Lua policy version; no migration was applied".into());
    }
    normalize_settings(LuaExperienceSettingsInput {
        provider_order: settings.provider_order,
        pinned_provider: settings.pinned_provider,
        health_ttl_seconds: settings.health_ttl_seconds,
    })
}

#[tauri::command]
pub fn lua_get_experience_settings(app: AppHandle) -> Result<LuaExperienceSettings, String> {
    read_experience_settings(&app)
}

#[tauri::command]
pub fn lua_save_experience_settings(
    app: AppHandle,
    input: LuaExperienceSettingsInput,
) -> Result<LuaExperienceSettings, String> {
    let settings = normalize_settings(input)?;
    let _guard = STATE_LOCK
        .get_or_init(|| Mutex::new(()))
        .lock()
        .map_err(|_| "Lua policy lock is unavailable")?;
    // Reject a corrupt/future document rather than silently replacing it with defaults.
    read_experience_settings(&app)?;
    let bytes = serde_json::to_vec_pretty(&settings).map_err(|_| "Could not encode Lua policy")?;
    crate::lua_live::atomic_write_path(&state_path(&app, "experience-policy.json")?, &bytes)?;
    Ok(settings)
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum HealthFreshness {
    Fresh,
    Stale,
    Unknown,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ObservationResult {
    Ready,
    Failed,
    NotConfigured,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum ProviderErrorCode {
    HubcapKeyInvalid,
    HubcapRateLimited,
    HubcapRequestFailed,
    HubcapServiceUnavailable,
    LuaSettingsUnreadable,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SafeQuota {
    pub usage: Option<u64>,
    pub limit: Option<u64>,
    pub remaining: Option<u64>,
}

fn safe_quota(value: &HubcapUsageBucket) -> SafeQuota {
    SafeQuota {
        usage: value.usage.filter(|n| *n <= MAX_SAFE_INTEGER),
        limit: value.limit.filter(|n| *n <= MAX_SAFE_INTEGER),
        remaining: value.remaining.filter(|n| *n <= MAX_SAFE_INTEGER),
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HubcapObservation {
    pub checked_at: DateTime<Utc>,
    pub configuration_fingerprint: Option<String>,
    pub result: ObservationResult,
    pub error_code: Option<ProviderErrorCode>,
    pub expires_at: Option<DateTime<Utc>>,
    pub expiry_estimated: bool,
    pub daily: SafeQuota,
    pub single: SafeQuota,
    pub bundle: SafeQuota,
    pub workshop: SafeQuota,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct HealthHistory {
    schema_version: u32,
    observations: Vec<HubcapObservation>,
}

fn configuration_fingerprint(app: &AppHandle) -> Result<Option<String>, String> {
    // Only a digest of the existing encrypted settings is retained. No token,
    // masked key, raw response or new credential store is introduced.
    Ok(read_bounded(&state_path(app, "settings.json")?)?
        .map(|bytes| format!("{:x}", Sha256::digest(bytes))))
}

fn read_history(app: &AppHandle) -> Result<HealthHistory, String> {
    let Some(bytes) = read_bounded(&state_path(app, "experience-health.json")?)? else {
        return Ok(HealthHistory {
            schema_version: SCHEMA_VERSION,
            observations: Vec::new(),
        });
    };
    let history: HealthHistory = serde_json::from_slice(&bytes)
        .map_err(|_| "Lua health history is invalid; no data was replaced")?;
    if history.schema_version != SCHEMA_VERSION
        || history.observations.len() > MAX_HISTORY
        || history.observations.iter().any(|row| {
            row.configuration_fingerprint.as_ref().is_some_and(|hash| {
                hash.len() != 64 || !hash.bytes().all(|b| b.is_ascii_hexdigit())
            })
        })
    {
        return Err("Lua health history failed validation; no data was replaced".into());
    }
    Ok(history)
}

fn observation(
    state: &HubcapKeyState,
    fingerprint: Option<String>,
    now: DateTime<Utc>,
) -> HubcapObservation {
    let error_code = match state.last_error.as_deref() {
        Some("HUBCAP_KEY_INVALID") => Some(ProviderErrorCode::HubcapKeyInvalid),
        Some("HUBCAP_RATE_LIMITED") => Some(ProviderErrorCode::HubcapRateLimited),
        Some(_) => Some(ProviderErrorCode::HubcapRequestFailed),
        None if state.configured && !state.service_ready => {
            Some(ProviderErrorCode::HubcapServiceUnavailable)
        }
        None => None,
    };
    HubcapObservation {
        checked_at: now,
        configuration_fingerprint: fingerprint,
        result: if !state.configured {
            ObservationResult::NotConfigured
        } else if state.valid && state.service_ready && !state.expired && error_code.is_none() {
            ObservationResult::Ready
        } else {
            ObservationResult::Failed
        },
        error_code,
        expires_at: state
            .expires_at
            .as_deref()
            .and_then(|s| DateTime::parse_from_rfc3339(s).ok())
            .map(|stamp| stamp.with_timezone(&Utc)),
        expiry_estimated: state.expiry_estimated,
        daily: safe_quota(&state.daily),
        single: safe_quota(&state.single),
        bundle: safe_quota(&state.bundle),
        workshop: safe_quota(&state.workshop),
    }
}

fn append_observation(history: &mut HealthHistory, row: HubcapObservation) {
    history.observations.push(row);
    let excess = history.observations.len().saturating_sub(MAX_HISTORY);
    if excess > 0 {
        history.observations.drain(..excess);
    }
}

fn freshness(checked_at: Option<DateTime<Utc>>, now: DateTime<Utc>, ttl: u32) -> HealthFreshness {
    let Some(checked_at) = checked_at else {
        return HealthFreshness::Unknown;
    };
    let elapsed = now.signed_duration_since(checked_at);
    if elapsed < chrono::Duration::zero() {
        HealthFreshness::Unknown
    } else if elapsed <= chrono::Duration::seconds(i64::from(ttl)) {
        HealthFreshness::Fresh
    } else {
        HealthFreshness::Stale
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LuaProviderHealth {
    pub id: String,
    pub configured: bool,
    pub enabled: bool,
    pub freshness: HealthFreshness,
    pub availability: String,
    pub checked_at: Option<DateTime<Utc>>,
    pub error_code: Option<ProviderErrorCode>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LuaCapabilityHealth {
    pub id: String,
    pub state: String,
    pub reason: String,
    pub activation_allowed: bool,
    pub change_impact: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LuaSteamIdentity {
    pub build: Option<i64>,
    pub build_allowlisted: bool,
    pub binary_file: String,
    pub binary_sha256: Option<String>,
    pub channel: String,
    pub identity_source: String,
    pub native_patch_approved: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LuaExperienceHealth {
    pub schema_version: u32,
    pub observed_at: DateTime<Utc>,
    pub refreshed: bool,
    pub settings: LuaExperienceSettings,
    pub providers: Vec<LuaProviderHealth>,
    pub capabilities: Vec<LuaCapabilityHealth>,
    pub components: Vec<LuaRuntimeComponentHealth>,
    pub steam: LuaSteamIdentity,
    pub hubcap_history: Vec<HubcapObservation>,
    pub quota_observation: Option<HubcapObservation>,
    pub warnings: Vec<String>,
}

fn provider_health(
    settings: &LuaExperienceSettings,
    sources: Option<&LuaSourceSettingsState>,
    history: &HealthHistory,
    fingerprint: &Option<String>,
    now: DateTime<Utc>,
) -> Vec<LuaProviderHealth> {
    settings
        .provider_order
        .iter()
        .map(|id| {
            let (configured, enabled) = sources
                .map(|sources| match id.as_str() {
                    "hubcap" => (sources.hubcap.configured, sources.hubcap.configured),
                    "huggingFace" => (true, true),
                    "openLua" => (true, sources.openlua_enabled),
                    "sushi" => (true, sources.sushi_enabled),
                    "githubMirrors" => (true, sources.github_mirrors_enabled),
                    "steamTools" => (true, sources.steamtools_enabled),
                    "ryuu" => (sources.ryuu_configured, sources.ryuu_enabled),
                    "luie" => (true, sources.luie_enabled),
                    "twentyTwoCloud" => (true, sources.twenty_two_cloud_enabled),
                    "skyflare" => (true, sources.skyflare_enabled),
                    _ => (false, false),
                })
                .unwrap_or((false, false));
            let latest = (id == "hubcap" && configured)
                .then(|| {
                    history
                        .observations
                        .iter()
                        .rev()
                        .find(|row| &row.configuration_fingerprint == fingerprint)
                })
                .flatten();
            let checked_at = latest.map(|row| row.checked_at);
            let fresh = freshness(checked_at, now, settings.health_ttl_seconds);
            let hard_expired = latest.is_some_and(|row| {
                !row.expiry_estimated && row.expires_at.is_some_and(|expiry| expiry <= now)
            });
            let availability = if !enabled {
                "disabled"
            } else if hard_expired {
                "unavailable"
            } else if fresh != HealthFreshness::Fresh {
                "unknown"
            } else if latest.is_some_and(|row| row.result == ObservationResult::Ready) {
                "ready"
            } else {
                "unavailable"
            };
            LuaProviderHealth {
                id: id.clone(),
                configured,
                enabled,
                freshness: fresh,
                availability: availability.into(),
                checked_at,
                error_code: if sources.is_none() {
                    Some(ProviderErrorCode::LuaSettingsUnreadable)
                } else {
                    latest.and_then(|row| row.error_code)
                },
            }
        })
        .collect()
}

fn capability(
    id: &str,
    state: &str,
    reason: &str,
    activation_allowed: bool,
    impact: &str,
) -> LuaCapabilityHealth {
    LuaCapabilityHealth {
        id: id.into(),
        state: state.into(),
        reason: reason.into(),
        activation_allowed,
        change_impact: impact.into(),
    }
}

fn capabilities(
    components: &[LuaRuntimeComponentHealth],
    steam_supported: bool,
    cloud_configured: bool,
    workshop_tool: bool,
) -> Vec<LuaCapabilityHealth> {
    let gse = components
        .iter()
        .filter(|row| row.id.starts_with("gse"))
        .collect::<Vec<_>>();
    let gse_present = gse
        .iter()
        .any(|row| row.status == LuaRuntimeComponentStatus::Available);
    let gse_verified = gse.iter().any(|row| {
        row.integrity_verified
            && row.provenance_verified
            && row.status == LuaRuntimeComponentStatus::Available
    });
    vec![
        capability(
            "catalog",
            "available",
            "luaCatalogReadOnlyAvailable",
            true,
            "applyNow",
        ),
        capability(
            "metadata",
            "available",
            "luaMetadataIndependentOfProviderQuota",
            true,
            "applyNow",
        ),
        capability(
            "achievements",
            "profileRequired",
            "gameSchemaAndApprovedRuntimeRequired",
            false,
            "relaunchGame",
        ),
        capability(
            "gse",
            if gse_verified {
                "profileRequired"
            } else if gse_present {
                "unverified"
            } else {
                "unavailable"
            },
            if gse_verified {
                "perGameApprovalStillRequired"
            } else {
                "runtimeIntegrityAndProvenanceRequired"
            },
            false,
            "relaunchGame",
        ),
        capability(
            "workshop",
            if workshop_tool {
                "profileRequired"
            } else {
                "available"
            },
            if workshop_tool {
                "approvedWorkshopToolAndItemAccessRequired"
            } else {
                "directWorkshopAccessOnly"
            },
            false,
            "applyNow",
        ),
        capability(
            "cloud",
            if cloud_configured {
                "unverified"
            } else {
                "notConfigured"
            },
            "existingLauncherVaultConnectionNotTested",
            false,
            "applyNow",
        ),
        capability(
            "steamCompatibility",
            if steam_supported {
                "profileRequired"
            } else {
                "blocked"
            },
            "staticBuildListIsNotBinaryOrGameApproval",
            false,
            "restartSteam",
        ),
    ]
}

fn local_binary_hash(path: &std::path::Path) -> Option<String> {
    use std::io::Read;
    const MAX_BINARY: u64 = 64 * 1024 * 1024;
    // Identity evidence only: never load the binary, infer trust or allow a patch.
    ensure_plain_path(path).ok()?;
    let file = fs::File::open(path).ok()?;
    let before = file.metadata().ok()?;
    if !before.is_file() || before.len() == 0 || before.len() > MAX_BINARY {
        return None;
    }
    let mut reader = file.take(MAX_BINARY + 1);
    let mut hasher = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    let mut total = 0;
    loop {
        let count = reader.read(&mut buffer).ok()?;
        if count == 0 {
            break;
        }
        total += count as u64;
        if total > MAX_BINARY {
            return None;
        }
        hasher.update(&buffer[..count]);
    }
    let after = reader.get_ref().metadata().ok()?;
    if total != before.len()
        || after.len() != before.len()
        || after.modified().ok()? != before.modified().ok()?
    {
        return None;
    }
    Some(format!("{:x}", hasher.finalize()))
}

struct RefreshGuard;
impl Drop for RefreshGuard {
    fn drop(&mut self) {
        REFRESH_IN_FLIGHT.store(false, Ordering::Release);
    }
}

#[tauri::command]
pub async fn lua_get_experience_health(
    app: AppHandle,
    refresh: Option<bool>,
) -> Result<LuaExperienceHealth, String> {
    let refresh = refresh.unwrap_or(false);
    let _refresh_guard = if refresh {
        REFRESH_IN_FLIGHT
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .map_err(|_| "A Lua provider refresh is already running")?;
        Some(RefreshGuard)
    } else {
        None
    };
    let sources = crate::lua_sources::get_lua_source_settings(app.clone())
        .await
        .ok();
    let before = configuration_fingerprint(&app)?;
    // A corrupt history is never overwritten after a network operation.
    if refresh {
        read_history(&app)?;
    }
    let refreshed_state = if refresh && sources.as_ref().is_some_and(|row| row.hubcap.configured) {
        Some(
            crate::lua_sources::refresh_hubcap_key_state(app.clone())
                .await
                .unwrap_or_else(|_| HubcapKeyState {
                    configured: true,
                    last_error: Some("HUBCAP_REQUEST_FAILED".into()),
                    ..HubcapKeyState::default()
                }),
        )
    } else {
        None
    };
    tauri::async_runtime::spawn_blocking(move || {
        let now = Utc::now();
        let settings = read_experience_settings(&app)?;
        let current_fingerprint = configuration_fingerprint(&app)?;
        let mut warnings = Vec::new();
        let mut history = match read_history(&app) {
            Ok(history) => history,
            Err(error) if !refresh => {
                warnings.push(error);
                HealthHistory {
                    schema_version: SCHEMA_VERSION,
                    observations: Vec::new(),
                }
            }
            Err(error) => return Err(error),
        };
        let mut refreshed = false;
        if let Some(state) = refreshed_state {
            if current_fingerprint != before {
                warnings.push(
                    "Lua source settings changed during refresh; the observation was not saved"
                        .into(),
                );
            } else {
                let _guard = STATE_LOCK
                    .get_or_init(|| Mutex::new(()))
                    .lock()
                    .map_err(|_| "Lua health lock is unavailable")?;
                history = read_history(&app)?;
                append_observation(
                    &mut history,
                    observation(&state, current_fingerprint.clone(), now),
                );
                let bytes = serde_json::to_vec_pretty(&history)
                    .map_err(|_| "Could not encode Lua health history")?;
                crate::lua_live::atomic_write_path(
                    &state_path(&app, "experience-health.json")?,
                    &bytes,
                )?;
                refreshed = true;
            }
        } else if refresh {
            warnings.push("Hubcap is not configured; no remote request was sent".into());
        }
        let providers = provider_health(
            &settings,
            sources.as_ref(),
            &history,
            &current_fingerprint,
            now,
        );
        let components = crate::lua_runtime_profiles::get_lua_runtime_component_health(app.clone());
        let steam_path = crate::cloud_redirect::steam_detector::find_steam_path();
        let build = steam_path
            .as_ref()
            .and_then(|path| crate::cloud_redirect::steam_detector::get_steam_version(path));
        let build_allowlisted = build.is_some_and(|value| {
            crate::cloud_redirect::steam_detector::SUPPORTED_STEAM_VERSIONS.contains(&value)
        });
        let binary_sha256 = steam_path
            .as_ref()
            .and_then(|path| local_binary_hash(&path.join("steam.exe")));
        let workshop_tool = crate::lua_workshop::lua_workshop_tool_available(&app).unwrap_or(false);
        let cloud_configured = crate::cloud_redirect_v2::cloud_redirect_engine_get_provider()
            .ok()
            .is_some_and(|provider| provider.provider != "local" && provider.authenticated);
        let quota_observation = history
            .observations
            .iter()
            .rev()
            .find(|row| {
                row.result == ObservationResult::Ready
                    && row.configuration_fingerprint == current_fingerprint
            })
            .cloned();
        Ok(LuaExperienceHealth {
            schema_version: SCHEMA_VERSION,
            observed_at: now,
            refreshed,
            settings,
            capabilities: capabilities(
                &components,
                build_allowlisted,
                cloud_configured,
                workshop_tool,
            ),
            providers,
            components,
            steam: LuaSteamIdentity {
                build,
                build_allowlisted,
                binary_file: "steam.exe".into(),
                binary_sha256,
                channel: "unknown".into(),
                identity_source: "installedPackageManifestAndLocalBinaryHash".into(),
                native_patch_approved: false,
            },
            hubcap_history: history.observations,
            quota_observation,
            warnings,
        })
    })
    .await
    .map_err(|_| "Lua diagnostics worker failed")?
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::Duration;

    fn now() -> DateTime<Utc> {
        DateTime::parse_from_rfc3339("2026-09-04T12:00:00Z")
            .unwrap()
            .with_timezone(&Utc)
    }

    #[test]
    fn settings_normalize_without_enabling_automatic_actions() {
        let settings = normalize_settings(LuaExperienceSettingsInput {
            provider_order: vec!["openLua".into(), "openLua".into()],
            pinned_provider: Some("hubcap".into()),
            health_ttl_seconds: 0,
        })
        .unwrap();
        assert_eq!(settings.provider_order[0], "openLua");
        assert_eq!(settings.provider_order.len(), PROVIDERS.len());
        assert_eq!(settings.health_ttl_seconds, 60);
        assert_eq!(settings.confirmation_policy, "manual");
        assert_eq!(settings.change_impacts.runtime_profile, "relaunchGame");
        assert_eq!(settings.change_impacts.steam_compatibility, "restartSteam");
    }

    #[test]
    fn unknown_provider_or_pin_fails_closed() {
        for (order, pin) in [
            (vec!["unknown".into()], None),
            (vec![], Some("unknown".into())),
        ] {
            assert!(normalize_settings(LuaExperienceSettingsInput {
                provider_order: order,
                pinned_provider: pin,
                health_ttl_seconds: 300
            })
            .is_err());
        }
    }

    #[test]
    fn future_or_expired_observations_are_not_fresh() {
        assert_eq!(freshness(None, now(), 300), HealthFreshness::Unknown);
        assert_eq!(
            freshness(Some(now() + Duration::seconds(1)), now(), 300),
            HealthFreshness::Unknown
        );
        assert_eq!(
            freshness(Some(now() - Duration::seconds(301)), now(), 300),
            HealthFreshness::Stale
        );
        assert_eq!(
            freshness(Some(now() - Duration::seconds(300)), now(), 300),
            HealthFreshness::Fresh
        );
        assert_eq!(
            freshness(Some(now() + Duration::milliseconds(1)), now(), 300),
            HealthFreshness::Unknown
        );
        assert_eq!(
            freshness(Some(now() - Duration::milliseconds(300_001)), now(), 300),
            HealthFreshness::Stale
        );
    }

    #[test]
    fn history_never_serializes_keys_or_raw_errors() {
        let state = HubcapKeyState {
            configured: true,
            masked_key: Some("fixture-secret-key".into()),
            last_error: Some("https://private.test/?token=fixture-secret-value".into()),
            expires_at: Some("fixture-secret-expiry".into()),
            ..HubcapKeyState::default()
        };
        let row = observation(&state, Some("a".repeat(64)), now());
        let json = serde_json::to_string(&row).unwrap();
        assert!(!json.contains("fixture-secret"));
        assert!(!json.contains("private.test"));
        assert_eq!(row.error_code, Some(ProviderErrorCode::HubcapRequestFailed));
        assert!(row.expires_at.is_none());
    }

    #[test]
    fn history_is_bounded_and_retains_recent_failures() {
        let mut history = HealthHistory {
            schema_version: 1,
            observations: Vec::new(),
        };
        for index in 0..100 {
            append_observation(
                &mut history,
                observation(
                    &HubcapKeyState::default(),
                    None,
                    now() + Duration::seconds(index),
                ),
            );
        }
        assert_eq!(history.observations.len(), MAX_HISTORY);
        assert_eq!(
            history.observations[0].checked_at,
            now() + Duration::seconds(36)
        );
    }

    #[test]
    fn unknown_quota_does_not_become_zero_or_unlimited() {
        assert!(safe_quota(&HubcapUsageBucket::default())
            .remaining
            .is_none());
        assert!(safe_quota(&HubcapUsageBucket {
            usage: Some(u64::MAX),
            limit: None,
            remaining: None
        })
        .usage
        .is_none());
    }

    #[test]
    fn provider_failure_does_not_disable_independent_metadata() {
        let rows = capabilities(&[], false, false, false);
        assert!(
            rows.iter()
                .find(|row| row.id == "metadata")
                .unwrap()
                .activation_allowed
        );
        assert_eq!(
            rows.iter().find(|row| row.id == "workshop").unwrap().state,
            "available"
        );
        assert_eq!(
            rows.iter()
                .find(|row| row.id == "steamCompatibility")
                .unwrap()
                .state,
            "blocked"
        );
        assert!(
            !rows
                .iter()
                .find(|row| row.id == "gse")
                .unwrap()
                .activation_allowed
        );
    }

    fn source_fixture() -> LuaSourceSettingsState {
        LuaSourceSettingsState {
            hubcap: HubcapKeyState {
                configured: true,
                ..HubcapKeyState::default()
            },
            manifesthub_key: None,
            manifesthub_configured: false,
            ryuu_key: None,
            ryuu_configured: false,
            depotbox_key: None,
            depotbox_configured: false,
            sushi_enabled: true,
            github_mirrors_enabled: true,
            openlua_enabled: true,
            steamtools_enabled: true,
            ryuu_enabled: false,
            luie_enabled: true,
            twenty_two_cloud_enabled: true,
            skyflare_enabled: true,
        }
    }

    #[test]
    fn configuration_change_invalidates_prior_provider_observation() {
        let before = Some("a".repeat(64));
        let row = observation(
            &HubcapKeyState {
                configured: true,
                valid: true,
                service_ready: true,
                ..HubcapKeyState::default()
            },
            before.clone(),
            now(),
        );
        let history = HealthHistory {
            schema_version: 1,
            observations: vec![row],
        };
        let source = source_fixture();
        let old = provider_health(
            &LuaExperienceSettings::default(),
            Some(&source),
            &history,
            &before,
            now(),
        );
        assert_eq!(
            old.iter().find(|p| p.id == "hubcap").unwrap().availability,
            "ready"
        );
        let changed = provider_health(
            &LuaExperienceSettings::default(),
            Some(&source),
            &history,
            &Some("b".repeat(64)),
            now(),
        );
        let hubcap = changed.iter().find(|p| p.id == "hubcap").unwrap();
        assert_eq!(hubcap.freshness, HealthFreshness::Unknown);
        assert_eq!(hubcap.availability, "unknown");
        assert!(hubcap.checked_at.is_none());
    }

    #[test]
    fn expired_observation_is_unavailable_and_other_provider_remains_unknown() {
        let fingerprint = Some("a".repeat(64));
        let row = observation(
            &HubcapKeyState {
                configured: true,
                valid: true,
                service_ready: true,
                expires_at: Some((now() - Duration::seconds(1)).to_rfc3339()),
                ..HubcapKeyState::default()
            },
            fingerprint.clone(),
            now(),
        );
        let history = HealthHistory {
            schema_version: 1,
            observations: vec![row],
        };
        let providers = provider_health(
            &LuaExperienceSettings::default(),
            Some(&source_fixture()),
            &history,
            &fingerprint,
            now(),
        );
        assert_eq!(
            providers
                .iter()
                .find(|p| p.id == "hubcap")
                .unwrap()
                .availability,
            "unavailable"
        );
        assert_eq!(
            providers
                .iter()
                .find(|p| p.id == "openLua")
                .unwrap()
                .freshness,
            HealthFreshness::Unknown
        );
        assert_eq!(
            providers
                .iter()
                .find(|p| p.id == "openLua")
                .unwrap()
                .availability,
            "unknown"
        );
    }

    #[test]
    fn missing_state_read_does_not_create_directory_or_file() {
        let directory =
            std::env::temp_dir().join(format!("lua-policy-read-only-{}", uuid::Uuid::new_v4()));
        assert!(read_bounded(&directory.join("experience-policy.json"))
            .unwrap()
            .is_none());
        assert!(!directory.exists());
    }

    #[test]
    fn workshop_tool_gate_does_not_enable_native_or_authentication() {
        let rows = capabilities(&[], true, false, true);
        let workshop = rows.iter().find(|row| row.id == "workshop").unwrap();
        assert_eq!(workshop.state, "profileRequired");
        assert!(!workshop.activation_allowed);
        let native = rows
            .iter()
            .find(|row| row.id == "steamCompatibility")
            .unwrap();
        assert!(!native.activation_allowed);
        assert_eq!(native.reason, "staticBuildListIsNotBinaryOrGameApproval");
    }
}
