//! Read-only evidence for Steam's sync warning. Never reset a save/cache to hide it.
use std::collections::BTreeMap;
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;
use std::sync::OnceLock;

use regex::Regex;
use serde::{Deserialize, Serialize};

pub const DEPLOYED_DLL: &str = "0xoCloudRedirect.dll";
pub const LEGACY_DLL: &str = "cloud_redirect.dll";
const MAX_LOG_BYTES: u64 = 256 * 1024;
const MAX_REDACTION_BYTES: usize = 8192;
const MAX_CLASSIFICATION_LINES: usize = 2000;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CloudSyncObservation {
    pub app_id: u32,
    pub state: String,
    pub reason: String,
    pub observed_at: String,
}

/// Do not expose OAuth headers, query strings, account identifiers or save paths.
pub fn redact_log_line(line: &str) -> String {
    static SENSITIVE: OnceLock<Regex> = OnceLock::new();
    static URL: OnceLock<Regex> = OnceLock::new();
    static ACCOUNT: OnceLock<Regex> = OnceLock::new();
    static ACCOUNT_FIELD: OnceLock<Regex> = OnceLock::new();
    static STEAM_ID64: OnceLock<Regex> = OnceLock::new();
    static PATH: OnceLock<Regex> = OnceLock::new();
    // Omit rather than truncate before scanning: a cut inside a credential key
    // could otherwise expose its value, and CLI stderr is not inherently bounded.
    if line.len() > MAX_REDACTION_BYTES {
        return "[oversized log line omitted]".to_string();
    }
    if SENSITIVE.get_or_init(|| Regex::new(
        r"(?i)\b(?:authorization|access[_-]?token|refresh[_-]?token|client[_-]?secret|api[_-]?key|secret[_-]?access[_-]?key|bearer|token|password|passwd|cookie|set-cookie|x-amz-(?:signature|security-token|credential))\b"
    ).unwrap()).is_match(line) {
        return "[sensitive log line omitted]".to_string();
    }
    let line = URL
        .get_or_init(|| Regex::new(r#"(?i)https?://[^\s\"'<>]+"#).unwrap())
        .replace_all(line, "[URL omitted]");
    let line = ACCOUNT
        .get_or_init(|| Regex::new(r"(?i)\[U:\d+:\d+\]").unwrap())
        .replace_all(&line, "[account]");
    let line = ACCOUNT_FIELD
        .get_or_init(|| {
            Regex::new(
                r#"(?i)\b(?:account[_-]?id|steam[_-]?id(?:64)?)\b[\"']?\s*[:=]\s*[\"']?[^,\s\"']+"#,
            )
            .unwrap()
        })
        .replace_all(&line, "[account omitted]");
    let line = STEAM_ID64
        .get_or_init(|| Regex::new(r"\b7656119\d{10}\b").unwrap())
        .replace_all(&line, "[account]");
    // Native Steam messages can include user/save filenames; keep only the diagnosis.
    let line = PATH
        .get_or_init(|| Regex::new(r#"(?:[A-Za-z]:[\\/]|\\\\|//)[^\r\n\"']*"#).unwrap())
        .replace_all(&line, "[path omitted]");
    line.chars().take(512).collect()
}

pub fn read_log_tail(path: &Path, limit: usize) -> Result<Vec<String>, String> {
    let mut file =
        File::open(path).map_err(|error| format!("Cannot read diagnostic log: {error}"))?;
    let length = file.metadata().map_err(|error| error.to_string())?.len();
    let offset = length.saturating_sub(MAX_LOG_BYTES);
    file.seek(SeekFrom::Start(offset))
        .map_err(|error| error.to_string())?;
    let mut bytes = Vec::new();
    file.take(MAX_LOG_BYTES)
        .read_to_end(&mut bytes)
        .map_err(|error| error.to_string())?;
    let text = String::from_utf8_lossy(&bytes);
    let mut lines = text.lines().collect::<Vec<_>>();
    if offset > 0 && !lines.is_empty() {
        lines.remove(0);
    }
    Ok(lines[lines.len().saturating_sub(limit)..]
        .iter()
        .map(|line| redact_log_line(line))
        .collect())
}

/// A quota check or an empty cache is NOT evidence that game saves were synced.
/// Later messages replace earlier observations for the same AppID.
pub fn classify_cloud_log(lines: &[String]) -> Vec<CloudSyncObservation> {
    static APP: OnceLock<Regex> = OnceLock::new();
    static NEGATED: OnceLock<Regex> = OnceLock::new();
    static CONFLICT: OnceLock<Regex> = OnceLock::new();
    static FAILURE: OnceLock<Regex> = OnceLock::new();
    let app = APP.get_or_init(|| Regex::new(r"\[AppID (\d+)\]").unwrap());
    let negated = NEGATED.get_or_init(|| Regex::new(
        r"(?i)\b(?:no (?:save |sync |cloud |file )?(?:conflicts?|errors?|failures?)|0 (?:conflicts?|errors?|failures?)|(?:conflicts?|errors?(?: code)?|failed|failures?)(?:\s*[:=]\s*|\s+)(?:0|false)\b|(?:save |sync |cloud |file )?conflicts? (?:resolved|cleared))\b"
    ).unwrap());
    let conflict = CONFLICT.get_or_init(|| Regex::new(
        r"(?i)\b(?:conflicts? (?:detected|found)|(?:unresolved|unhandled|save|sync|cloud|file) conflicts?|detected (?:a )?conflict|conflicts?\s*[:=]\s*[1-9]\d*)\b"
    ).unwrap());
    let failure = FAILURE.get_or_init(|| Regex::new(
        r"(?i)\b(?:failed (?:to )?(?:sync|upload|download|read|write)\b|(?:sync|upload|download|read|write)(?: operation)? (?:has )?failed\b|(?:sync|cloud) error\b|(?:errors?(?: code)?|failures?)\s*[:=]\s*[1-9]\d*\b)"
    ).unwrap());
    let mut latest = BTreeMap::new();
    for line in lines.iter().rev().take(MAX_CLASSIFICATION_LINES).rev() {
        if line.len() > MAX_REDACTION_BYTES {
            continue;
        }
        let Some(captures) = app.captures(line) else {
            continue;
        };
        let Ok(app_id) = captures[1].parse::<u32>() else {
            continue;
        };
        let message = &line[captures.get(0).unwrap().end()..];
        // Negated/zero counters are not failures, but must not hide a separate
        // real failure on the same line or clear a prior failure observation.
        let lower = negated.replace_all(message, "").to_ascii_lowercase();
        let observation = if lower.contains("failed sync") && lower.contains("login=false") {
            Some(("failed", "steamNotLoggedIn"))
        } else if conflict.is_match(&lower) {
            Some(("failed", "saveConflict"))
        } else if failure.is_match(&lower) {
            Some(("failed", "syncFailed"))
        } else if lower.contains("successfully synced to changenumber") {
            Some(("synced", "steamReportedSyncComplete"))
        } else if lower.contains("need to sync from")
            || (lower.contains("starting sync") && !lower.contains("quota"))
        {
            Some(("pending", "syncNotConfirmed"))
        } else {
            None
        };
        if let Some((state, reason)) = observation {
            let observed_at = line
                .strip_prefix('[')
                .and_then(|line| line.split_once(']'))
                .map(|(stamp, _)| stamp)
                .unwrap_or("");
            latest.insert(
                app_id,
                CloudSyncObservation {
                    app_id,
                    state: state.into(),
                    reason: reason.into(),
                    observed_at: observed_at.into(),
                },
            );
        }
    }
    latest.into_values().collect()
}

pub fn deployment_detail(steam: &Path) -> (&'static str, String) {
    match (steam.join(DEPLOYED_DLL).is_file(), steam.join(LEGACY_DLL).is_file()) {
        (true, true) => ("warning", format!("Both {DEPLOYED_DLL} and {LEGACY_DLL} exist. Loader ownership is ambiguous; do not reinstall or remove either automatically.")),
        (true, false) => ("ok", format!("{DEPLOYED_DLL} is present. This does not prove the Steam hook loaded or a cloud sync succeeded.")),
        (false, true) => ("warning", format!("Only legacy {LEGACY_DLL} is present; the launcher-managed DLL is {DEPLOYED_DLL}. No files were changed.")),
        (false, false) => ("warning", format!("{DEPLOYED_DLL} is not installed. A Steam Cloud error alone is not a reason to install patches.")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sync_failure_is_resolved_only_by_later_game_sync_evidence() {
        let lines = [
            "[2026-09-04 10:00:00] [AppID 42] Failed sync for down [login=false]",
            "[2026-09-04 10:00:01] [AppID 760] GetAppQuotaUsage - Success",
            "[2026-09-04 10:00:02] [AppID 42] YldWriteCacheDirectoryToFile - empty vector",
        ]
        .map(str::to_string);
        assert_eq!(classify_cloud_log(&lines)[0].reason, "steamNotLoggedIn");
        let mut lines = lines.to_vec();
        lines.push("[2026-09-04 10:01:00] [AppID 42] Successfully synced to ChangeNumber 9".into());
        assert_eq!(classify_cloud_log(&lines)[0].state, "synced");
    }

    #[test]
    fn pending_evaluation_does_not_claim_success_or_missing_save() {
        let states = classify_cloud_log(&["[2026-09-04 10:05:14] [AppID 2050650] Need to sync from local change number '0' to global change number '0' (full), but not attempting now".into()]);
        assert_eq!(states[0].state, "pending");
    }

    #[test]
    fn logs_are_redacted_before_exposure() {
        assert!(!redact_log_line("Authorization: Bearer private-value").contains("private-value"));
        assert!(
            !redact_log_line("GET https://example.test/sync?token=private-value")
                .contains("private-value")
        );
        assert!(
            !redact_log_line("[U:1:123456789] saved to 'C:/private/save.dat'")
                .contains("123456789")
        );
        assert!(!redact_log_line("saved to 'C:/private/save.dat'").contains("private"));
    }

    #[test]
    fn credential_variants_are_omitted_without_exposing_values() {
        for line in [
            "token=fixture-secret",
            "password=fixture-secret",
            "Cookie: sid=fixture-secret",
            "Set-Cookie: sid=fixture-secret",
            "X-Amz-Signature=fixture-secret",
            r#"{"clientSecret":"fixture-secret"}"#,
            "accessToken=fixture-secret",
        ] {
            assert_eq!(redact_log_line(line), "[sensitive log line omitted]");
        }
    }

    #[test]
    fn unc_paths_and_account_formats_are_redacted() {
        for line in [
            r"saved to \\private-server\private-share\save.dat",
            "saved to //private-server/private-share/save.dat",
            "Steam user 76561198012345678",
            "account_id=private-account",
            r#"{"accountId":"private-account"}"#,
            "SteamID64: 76561198012345678",
        ] {
            let redacted = redact_log_line(line);
            assert!(!redacted.contains("private"), "{redacted}");
            assert!(!redacted.contains("76561198012345678"), "{redacted}");
        }
        assert!(redact_log_line("[AppID 2067920] Starting sync").contains("2067920"));
    }

    #[test]
    fn redaction_rejects_oversized_lines_before_allocating_copies() {
        assert_eq!(
            redact_log_line(&"x".repeat(MAX_REDACTION_BYTES + 1)),
            "[oversized log line omitted]"
        );
    }

    #[test]
    fn zero_negated_and_resolved_markers_are_not_sync_failures() {
        for detail in [
            "No conflicts detected",
            "No save conflicts found",
            "conflicts=0",
            "errors=0",
            "Error code: 0",
            "Sync error code 0",
            "0 errors",
            "failed=false",
            "Save conflict resolved",
            "No errors",
            "enumerated errors.txt",
            "conflict checking enabled",
        ] {
            let lines = vec![format!("[2026-09-04 11:00:00] [AppID 42] {detail}")];
            assert!(classify_cloud_log(&lines).is_empty(), "{detail}");
        }
    }

    #[test]
    fn explicit_failures_remain_even_alongside_zero_counters() {
        for detail in [
            "Sync failed: unavailable",
            "Failed to upload file",
            "errors=2",
            "No conflicts, sync failed",
        ] {
            let lines = vec![format!("[2026-09-04 11:00:00] [AppID 42] {detail}")];
            assert_eq!(
                classify_cloud_log(&lines)[0].reason,
                "syncFailed",
                "{detail}"
            );
        }
        let lines = vec!["[2026-09-04 11:00:00] [AppID 42] Conflict detected".into()];
        assert_eq!(classify_cloud_log(&lines)[0].reason, "saveConflict");
    }

    #[test]
    fn negated_lines_do_not_clear_a_prior_failure() {
        let lines = [
            "[2026-09-04 11:00:00] [AppID 42] Sync failed: unavailable",
            "[2026-09-04 11:00:01] [AppID 42] No conflicts; errors=0",
        ]
        .map(str::to_string);
        assert_eq!(classify_cloud_log(&lines)[0].state, "failed");
        let mut lines = lines.to_vec();
        lines.push(
            "[2026-09-04 11:00:02] [AppID 42] Successfully synced to ChangeNumber 9; errors=0"
                .into(),
        );
        assert_eq!(classify_cloud_log(&lines)[0].state, "synced");
    }

    #[test]
    fn canonical_dll_is_detected_without_creating_or_changing_files() {
        let root =
            std::env::temp_dir().join(format!("oxo-cloud-diagnostic-{}", uuid::Uuid::new_v4()));
        assert_eq!(deployment_detail(&root).0, "warning");
        assert!(!root.exists());
        std::fs::create_dir(&root).unwrap();
        std::fs::write(root.join(DEPLOYED_DLL), b"fixture").unwrap();
        assert_eq!(deployment_detail(&root).0, "ok");
        assert_eq!(std::fs::read(root.join(DEPLOYED_DLL)).unwrap(), b"fixture");
        std::fs::write(root.join(LEGACY_DLL), b"foreign fixture").unwrap();
        assert_eq!(deployment_detail(&root).0, "warning");
        std::fs::remove_file(root.join(DEPLOYED_DLL)).unwrap();
        std::fs::remove_file(root.join(LEGACY_DLL)).unwrap();
        std::fs::remove_dir(root).unwrap();
    }

    #[test]
    fn log_read_is_bounded_and_missing_path_stays_missing() {
        let path =
            std::env::temp_dir().join(format!("oxo-cloud-tail-{}.txt", uuid::Uuid::new_v4()));
        assert!(read_log_tail(&path, 10).is_err());
        assert!(!path.exists());
        std::fs::write(&path, format!("{}\nlast line\n", "x".repeat(300_000))).unwrap();
        assert_eq!(read_log_tail(&path, 1).unwrap(), vec!["last line"]);
        std::fs::remove_file(path).unwrap();
    }
}
