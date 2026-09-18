//! Lua Workshop account broker. Credentials never cross the public Tauri boundary.
use crate::lua_experience::{native::NativeBridge, native_resource_root};
use base64::Engine;
use serde::{Deserialize, Serialize};
use std::{
    fs,
    io::Read,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, AtomicU8, Ordering},
        Arc, Mutex, OnceLock,
    },
    thread::JoinHandle,
    time::Duration,
};
use tauri::{AppHandle, Manager};
use zeroize::Zeroizing;

const FRAME_ERROR: &str = "LUA_STEAM_AUTH_PROTOCOL_INVALID";
static BROKER: OnceLock<Mutex<Option<Broker>>> = OnceLock::new();

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PublicAccount {
    pub account_id: String,
    pub steam_id: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthStatus {
    pub phase: String,
    pub attempt_id: Option<String>,
    pub account: Option<PublicAccount>,
    pub qr_image: Option<String>,
    pub expires_at: Option<i64>,
    pub error_code: Option<String>,
}

// Intentionally no Debug or Clone: do not copy credentials into logs/state snapshots.
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Credential {
    account_id: String,
    steam_id: String,
    account_name: Zeroizing<String>,
    refresh_token: Zeroizing<String>,
}
impl Credential {
    fn public(&self) -> PublicAccount {
        PublicAccount {
            account_id: self.account_id.clone(),
            steam_id: self.steam_id.clone(),
        }
    }
    fn validate(&self) -> Result<(), String> {
        if uuid::Uuid::parse_str(&self.account_id).is_err()
            || !valid_steam_id(&self.steam_id)
            || self.account_name.is_empty()
            || self.account_name.len() > 128
            || self.account_name.chars().any(char::is_control)
            || !(16..=8192).contains(&self.refresh_token.len())
            || !self
                .refresh_token
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b".-_".contains(&b))
        {
            return Err(FRAME_ERROR.into());
        }
        Ok(())
    }
}

struct Broker {
    path: PathBuf,
    native: NativeBridge,
    status: AuthStatus,
    stop: Arc<AtomicBool>,
    worker: Option<JoinHandle<()>>,
    active: bool,
    disconnecting: bool,
    operation_stop: Option<Arc<AtomicU8>>,
}

fn valid_steam_id(id: &str) -> bool {
    id.len() == 17
        && id.bytes().all(|b| b.is_ascii_digit())
        && id.parse::<u64>().is_ok_and(|value| {
            value >> 56 == 1
                && (value >> 52) & 15 == 1
                && (value >> 32) & 0xfffff == 1
                && value as u32 != 0
        })
}

fn read_vault(path: &Path) -> Result<Option<Credential>, String> {
    crate::lua_workshop::reject_reparse_ancestors(path)?;
    let file = match fs::File::open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err("LUA_STEAM_AUTH_VAULT_READ_FAILED".into()),
    };
    let mut encrypted = Vec::new();
    file.take(32 * 1024 + 1)
        .read_to_end(&mut encrypted)
        .map_err(|_| "LUA_STEAM_AUTH_VAULT_READ_FAILED")?;
    if encrypted.len() > 32 * 1024 {
        return Err("LUA_STEAM_AUTH_VAULT_INVALID".into());
    }
    let plaintext = Zeroizing::new(
        crate::secret_store::unprotect(&encrypted).map_err(|_| "LUA_STEAM_AUTH_VAULT_INVALID")?,
    );
    let value: Credential =
        serde_json::from_slice(&plaintext).map_err(|_| "LUA_STEAM_AUTH_VAULT_INVALID")?;
    value
        .validate()
        .map_err(|_| "LUA_STEAM_AUTH_VAULT_INVALID")?;
    Ok(Some(value))
}

fn save_vault(path: &Path, credential: &Credential) -> Result<(), String> {
    credential.validate()?;
    crate::lua_workshop::reject_reparse_ancestors(path)?;
    let plaintext = Zeroizing::new(serde_json::to_vec(credential).map_err(|_| FRAME_ERROR)?);
    let encrypted = crate::secret_store::protect(&plaintext)
        .map_err(|_| "LUA_STEAM_AUTH_VAULT_WRITE_FAILED")?;
    // Only encrypted bytes ever enter the atomic writer, including its temporary file.
    crate::lua_live::atomic_write_path(path, &encrypted)
        .map_err(|_| "LUA_STEAM_AUTH_VAULT_WRITE_FAILED".into())
}

fn with_broker<T>(
    app: &AppHandle,
    action: impl FnOnce(&mut Broker) -> Result<T, String>,
) -> Result<T, String> {
    let path = app
        .path()
        .app_data_dir()
        .map_err(|_| "LUA_STEAM_AUTH_VAULT_PATH")?
        .join("lua-experience/steam-workshop.dpapi");
    let mut guard = BROKER
        .get_or_init(|| Mutex::new(None))
        .lock()
        .map_err(|_| "LUA_STEAM_AUTH_BUSY")?;
    if guard.is_none() {
        let (account, vault_error) = match read_vault(&path) {
            Ok(value) => (value.map(|credential| credential.public()), None),
            Err(error) => (None, Some(error)),
        };
        *guard = Some(Broker {
            path: path.clone(),
            native: NativeBridge::new(native_resource_root(app)?),
            status: AuthStatus {
                phase: if vault_error.is_some() {
                    "failed"
                } else {
                    "idle"
                }
                .into(),
                attempt_id: None,
                account,
                qr_image: None,
                expires_at: None,
                error_code: vault_error,
            },
            stop: Arc::new(AtomicBool::new(false)),
            worker: None,
            active: false,
            disconnecting: false,
            operation_stop: None,
        });
    }
    let broker = guard.as_mut().ok_or("LUA_STEAM_AUTH_BUSY")?;
    if broker.path != path {
        return Err("LUA_STEAM_AUTH_VAULT_PATH".into());
    }
    action(broker)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Envelope {
    schema_version: u32,
    request_id: String,
    sequence: u32,
    kind: String,
    #[serde(default)]
    challenge_url: Option<String>,
    #[serde(default)]
    account_name: Option<Zeroizing<String>>,
    #[serde(default)]
    refresh_token: Option<Zeroizing<String>>,
    #[serde(default)]
    steam_id: Option<String>,
    #[serde(default)]
    error_code: Option<String>,
}

fn qr_image(url: &str) -> Result<String, String> {
    let uri = url::Url::parse(url).map_err(|_| FRAME_ERROR)?;
    if url.len() > 1024
        || uri.scheme() != "https"
        || uri.host_str() != Some("s.team")
        || uri.port_or_known_default() != Some(443)
        || !uri.username().is_empty()
        || uri.password().is_some()
        || !uri.path().starts_with("/q/")
        || uri.query().is_some()
        || uri.fragment().is_some()
    {
        return Err("LUA_STEAM_AUTH_CHALLENGE_INVALID".into());
    }
    let svg = qrcode::QrCode::new(url)
        .map_err(|_| FRAME_ERROR)?
        .render::<qrcode::render::svg::Color>()
        .min_dimensions(256, 256)
        .dark_color(qrcode::render::svg::Color("#000000"))
        .light_color(qrcode::render::svg::Color("#ffffff"))
        .build();
    Ok(format!(
        "data:image/svg+xml;base64,{}",
        base64::engine::general_purpose::STANDARD.encode(svg)
    ))
}

struct LoginFrames {
    sequence: u32,
    credential: Option<Credential>,
    terminal: bool,
}
impl LoginFrames {
    fn accept(&mut self, bytes: &[u8], request: &str) -> Result<Option<String>, String> {
        let frame: Envelope = serde_json::from_slice(bytes).map_err(|_| FRAME_ERROR)?;
        if self.terminal
            || frame.schema_version != 2
            || frame.request_id != request
            || frame.sequence != self.sequence + 1
        {
            return Err(FRAME_ERROR.into());
        }
        self.sequence = frame.sequence;
        match frame.kind.as_str() {
            "challenge"
                if frame.account_name.is_none()
                    && frame.refresh_token.is_none()
                    && frame.steam_id.is_none()
                    && frame.error_code.is_none()
                    && self.sequence <= 24 =>
            {
                Ok(Some(qr_image(
                    frame.challenge_url.as_deref().ok_or(FRAME_ERROR)?,
                )?))
            }
            "credential" if frame.challenge_url.is_none() && frame.error_code.is_none() => {
                let credential = Credential {
                    account_id: uuid::Uuid::new_v4().to_string(),
                    steam_id: frame.steam_id.ok_or(FRAME_ERROR)?,
                    account_name: frame.account_name.ok_or(FRAME_ERROR)?,
                    refresh_token: frame.refresh_token.ok_or(FRAME_ERROR)?,
                };
                credential.validate()?;
                self.credential = Some(credential);
                self.terminal = true;
                Ok(None)
            }
            "error"
                if frame.challenge_url.is_none()
                    && frame.account_name.is_none()
                    && frame.refresh_token.is_none()
                    && frame.steam_id.is_none() =>
            {
                self.terminal = true;
                // Exact codes, not arbitrary uppercase provider text masquerading as a code.
                Err(match frame.error_code.as_deref() {
                    Some("LUA_STEAM_AUTH_REJECTED") => "LUA_STEAM_AUTH_REJECTED",
                    Some("LUA_STEAM_AUTH_TIMEOUT") => "LUA_STEAM_AUTH_TIMEOUT",
                    Some("LUA_STEAM_AUTH_CHALLENGE_INVALID") => "LUA_STEAM_AUTH_CHALLENGE_INVALID",
                    _ => "LUA_STEAM_AUTH_FAILED",
                }
                .into())
            }
            _ => Err(FRAME_ERROR.into()),
        }
    }
}

fn finish_login(broker: &mut Broker, id: &str, outcome: Result<Credential, String>) {
    if broker.status.attempt_id.as_deref() != Some(id) {
        return;
    }
    broker.active = false;
    broker.status.qr_image = None;
    broker.status.expires_at = None;
    let outcome = if broker.stop.load(Ordering::SeqCst) {
        Err("LUA_STEAM_AUTH_CANCELLED".into())
    } else {
        outcome
    };
    let saved = outcome.and_then(|credential| {
        save_vault(&broker.path, &credential)?;
        Ok(credential.public())
    });
    match saved {
        Ok(account) => {
            broker.status.account = Some(account);
            broker.status.phase = "saved".into();
            broker.status.error_code = None;
        }
        Err(error) => {
            broker.status.phase = if error == "LUA_STEAM_AUTH_CANCELLED" {
                "cancelled"
            } else {
                "failed"
            }
            .into();
            broker.status.error_code = Some(error);
        }
    }
}

/// Binds one operation to the exact saved account revision. Disconnect cancels
/// this same signal; a new QR login cannot silently switch an in-flight download.
pub(crate) struct AccountLease {
    app: AppHandle,
    credential: Credential,
    native: NativeBridge,
    stop: Arc<AtomicU8>,
}
impl Drop for AccountLease {
    fn drop(&mut self) {
        let _ = with_broker(&self.app, |broker| {
            if broker
                .operation_stop
                .as_ref()
                .is_some_and(|stop| Arc::ptr_eq(stop, &self.stop))
            {
                broker.operation_stop = None;
            }
            Ok(())
        });
    }
}

pub(crate) fn account_lease(
    app: &AppHandle,
    account_id: &str,
    stop: Arc<AtomicU8>,
) -> Result<AccountLease, String> {
    if uuid::Uuid::parse_str(account_id).is_err() {
        return Err("LUA_STEAM_AUTH_ACCOUNT_CHANGED".into());
    }
    with_broker(app, |broker| {
        if broker.active || broker.disconnecting || broker.operation_stop.is_some() {
            return Err("LUA_STEAM_AUTH_BUSY".into());
        }
        let credential = read_vault(&broker.path)?.ok_or("LUA_STEAM_AUTH_REQUIRED")?;
        if credential.account_id != account_id {
            return Err("LUA_STEAM_AUTH_ACCOUNT_CHANGED".into());
        }
        broker.operation_stop = Some(stop.clone());
        Ok(AccountLease {
            app: app.clone(),
            credential,
            native: broker.native.clone(),
            stop,
        })
    })
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AuthenticatedDetails {
    schema_version: u32,
    request_id: String,
    sequence: u32,
    kind: String,
    steam_id: String,
    pub appid: u32,
    pub item_id: String,
    pub title: String,
    pub size_bytes: u64,
    pub updated_at: u64,
    pub content_url: String,
    pub manifest_id: String,
    pub file_type: u32,
}

impl AccountLease {
    pub(crate) fn resolve(
        &self,
        appid: u32,
        item_id: &str,
    ) -> Result<AuthenticatedDetails, String> {
        crate::lua_workshop::validate_item_id(item_id)?;
        if appid == 0 {
            return Err("LUA_WORKSHOP_INVALID_APPID".into());
        }
        #[derive(Serialize)]
        #[serde(rename_all = "camelCase")]
        struct PrivateRequest<'a> {
            schema_version: u32,
            request_id: &'a str,
            operation: &'static str,
            steam_id: &'a str,
            account_name: &'a str,
            refresh_token: &'a str,
            appid: u32,
            item_id: &'a str,
        }
        let id = uuid::Uuid::new_v4().to_string();
        let request = Zeroizing::new(
            serde_json::to_vec(&PrivateRequest {
                schema_version: 2,
                request_id: &id,
                operation: "workshopDetails",
                steam_id: &self.credential.steam_id,
                account_name: &self.credential.account_name,
                refresh_token: &self.credential.refresh_token,
                appid,
                item_id,
            })
            .map_err(|_| FRAME_ERROR)?,
        );
        let mut result = None;
        self.native.private_exchange(
            &request,
            &|| self.stop.load(Ordering::SeqCst) != 0,
            Duration::from_secs(45),
            |bytes| {
                if result.is_some() {
                    return Err(FRAME_ERROR.into());
                }
                if let Ok(error) = serde_json::from_slice::<Envelope>(bytes) {
                    if error.schema_version != 2
                        || error.request_id != id
                        || error.sequence != 1
                        || error.kind != "error"
                    {
                        return Err(FRAME_ERROR.into());
                    }
                    return Err(match error.error_code.as_deref() {
                        Some("LUA_WORKSHOP_ACCESS_DENIED") => "LUA_WORKSHOP_ACCESS_DENIED",
                        Some("LUA_STEAM_AUTH_ACCOUNT_CHANGED") => "LUA_STEAM_AUTH_ACCOUNT_CHANGED",
                        Some("LUA_STEAM_AUTH_REJECTED") => "LUA_STEAM_AUTH_REJECTED",
                        Some("LUA_STEAM_AUTH_TIMEOUT") => "LUA_STEAM_AUTH_TIMEOUT",
                        _ => "LUA_STEAM_AUTH_FAILED",
                    }
                    .into());
                }
                let details: AuthenticatedDetails =
                    serde_json::from_slice(bytes).map_err(|_| FRAME_ERROR)?;
                validate_details(&details, &id, &self.credential.steam_id, appid, item_id)?;
                result = Some(details);
                Ok(())
            },
        )?;
        result.ok_or_else(|| FRAME_ERROR.into())
    }
}

fn validate_details(
    value: &AuthenticatedDetails,
    request: &str,
    steam_id: &str,
    appid: u32,
    item_id: &str,
) -> Result<(), String> {
    if value.schema_version != 2
        || value.request_id != request
        || value.sequence != 1
        || value.kind != "details"
        || value.steam_id != steam_id
        || value.appid != appid
        || value.item_id != item_id
        || value.title.chars().count() > 256
        || value.title.chars().any(char::is_control)
        || value.content_url.len() > 4096
        || value.manifest_id.parse::<u64>().is_err()
    {
        return Err(FRAME_ERROR.into());
    }
    Ok(())
}

#[tauri::command]
pub async fn lua_get_steam_auth_status(app: AppHandle) -> Result<AuthStatus, String> {
    tauri::async_runtime::spawn_blocking(move || {
        with_broker(&app, |broker| Ok(broker.status.clone()))
    })
    .await
    .map_err(|_| "LUA_STEAM_AUTH_FAILED")?
}

#[tauri::command]
pub async fn lua_begin_steam_qr_login(app: AppHandle) -> Result<AuthStatus, String> {
    tauri::async_runtime::spawn_blocking(move || {
        with_broker(&app, |broker| {
            if broker.active || broker.disconnecting || broker.operation_stop.is_some() {
                return Err("LUA_STEAM_AUTH_BUSY".into());
            }
            // A corrupted/moved vault requires explicit Forget, not an implicit overwrite.
            read_vault(&broker.path)?;
            let id = uuid::Uuid::new_v4().to_string();
            let stop = Arc::new(AtomicBool::new(false));
            broker.stop = stop.clone();
            broker.active = true;
            broker.status.phase = "connecting".into();
            broker.status.attempt_id = Some(id.clone());
            broker.status.error_code = None;
            broker.status.qr_image = None;
            broker.status.expires_at = Some(chrono::Utc::now().timestamp() + 180);
            let native = broker.native.clone();
            let worker_app = app.clone();
            let worker = std::thread::Builder::new()
                .name("lua-steam-auth".into())
                .spawn(move || {
                    let mut frames = LoginFrames {
                        sequence: 0,
                        credential: None,
                        terminal: false,
                    };
                    let request =
                        serde_json::json!({"schemaVersion":2,"requestId":id,"operation":"qrLogin"})
                            .to_string();
                    let result = native
                        .private_exchange(
                            request.as_bytes(),
                            &|| stop.load(Ordering::SeqCst),
                            Duration::from_secs(185),
                            |bytes| {
                                if let Some(image) = frames.accept(bytes, &id)? {
                                    with_broker(&worker_app, |broker| {
                                        if broker.status.attempt_id.as_deref() == Some(&id)
                                            && !broker.stop.load(Ordering::SeqCst)
                                        {
                                            broker.status.phase = "awaitingConfirmation".into();
                                            broker.status.qr_image = Some(image);
                                        }
                                        Ok(())
                                    })?;
                                }
                                Ok(())
                            },
                        )
                        .and_then(|_| {
                            frames
                                .credential
                                .take()
                                .ok_or_else(|| FRAME_ERROR.to_string())
                        });
                    let _ = with_broker(&worker_app, |broker| {
                        finish_login(broker, &id, result);
                        Ok(())
                    });
                });
            match worker {
                Ok(worker) => broker.worker = Some(worker),
                Err(_) => {
                    broker.active = false;
                    broker.status.phase = "failed".into();
                    broker.status.expires_at = None;
                    return Err("LUA_STEAM_AUTH_FAILED".into());
                }
            }
            Ok(broker.status.clone())
        })
    })
    .await
    .map_err(|_| "LUA_STEAM_AUTH_FAILED")?
}

#[tauri::command]
pub async fn lua_cancel_steam_qr_login(
    app: AppHandle,
    attempt_id: String,
) -> Result<AuthStatus, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let worker = with_broker(&app, |broker| {
            if broker.status.attempt_id.as_deref() != Some(&attempt_id) || !broker.active {
                return Ok(None);
            }
            broker.stop.store(true, Ordering::SeqCst);
            broker.status.qr_image = None;
            Ok(broker.worker.take())
        })?;
        if let Some(worker) = worker {
            let _ = worker.join();
        }
        with_broker(&app, |broker| Ok(broker.status.clone()))
    })
    .await
    .map_err(|_| "LUA_STEAM_AUTH_FAILED")?
}

#[tauri::command]
pub async fn lua_disconnect_steam_workshop(app: AppHandle) -> Result<AuthStatus, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let worker = with_broker(&app, |broker| {
            if broker.disconnecting {
                return Err("LUA_STEAM_AUTH_BUSY".into());
            }
            broker.disconnecting = true;
            broker.stop.store(true, Ordering::SeqCst);
            if let Some(stop) = &broker.operation_stop {
                stop.store(2, Ordering::SeqCst);
            }
            broker.status.qr_image = None;
            Ok(broker.worker.take())
        })?;
        if let Some(worker) = worker {
            let _ = worker.join();
        }
        with_broker(&app, |broker| {
            let removed: Result<(), String> = (|| {
                crate::lua_workshop::reject_reparse_ancestors(&broker.path)?;
                match fs::remove_file(&broker.path) {
                    Ok(()) => Ok(()),
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
                    Err(_) => Err("LUA_STEAM_AUTH_VAULT_WRITE_FAILED".into()),
                }
            })();
            broker.disconnecting = false;
            removed?;
            broker.status = AuthStatus {
                phase: "idle".into(),
                account: None,
                attempt_id: None,
                qr_image: None,
                expires_at: None,
                error_code: None,
            };
            Ok(broker.status.clone())
        })
    })
    .await
    .map_err(|_| "LUA_STEAM_AUTH_FAILED")?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn authenticated_details_cannot_change_request_account_app_or_item() {
        let bytes = br#"{"schemaVersion":2,"requestId":"request","sequence":1,"kind":"details","steamId":"76561198000000001","appid":4000,"itemId":"123","title":"Fixture","sizeBytes":42,"updatedAt":123456,"contentUrl":"https://steamusercontent.com/file","manifestId":"0","fileType":0}"#;
        let details: AuthenticatedDetails = serde_json::from_slice(bytes).unwrap();
        assert!(validate_details(&details, "request", "76561198000000001", 4000, "123").is_ok());
        assert!(validate_details(&details, "other", "76561198000000001", 4000, "123").is_err());
        assert!(validate_details(&details, "request", "76561198000000002", 4000, "123").is_err());
        assert!(validate_details(&details, "request", "76561198000000001", 480, "123").is_err());
        assert!(validate_details(&details, "request", "76561198000000001", 4000, "999").is_err());
    }

    #[test]
    #[ignore = "Contacts Steam to obtain an ephemeral QR challenge, then cancels without login"]
    fn live_qr_challenge_then_cancel_without_account() {
        let native = NativeBridge::new(
            PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources/lua-steamkit"),
        );
        let stop = AtomicBool::new(false);
        let mut frames = LoginFrames {
            sequence: 0,
            credential: None,
            terminal: false,
        };
        let started = std::time::Instant::now();
        let result = native.private_exchange(
            br#"{"schemaVersion":2,"requestId":"qr-cancel-smoke","operation":"qrLogin"}"#,
            &|| stop.load(Ordering::SeqCst),
            Duration::from_secs(40),
            |bytes| {
                if frames.accept(bytes, "qr-cancel-smoke")?.is_some() {
                    stop.store(true, Ordering::SeqCst);
                }
                Ok(())
            },
        );
        assert_eq!(result.unwrap_err(), "LUA_STEAM_AUTH_CANCELLED");
        assert!(frames.sequence > 0 && frames.credential.is_none());
        assert!(started.elapsed() < Duration::from_secs(45));
        println!("Verified pinned SteamKit QR challenge, request binding, cancel and child teardown; no account/token was obtained or stored.");
    }
    fn credential() -> Credential {
        Credential {
            account_id: uuid::Uuid::new_v4().to_string(),
            steam_id: "76561198000000001".into(),
            account_name: Zeroizing::new("fixture_account".into()),
            refresh_token: Zeroizing::new("fixture_refresh_token_not_real".into()),
        }
    }
    fn broker(path: PathBuf) -> Broker {
        Broker {
            path,
            native: NativeBridge::new(PathBuf::new()),
            status: AuthStatus {
                phase: "connecting".into(),
                attempt_id: Some("attempt".into()),
                account: Some(credential().public()),
                qr_image: None,
                expires_at: None,
                error_code: None,
            },
            stop: Arc::new(AtomicBool::new(false)),
            worker: None,
            active: true,
            disconnecting: false,
            operation_stop: None,
        }
    }
    #[test]
    fn auth_frames_bind_identity_sequence_and_hide_credentials() {
        let mut frames = LoginFrames {
            sequence: 0,
            credential: None,
            terminal: false,
        };
        let frame = br#"{"schemaVersion":2,"requestId":"r","sequence":1,"kind":"challenge","challengeUrl":"https://s.team/q/1/123"}"#;
        assert!(frames.accept(frame, "wrong").is_err());
        assert!(frames
            .accept(frame, "r")
            .unwrap()
            .unwrap()
            .starts_with("data:image/svg+xml;base64,"));
        assert!(frames.accept(frame, "r").is_err());
        let mixed = br#"{"schemaVersion":2,"requestId":"r","sequence":2,"kind":"challenge","challengeUrl":"https://s.team/q/1/123","refreshToken":"secret"}"#;
        assert!(frames.accept(mixed, "r").is_err());
        for value in [
            "https://s.team.evil.test/q/1",
            "http://s.team/q/1",
            "https://s.team/q/1?secret=x",
            "https://s.team:444/q/1",
        ] {
            assert!(qr_image(value).is_err());
        }
        let public = serde_json::to_string(&broker(PathBuf::new()).status).unwrap();
        for secret in [
            "refreshToken",
            "accountName",
            "fixture_refresh",
            "fixture_account",
        ] {
            assert!(!public.contains(secret));
        }
    }
    #[test]
    #[cfg(windows)]
    fn vault_is_encrypted_and_failed_or_cancelled_login_preserves_previous_bytes() {
        let root = std::env::temp_dir().join(format!("oxo-lua-auth-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&root).unwrap();
        let path = root.join("steam-workshop.dpapi");
        let first = credential();
        save_vault(&path, &first).unwrap();
        let encrypted = fs::read(&path).unwrap();
        assert!(!encrypted
            .windows(first.refresh_token.len())
            .any(|bytes| bytes == first.refresh_token.as_bytes()));
        assert_eq!(
            read_vault(&path).unwrap().unwrap().account_id,
            first.account_id
        );
        let mut state = broker(path.clone());
        finish_login(&mut state, "attempt", Err("LUA_STEAM_AUTH_FAILED".into()));
        assert_eq!(fs::read(&path).unwrap(), encrypted);
        state.stop.store(true, Ordering::SeqCst);
        finish_login(&mut state, "attempt", Ok(credential()));
        assert_eq!(state.status.phase, "cancelled");
        assert_eq!(fs::read(&path).unwrap(), encrypted);
        state.stop.store(false, Ordering::SeqCst);
        let second = credential();
        let second_id = second.account_id.clone();
        finish_login(&mut state, "stale-attempt", Ok(second));
        assert_eq!(fs::read(&path).unwrap(), encrypted);
        finish_login(&mut state, "attempt", Ok(credential()));
        assert_ne!(
            read_vault(&path).unwrap().unwrap().account_id,
            first.account_id
        );
        assert_ne!(state.status.account.as_ref().unwrap().account_id, second_id);
        fs::remove_file(path).unwrap();
        fs::remove_dir(root).unwrap();
    }
}
