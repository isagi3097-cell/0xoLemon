use crate::cloud_redirect::steam_detector::{
    find_steam_path, get_steam_version, is_steam_running, try_steam_process_ids,
    SUPPORTED_STEAM_VERSIONS,
};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::fs;
use std::fs::OpenOptions;
use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Mutex, OnceLock};
use tauri::{AppHandle, Emitter, Manager};

use super::models::{MigrationEvent, ENGINE_VERSION};

static OPERATION_LOCK: OnceLock<Mutex<()>> = OnceLock::new();
static RUNTIME_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

fn operation_lock() -> &'static Mutex<()> {
    OPERATION_LOCK.get_or_init(|| Mutex::new(()))
}

fn runtime_lock() -> &'static Mutex<()> {
    RUNTIME_LOCK.get_or_init(|| Mutex::new(()))
}

pub fn with_operation_lock<T>(operation: impl FnOnce() -> Result<T, String>) -> Result<T, String> {
    let _guard = operation_lock()
        .lock()
        .map_err(|_| "CloudRedirect operation lock is poisoned".to_string())?;
    operation()
}

fn engine_resource_candidates(app: &AppHandle) -> Vec<PathBuf> {
    let mut candidates = Vec::new();
    if let Ok(resource_dir) = app.path().resource_dir() {
        candidates.push(
            resource_dir
                .join("resources")
                .join("cloud_redirect")
                .join("engine")
                .join(ENGINE_VERSION),
        );
        candidates.push(
            resource_dir
                .join("cloud_redirect")
                .join("engine")
                .join(ENGINE_VERSION),
        );
        candidates.push(resource_dir.join("engine").join(ENGINE_VERSION));
    }
    if let Ok(current_dir) = std::env::current_dir() {
        candidates.push(
            current_dir
                .join("src-tauri")
                .join("resources")
                .join("cloud_redirect")
                .join("engine")
                .join(ENGINE_VERSION),
        );
        candidates.push(
            current_dir
                .join("resources")
                .join("cloud_redirect")
                .join("engine")
                .join(ENGINE_VERSION),
        );
    }
    candidates
}

pub fn source_engine_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let required = [
        "0xoCloudRedirect.dll",
        "cloud_redirect_cli.exe",
        "cloud760_tool.exe",
    ];
    for candidate in engine_resource_candidates(app) {
        if required.iter().all(|name| candidate.join(name).is_file()) {
            return Ok(candidate);
        }
    }
    Err(format!(
        "CloudRedirect {} runtime was not built. Run src-tauri/build-cloudredirect.ps1 before packaging.",
        ENGINE_VERSION
    ))
}

fn atomic_copy(source: &Path, destination: &Path) -> Result<(), String> {
    let parent = destination
        .parent()
        .ok_or_else(|| format!("Invalid destination: {}", destination.display()))?;
    fs::create_dir_all(parent)
        .map_err(|error| format!("Cannot create {}: {error}", parent.display()))?;

    let temporary = destination.with_extension("0xolemon-new");
    let rollback = destination.with_extension("0xolemon-prev");
    let _ = fs::remove_file(&temporary);
    let _ = fs::remove_file(&rollback);

    fs::copy(source, &temporary).map_err(|error| {
        format!(
            "Cannot copy {} to {}: {error}",
            source.display(),
            temporary.display()
        )
    })?;
    // On Windows File::open() yields a read-only handle. File::sync_all() maps
    // to FlushFileBuffers, which requires write access and otherwise returns
    // ERROR_ACCESS_DENIED (os error 5). Re-open the staged artifact with a
    // write-capable handle before flushing it.
    OpenOptions::new()
        .write(true)
        .open(&temporary)
        .and_then(|file| file.sync_all())
        .map_err(|error| format!("Cannot sync {}: {error}", temporary.display()))?;

    let had_destination = destination.is_file();
    if had_destination {
        fs::rename(destination, &rollback).map_err(|error| {
            format!(
                "Cannot prepare rollback for {}: {error}",
                destination.display()
            )
        })?;
    }

    if let Err(error) = fs::rename(&temporary, destination) {
        if had_destination {
            let _ = fs::rename(&rollback, destination);
        }
        let _ = fs::remove_file(&temporary);
        return Err(format!(
            "Cannot commit {} to {}: {error}",
            temporary.display(),
            destination.display()
        ));
    }

    if had_destination {
        let _ = fs::remove_file(&rollback);
    }
    Ok(())
}

pub fn runtime_engine_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let app_data = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?;
    Ok(app_data
        .join("cloud_redirect")
        .join("engine")
        .join(ENGINE_VERSION))
}

fn file_sha256(path: &Path) -> Result<Vec<u8>, String> {
    let mut file =
        fs::File::open(path).map_err(|error| format!("Cannot read {}: {error}", path.display()))?;
    let mut hash = Sha256::new();
    let mut buffer = [0u8; 64 * 1024];
    loop {
        let count = file.read(&mut buffer).map_err(|error| error.to_string())?;
        if count == 0 {
            break;
        }
        hash.update(&buffer[..count]);
    }
    Ok(hash.finalize().to_vec())
}

/// Byte consistency only: this does not establish upstream provenance or Steam compatibility.
fn inspect_runtime_at(source: &Path, runtime: &Path) -> Result<(), String> {
    for name in [
        "0xoCloudRedirect.dll",
        "cloud_redirect_cli.exe",
        "cloud760_tool.exe",
    ] {
        if file_sha256(&source.join(name))? != file_sha256(&runtime.join(name))? {
            return Err(format!("CloudRedirect runtime artifact differs from the bundled artifact: {name}. Use an explicit install/update; status did not replace any files."));
        }
    }
    Ok(())
}

pub fn inspect_runtime(app: &AppHandle) -> Result<PathBuf, String> {
    let source = source_engine_dir(app)?;
    let runtime = runtime_engine_dir(app)?;
    inspect_runtime_at(&source, &runtime)?;
    Ok(runtime)
}

pub(super) fn validate_install_version(version: Option<i64>) -> Result<(), String> {
    if !version.is_some_and(|version| SUPPORTED_STEAM_VERSIONS.contains(&version)) {
        return Err("Steam build is unknown or not verified with the bundled CloudRedirect engine. Installation is blocked; no runtime, config or Steam file was changed.".into());
    }
    Ok(())
}

pub fn ensure_runtime(app: &AppHandle) -> Result<PathBuf, String> {
    let _guard = runtime_lock()
        .lock()
        .map_err(|_| "CloudRedirect runtime lock is poisoned".to_string())?;
    let source = source_engine_dir(app)?;
    let runtime = runtime_engine_dir(app)?;
    prepare_runtime_at(&source, &runtime)?;
    Ok(runtime)
}

/// The explicit preparation path repairs content drift, including changes that
/// preserve size and mtime. File metadata is not an artifact identity check.
fn prepare_runtime_at(source: &Path, runtime: &Path) -> Result<(), String> {
    let mut artifacts = Vec::new();
    for name in [
        "0xoCloudRedirect.dll",
        "cloud_redirect_cli.exe",
        "cloud760_tool.exe",
    ] {
        artifacts.push((name, file_sha256(&source.join(name))?));
    }
    match fs::metadata(source.join("engine.json")) {
        Ok(metadata) if metadata.is_file() => {
            artifacts.push(("engine.json", file_sha256(&source.join("engine.json"))?));
        }
        Ok(_) => return Err("Bundled CloudRedirect engine.json is not a file".into()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(format!("Cannot inspect bundled engine.json: {error}")),
    }

    // Resolve every source digest before mutating the runtime; a partial bundle
    // must not create an apparently ready runtime directory.
    fs::create_dir_all(runtime)
        .map_err(|error| format!("Cannot create engine directory: {error}"))?;

    for (name, expected_hash) in &artifacts {
        let source_file = source.join(name);
        let destination = runtime.join(name);
        let must_copy = match fs::metadata(&destination) {
            Ok(metadata) if metadata.is_file() => file_sha256(&destination)? != *expected_hash,
            Ok(_) => {
                return Err(format!(
                    "CloudRedirect runtime target is not a file: {name}"
                ))
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => true,
            Err(error) => {
                return Err(format!(
                    "Cannot inspect runtime artifact {}: {error}",
                    destination.display()
                ))
            }
        };
        if must_copy {
            atomic_copy(&source_file, &destination)?;
        }
        if file_sha256(&destination)? != *expected_hash {
            return Err(format!("CloudRedirect runtime artifact failed post-copy verification: {name}. Runtime is not ready."));
        }
    }
    // Also detect the bundled source changing while its artifacts were copied.
    for (name, expected_hash) in artifacts {
        if file_sha256(&source.join(name))? != expected_hash {
            return Err(format!("Bundled CloudRedirect artifact changed during preparation: {name}. Retry the explicit update."));
        }
    }
    Ok(())
}

pub fn install_dll(app: &AppHandle) -> Result<PathBuf, String> {
    with_operation_lock(|| {
        if !try_steam_process_ids()?.is_empty() {
            return Err(
                "Steam is running. Close Steam before installing CloudRedirect.".to_string(),
            );
        }
        let steam =
            find_steam_path().ok_or_else(|| "Steam installation was not found".to_string())?;
        validate_install_version(get_steam_version(&steam))?;
        let runtime = ensure_runtime(app)?;
        let destination = steam.join("0xoCloudRedirect.dll");
        let runtime_dll = runtime.join("0xoCloudRedirect.dll");
        let expected_hash = file_sha256(&runtime_dll)?;
        atomic_copy(&runtime_dll, &destination)?;
        if file_sha256(&destination)? != expected_hash {
            return Err("Installed CloudRedirect DLL failed post-copy verification".into());
        }
        Ok(destination)
    })
}

pub fn uninstall_dll() -> Result<(), String> {
    with_operation_lock(|| {
        if is_steam_running() {
            return Err("Steam is running. Close Steam before removing CloudRedirect.".to_string());
        }
        let steam =
            find_steam_path().ok_or_else(|| "Steam installation was not found".to_string())?;
        let dll = steam.join("0xoCloudRedirect.dll");
        if dll.exists() {
            fs::remove_file(&dll)
                .map_err(|error| format!("Cannot remove {}: {error}", dll.display()))?;
        }
        Ok(())
    })
}

pub fn run_cli_value(app: &AppHandle, args: &[String]) -> Result<Value, String> {
    let runtime = ensure_runtime(app)?;
    let output = Command::new(runtime.join("cloud_redirect_cli.exe"))
        .args(args)
        .current_dir(&runtime)
        .creation_flags_no_window()
        .output()
        .map_err(|error| format!("Cannot start CloudRedirect CLI: {error}"))?;

    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    parse_cli_output(
        output.status.success(),
        &output.status.to_string(),
        &stdout,
        &stderr,
        args.first().is_some_and(|command| command == "auth-status"),
    )
}

fn parse_cli_output(
    exit_success: bool,
    exit_description: &str,
    stdout: &str,
    stderr: &str,
    auth_observation: bool,
) -> Result<Value, String> {
    if stdout.is_empty() {
        return Err(if stderr.is_empty() {
            format!("CloudRedirect CLI exited with {exit_description}")
        } else {
            super::diagnostics::redact_log_line(stderr)
        });
    }

    let value: Value = serde_json::from_str(stdout)
        .map_err(|error| format!("CloudRedirect returned invalid JSON: {error}"))?;
    // Both process status and an explicit operation result must agree. Authentication
    // false is a valid observation, not permission to mask a failed process.
    if !exit_success || value.get("success").and_then(Value::as_bool) == Some(false) {
        let message = value
            .get("error")
            .and_then(Value::as_str)
            .unwrap_or(if stderr.is_empty() {
                "CloudRedirect operation failed"
            } else {
                &stderr
            });
        return Err(super::diagnostics::redact_log_line(message));
    }
    if auth_observation {
        if value
            .get("authenticated")
            .and_then(Value::as_bool)
            .is_none()
        {
            return Err("CloudRedirect auth-status omitted its authenticated result".into());
        }
    } else if value.get("success").and_then(Value::as_bool) != Some(true) {
        return Err("CloudRedirect operation did not explicitly confirm success".into());
    }
    Ok(value)
}

#[cfg(test)]
mod cli_contract_tests {
    use super::{inspect_runtime_at, parse_cli_output, prepare_runtime_at};

    #[test]
    fn explicit_preparation_repairs_equal_size_and_mtime_drift() {
        let root =
            std::env::temp_dir().join(format!("oxo-runtime-repair-{}", uuid::Uuid::new_v4()));
        let source = root.join("source");
        let runtime = root.join("runtime");
        std::fs::create_dir(&root).unwrap();
        std::fs::create_dir(&source).unwrap();
        std::fs::create_dir(&runtime).unwrap();
        let names = [
            "0xoCloudRedirect.dll",
            "cloud_redirect_cli.exe",
            "cloud760_tool.exe",
            "engine.json",
        ];
        for name in names {
            std::fs::write(source.join(name), b"good").unwrap();
            std::fs::write(runtime.join(name), b"evil").unwrap();
            let original = std::fs::metadata(source.join(name)).unwrap();
            std::fs::File::options()
                .write(true)
                .open(runtime.join(name))
                .unwrap()
                .set_times(std::fs::FileTimes::new().set_modified(original.modified().unwrap()))
                .unwrap();
            let tampered = std::fs::metadata(runtime.join(name)).unwrap();
            assert_eq!(original.len(), tampered.len());
            assert_eq!(original.modified().unwrap(), tampered.modified().unwrap());
        }
        std::fs::write(runtime.join("user-config.json"), b"preserved").unwrap();
        assert!(inspect_runtime_at(&source, &runtime).is_err());
        prepare_runtime_at(&source, &runtime).unwrap();
        assert!(inspect_runtime_at(&source, &runtime).is_ok());
        for name in names {
            assert_eq!(std::fs::read(runtime.join(name)).unwrap(), b"good");
        }
        let before = std::fs::metadata(runtime.join(names[0]))
            .unwrap()
            .modified()
            .unwrap();
        prepare_runtime_at(&source, &runtime).unwrap();
        assert_eq!(
            std::fs::metadata(runtime.join(names[0]))
                .unwrap()
                .modified()
                .unwrap(),
            before
        );
        assert_eq!(
            std::fs::read(runtime.join("user-config.json")).unwrap(),
            b"preserved"
        );
        for name in names {
            std::fs::remove_file(source.join(name)).unwrap();
            std::fs::remove_file(runtime.join(name)).unwrap();
        }
        std::fs::remove_file(runtime.join("user-config.json")).unwrap();
        std::fs::remove_dir(source).unwrap();
        std::fs::remove_dir(runtime).unwrap();
        std::fs::remove_dir(root).unwrap();
    }

    #[test]
    fn incomplete_source_bundle_fails_before_creating_runtime() {
        let root =
            std::env::temp_dir().join(format!("oxo-runtime-incomplete-{}", uuid::Uuid::new_v4()));
        let source = root.join("source");
        let runtime = root.join("runtime");
        std::fs::create_dir(&root).unwrap();
        std::fs::create_dir(&source).unwrap();
        std::fs::write(source.join("0xoCloudRedirect.dll"), b"good").unwrap();
        assert!(prepare_runtime_at(&source, &runtime).is_err());
        assert!(!runtime.exists());
        std::fs::remove_file(source.join("0xoCloudRedirect.dll")).unwrap();
        std::fs::remove_dir(source).unwrap();
        std::fs::remove_dir(root).unwrap();
    }

    #[test]
    fn failed_process_cannot_claim_success_in_json() {
        assert!(parse_cli_output(
            false,
            "exit code: 1",
            r#"{"success":true}"#,
            "network failed",
            false
        )
        .is_err());
    }

    #[test]
    fn failed_operation_cannot_claim_success_via_zero_exit() {
        assert!(parse_cli_output(
            true,
            "exit code: 0",
            r#"{"success":false,"error":"sync failed"}"#,
            "",
            false
        )
        .is_err());
    }

    #[test]
    fn valid_unauthenticated_observation_is_not_a_process_failure() {
        assert_eq!(
            parse_cli_output(true, "exit code: 0", r#"{"authenticated":false}"#, "", true).unwrap()
                ["authenticated"],
            false
        );
    }

    #[test]
    fn incomplete_cli_result_never_becomes_operation_success() {
        for output in [
            "{}",
            "null",
            r#"{"error":"sync failed"}"#,
            r#"{"success":"true"}"#,
            r#"{"authenticated":true}"#,
        ] {
            assert!(
                parse_cli_output(true, "exit code: 0", output, "", false).is_err(),
                "{output}"
            );
        }
        assert!(parse_cli_output(true, "exit code: 0", r#"{"success":true}"#, "", false).is_ok());
        assert!(!parse_cli_output(
            false,
            "exit code: 1",
            "",
            "Authorization: Bearer private-value",
            false
        )
        .unwrap_err()
        .contains("private-value"));
    }

    #[test]
    fn install_refuses_unknown_or_unverified_version() {
        assert!(super::validate_install_version(None).is_err());
        assert!(super::validate_install_version(Some(1788400362)).is_err());
        assert!(super::validate_install_version(Some(super::SUPPORTED_STEAM_VERSIONS[0])).is_ok());
    }

    #[test]
    fn runtime_inspection_is_read_only_and_detects_same_length_tampering() {
        let root =
            std::env::temp_dir().join(format!("oxo-runtime-inspect-{}", uuid::Uuid::new_v4()));
        let source = root.join("source");
        let runtime = root.join("runtime");
        assert!(inspect_runtime_at(&source, &runtime).is_err());
        assert!(!root.exists());
        std::fs::create_dir(&root).unwrap();
        std::fs::create_dir(&source).unwrap();
        std::fs::create_dir(&runtime).unwrap();
        let names = [
            "0xoCloudRedirect.dll",
            "cloud_redirect_cli.exe",
            "cloud760_tool.exe",
        ];
        for name in names {
            std::fs::write(source.join(name), b"good").unwrap();
            std::fs::write(runtime.join(name), b"good").unwrap();
        }
        assert!(inspect_runtime_at(&source, &runtime).is_ok());
        std::fs::write(runtime.join(names[0]), b"evil").unwrap();
        assert!(inspect_runtime_at(&source, &runtime).is_err());
        assert_eq!(std::fs::read(runtime.join(names[0])).unwrap(), b"evil");
        for name in names {
            std::fs::remove_file(source.join(name)).unwrap();
            std::fs::remove_file(runtime.join(name)).unwrap();
        }
        std::fs::remove_dir(source).unwrap();
        std::fs::remove_dir(runtime).unwrap();
        std::fs::remove_dir(root).unwrap();
    }
}

pub fn run_migration(
    app: &AppHandle,
    source_provider: &str,
    destination_provider: &str,
) -> Result<MigrationEvent, String> {
    with_operation_lock(|| {
        let runtime = ensure_runtime(app)?;
        let mut child = Command::new(runtime.join("cloud_redirect_cli.exe"))
            .args(["migrate", source_provider, destination_provider])
            .current_dir(&runtime)
            .creation_flags_no_window()
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|error| format!("Cannot start CloudRedirect migration: {error}"))?;

        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| "CloudRedirect migration stdout is unavailable".to_string())?;
        let stderr = child
            .stderr
            .take()
            .ok_or_else(|| "CloudRedirect migration stderr is unavailable".to_string())?;
        let stderr_reader = std::thread::spawn(move || {
            let mut text = String::new();
            let _ = BufReader::new(stderr).read_to_string(&mut text);
            text
        });
        let mut final_event = MigrationEvent::default();
        for line in BufReader::new(stdout).lines() {
            let line = line.map_err(|error| error.to_string())?;
            let value: Value = match serde_json::from_str(&line) {
                Ok(value) => value,
                Err(_) => continue,
            };
            let event = MigrationEvent {
                event_type: value
                    .get("type")
                    .and_then(Value::as_str)
                    .unwrap_or("status")
                    .to_string(),
                phase: string_field(&value, "phase"),
                message: string_field(&value, "message"),
                file: string_field(&value, "file"),
                done: u64_field(&value, "done"),
                total: u64_field(&value, "total"),
                bytes: u64_field(&value, "bytes"),
                migrated: u64_field(&value, "migrated"),
                skipped: u64_field(&value, "skipped"),
                failed: u64_field(&value, "failed"),
                total_bytes: u64_field(&value, "total_bytes"),
            };
            let _ = app.emit("cloudredirect://migration-progress", &event);
            final_event = event;
        }

        let status = child.wait().map_err(|error| error.to_string())?;
        let stderr = stderr_reader
            .join()
            .unwrap_or_else(|_| "CloudRedirect migration stderr reader failed".to_string())
            .trim()
            .to_string();
        if !status.success() {
            if final_event.message.is_none() {
                final_event.message = Some(if stderr.is_empty() {
                    "CloudRedirect migration failed".to_string()
                } else {
                    stderr
                });
            }
            return Err(final_event
                .message
                .clone()
                .unwrap_or_else(|| "CloudRedirect migration failed".to_string()));
        }
        Ok(final_event)
    })
}

fn string_field(value: &Value, key: &str) -> Option<String> {
    value
        .get(key)
        .and_then(Value::as_str)
        .map(ToString::to_string)
}

fn u64_field(value: &Value, key: &str) -> Option<u64> {
    value.get(key).and_then(Value::as_u64)
}

pub fn hide_console(command: &mut Command) {
    command.creation_flags_no_window();
}

#[cfg(target_os = "windows")]
trait CommandWindowExt {
    fn creation_flags_no_window(&mut self) -> &mut Self;
}

#[cfg(target_os = "windows")]
impl CommandWindowExt for Command {
    fn creation_flags_no_window(&mut self) -> &mut Self {
        use std::os::windows::process::CommandExt;
        self.creation_flags(0x08000000)
    }
}

#[cfg(not(target_os = "windows"))]
trait CommandWindowExt {
    fn creation_flags_no_window(&mut self) -> &mut Self;
}

#[cfg(not(target_os = "windows"))]
impl CommandWindowExt for Command {
    fn creation_flags_no_window(&mut self) -> &mut Self {
        self
    }
}
