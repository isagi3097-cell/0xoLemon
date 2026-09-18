use std::fs;
use std::io::{Cursor, Read};
use std::path::{Path, PathBuf};

use zip::ZipArchive;

const METADATA_MAGIC: u32 = 0x1F48_12BE;
const EOF_MAGIC: u32 = 0x32C4_15AB;

pub const MIN_VALID_MANIFEST_BYTES: usize = 64;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ManifestInfo {
    pub depot_id: u64,
    pub manifest_gid: u64,
    pub size_on_disk: u64,
    pub filenames_encrypted: bool,
}

pub fn is_valid_manifest_size(size: u64) -> bool {
    size > (MIN_VALID_MANIFEST_BYTES as u64)
}

pub fn read_manifest(path: &Path) -> Option<ManifestInfo> {
    let metadata = fs::metadata(path).ok()?;
    if !metadata.is_file() || metadata.len() <= (MIN_VALID_MANIFEST_BYTES as u64) {
        return None;
    }
    parse_manifest_bytes(&fs::read(path).ok()?)
}

pub fn matches_manifest_bytes(bytes: &[u8], depot_id: u64, manifest_gid: &str) -> bool {
    if bytes.len() <= MIN_VALID_MANIFEST_BYTES {
        return false;
    }
    let Some(expected_gid) = manifest_gid.parse::<u64>().ok() else {
        return false;
    };
    parse_manifest_bytes(bytes).is_some_and(|info| {
        info.depot_id == depot_id && info.manifest_gid == expected_gid
    })
}

fn parse_manifest_bytes(bytes: &[u8]) -> Option<ManifestInfo> {
    if bytes.len() <= MIN_VALID_MANIFEST_BYTES {
        return None;
    }
    let bytes = if bytes.starts_with(b"PK") {
        let mut archive = ZipArchive::new(Cursor::new(bytes)).ok()?;
        let mut entry = archive.by_index(0).ok()?;
        let mut unwrapped = Vec::new();
        entry.read_to_end(&mut unwrapped).ok()?;
        unwrapped
    } else {
        bytes.to_vec()
    };
    if bytes.len() <= MIN_VALID_MANIFEST_BYTES {
        return None;
    }
    parse_metadata_section(&bytes)
}

pub fn matches_manifest(path: &Path, depot_id: u64, manifest_gid: &str) -> bool {
    let Some(expected_gid) = manifest_gid.parse::<u64>().ok() else {
        return false;
    };
    read_manifest(path).is_some_and(|info| {
        info.depot_id == depot_id && info.manifest_gid == expected_gid
    })
}

pub fn is_valid_manifest_file(path: &Path, depot_id: u64, manifest_gid: &str) -> bool {
    matches_manifest(path, depot_id, manifest_gid)
}

pub fn launcher_vault_depotcache_dir() -> Option<PathBuf> {
    std::env::var_os("APPDATA")
        .map(PathBuf::from)
        .map(|p| p.join("com.0xolemon.launcher").join("depotcache"))
        .or_else(|| {
            std::env::var_os("USERPROFILE")
                .map(PathBuf::from)
                .map(|p| p.join("AppData").join("Roaming").join("com.0xolemon.launcher").join("depotcache"))
        })
}

/// Checks if Steam's depotcache has a valid manifest for this depot.
/// If Steam's copy is missing or <= 1KB / corrupted, but the Launcher's local vault
/// has a verified copy, automatically restores it to Steam's depotcache!
/// Returns true if Steam's depotcache now has a valid copy.
pub fn sync_manifest_vault_to_steam(
    launcher_vault_dir: &Path,
    steam_depotcache_dir: &Path,
    depot_id: u64,
    manifest_gid: &str,
) -> bool {
    let file_name = format!("{}_{}.manifest", depot_id, manifest_gid);
    let steam_target = steam_depotcache_dir.join(&file_name);

    if is_valid_manifest_file(&steam_target, depot_id, manifest_gid) {
        return true;
    }

    let vault_source = launcher_vault_dir.join(&file_name);
    if is_valid_manifest_file(&vault_source, depot_id, manifest_gid) {
        if let Ok(bytes) = fs::read(&vault_source) {
            let _ = fs::create_dir_all(steam_depotcache_dir);
            if crate::lua_live::atomic_write_path(&steam_target, &bytes).is_ok() {
                return true;
            }
        }
    }

    false
}

/// Atomically saves verified manifest bytes into both the Launcher Vault and Steam depotcache.
pub fn persist_manifest_dual(
    launcher_vault_dir: &Path,
    steam_depotcache_dir: &Path,
    depot_id: u64,
    manifest_gid: &str,
    bytes: &[u8],
) -> Result<(), String> {
    if bytes.len() <= MIN_VALID_MANIFEST_BYTES {
        return Err(format!(
            "Manifest bytes for {}_{} too small ({} <= {} bytes)",
            depot_id,
            manifest_gid,
            bytes.len(),
            MIN_VALID_MANIFEST_BYTES
        ));
    }
    if !matches_manifest_bytes(bytes, depot_id, manifest_gid) {
        return Err(format!(
            "Manifest bytes identity mismatch for {}_{}",
            depot_id, manifest_gid
        ));
    }

    let file_name = format!("{}_{}.manifest", depot_id, manifest_gid);
    let vault_path = launcher_vault_dir.join(&file_name);
    let steam_path = steam_depotcache_dir.join(&file_name);

    let _ = fs::create_dir_all(launcher_vault_dir);
    crate::lua_live::atomic_write_path(&vault_path, bytes)
        .map_err(|e| format!("Failed to write manifest to Launcher Vault: {e}"))?;

    let _ = fs::create_dir_all(steam_depotcache_dir);
    let _ = crate::lua_live::atomic_write_path(&steam_path, bytes);

    Ok(())
}

pub fn migrate_legacy_cache(legacy_dir: &Path, real_dir: &Path) -> MigrationResult {
    if same_path(legacy_dir, real_dir) {
        return MigrationResult::default();
    }

    let Ok(entries) = fs::read_dir(legacy_dir) else {
        return MigrationResult::default();
    };

    let mut result = MigrationResult::default();
    for entry in entries.flatten() {
        let source = entry.path();
        if source.extension().and_then(|ext| ext.to_str()) != Some("manifest") {
            continue;
        }

        let Some((depot_id, gid)) = parse_manifest_name(&source) else {
            result.rejected += 1;
            continue;
        };
        let destination = real_dir.join(source.file_name().unwrap_or_default());
        if destination.is_file() {
            result.already_present += 1;
            continue;
        }
        if !matches_manifest(&source, depot_id, &gid) {
            result.rejected += 1;
            continue;
        }

        if fs::create_dir_all(real_dir)
            .and_then(|_| fs::rename(&source, &destination))
            .is_ok()
        {
            result.moved += 1;
        } else {
            result.failed += 1;
        }
    }

    let _ = fs::remove_dir(legacy_dir);
    result
}

#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct MigrationResult {
    pub moved: usize,
    pub already_present: usize,
    pub rejected: usize,
    pub failed: usize,
}

fn parse_metadata_section(data: &[u8]) -> Option<ManifestInfo> {
    let mut offset = 0usize;
    while offset.checked_add(8)? <= data.len() {
        let magic = u32::from_le_bytes(data[offset..offset + 4].try_into().ok()?);
        let length = u32::from_le_bytes(data[offset + 4..offset + 8].try_into().ok()?) as usize;
        offset += 8;
        if magic == EOF_MAGIC {
            return None;
        }
        let end = offset.checked_add(length)?;
        if end > data.len() {
            return None;
        }
        if magic == METADATA_MAGIC {
            return parse_metadata(&data[offset..end]);
        }
        offset = end;
    }
    None
}

fn parse_metadata(data: &[u8]) -> Option<ManifestInfo> {
    let mut offset = 0usize;
    let mut depot_id = 0;
    let mut manifest_gid = 0;
    let mut size_on_disk = 0;
    let mut filenames_encrypted = false;

    while offset < data.len() {
        let tag = read_varint(data, &mut offset)?;
        let field = tag >> 3;
        let wire = tag & 7;
        if wire == 0 {
            let value = read_varint(data, &mut offset)?;
            match field {
                1 => depot_id = value,
                2 => manifest_gid = value,
                4 => filenames_encrypted = value != 0,
                5 => size_on_disk = value,
                _ => {}
            }
        } else {
            skip_field(data, &mut offset, wire)?;
        }
    }

    Some(ManifestInfo { depot_id, manifest_gid, size_on_disk, filenames_encrypted })
}

fn read_varint(data: &[u8], offset: &mut usize) -> Option<u64> {
    let mut value = 0u64;
    let mut shift = 0;
    while *offset < data.len() && shift <= 63 {
        let byte = data[*offset];
        *offset += 1;
        value |= u64::from(byte & 0x7f) << shift;
        if byte & 0x80 == 0 {
            return Some(value);
        }
        shift += 7;
    }
    None
}

fn skip_field(data: &[u8], offset: &mut usize, wire: u64) -> Option<()> {
    match wire {
        0 => { read_varint(data, offset)?; }
        1 => *offset = offset.checked_add(8)?,
        2 => {
            let length = read_varint(data, offset)? as usize;
            *offset = offset.checked_add(length)?;
        }
        5 => *offset = offset.checked_add(4)?,
        _ => return None,
    }
    (*offset <= data.len()).then_some(())
}

fn parse_manifest_name(path: &Path) -> Option<(u64, String)> {
    manifest_identity_from_name(path.file_name()?.to_str()?)
}

pub fn manifest_identity_from_name(file_name: &str) -> Option<(u64, String)> {
    let stem = file_name.strip_suffix(".manifest")?;
    let (depot, gid) = stem.split_once('_')?;
    Some((depot.parse().ok()?, gid.parse::<u64>().ok()?.to_string()))
}

fn same_path(left: &Path, right: &Path) -> bool {
    fs::canonicalize(left).ok() == fs::canonicalize(right).ok()
        || left.to_string_lossy().eq_ignore_ascii_case(&right.to_string_lossy())
}

pub fn manifest_path(dir: &Path, depot_id: u64, manifest_gid: &str) -> PathBuf {
    dir.join(format!("{depot_id}_{manifest_gid}.manifest"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn fixture(depot: u64, gid: u64, size: u64) -> Vec<u8> {
        fn varint(mut value: u64, out: &mut Vec<u8>) {
            while value >= 0x80 { out.push((value as u8 & 0x7f) | 0x80); value >>= 7; }
            out.push(value as u8);
        }
        let mut metadata = Vec::new();
        for (field, value) in [(1, depot), (2, gid), (5, size)] {
            varint((field << 3) as u64, &mut metadata);
            varint(value, &mut metadata);
        }
        let mut result = Vec::new();
        result.extend(METADATA_MAGIC.to_le_bytes());
        result.extend((metadata.len() as u32).to_le_bytes());
        result.extend(metadata);
        result.extend(EOF_MAGIC.to_le_bytes());
        result.extend(0u32.to_le_bytes());
        if result.len() <= MIN_VALID_MANIFEST_BYTES {
            result.resize(MIN_VALID_MANIFEST_BYTES + 64, 0);
        }
        result
    }

    fn temp_dir(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!("0xolemon-{name}-{}", SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos()))
    }

    #[test]
    fn reads_metadata_and_validates_identity() {
        let dir = temp_dir("manifest");
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("123_456.manifest");
        fs::write(&path, fixture(123, 456, 789)).unwrap();
        assert_eq!(read_manifest(&path).unwrap().size_on_disk, 789);
        assert!(matches_manifest(&path, 123, "456"));
        assert!(!matches_manifest(&path, 124, "456"));
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn rejects_stubs_and_truncated_manifests_under_1kb() {
        let dir = temp_dir("stub-manifest");
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("123_456.manifest");

        // Exactly 1024 bytes (must be > 1024)
        fs::write(&path, vec![0u8; 1024]).unwrap();
        assert!(!is_valid_manifest_size(1024));
        assert!(read_manifest(&path).is_none());
        assert!(!matches_manifest(&path, 123, "456"));
        assert!(!is_valid_manifest_file(&path, 123, "456"));

        // 1 byte stub (Steam truncation after uninstall or finished download)
        fs::write(&path, b"x").unwrap();
        assert!(!is_valid_manifest_size(1));
        assert!(read_manifest(&path).is_none());
        assert!(!matches_manifest(&path, 123, "456"));
        assert!(!is_valid_manifest_file(&path, 123, "456"));

        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn sync_manifest_vault_to_steam_heals_missing_or_corrupt_manifest() {
        let root = temp_dir("vault-heal");
        let vault = root.join("vault");
        let steam = root.join("depotcache");
        fs::create_dir_all(&vault).unwrap();
        fs::create_dir_all(&steam).unwrap();

        let valid_bytes = fixture(123, 456, 9999);
        let manifest_name = "123_456.manifest";

        // Write valid manifest into vault
        fs::write(vault.join(manifest_name), &valid_bytes).unwrap();

        // 1. Steam is missing the manifest -> healed!
        assert!(sync_manifest_vault_to_steam(&vault, &steam, 123, "456"));
        assert!(is_valid_manifest_file(&steam.join(manifest_name), 123, "456"));

        // 2. Steam's copy gets corrupted / truncated down to 1 byte (Steam 1KB bug)
        fs::write(steam.join(manifest_name), b"stub").unwrap();
        assert!(!is_valid_manifest_file(&steam.join(manifest_name), 123, "456"));

        // Auto-heal restores the clean copy from vault!
        assert!(sync_manifest_vault_to_steam(&vault, &steam, 123, "456"));
        assert!(is_valid_manifest_file(&steam.join(manifest_name), 123, "456"));
        assert_eq!(fs::read(steam.join(manifest_name)).unwrap(), valid_bytes);

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn migration_rejects_bad_content_and_moves_valid_content() {
        let root = temp_dir("migration");
        let legacy = root.join("config").join("depotcache");
        let real = root.join("depotcache");
        fs::create_dir_all(&legacy).unwrap();
        fs::write(legacy.join("123_456.manifest"), fixture(123, 456, 1)).unwrap();
        fs::write(legacy.join("124_456.manifest"), b"bad").unwrap();
        let result = migrate_legacy_cache(&legacy, &real);
        assert_eq!(result.moved, 1);
        assert_eq!(result.rejected, 1);
        assert!(real.join("123_456.manifest").is_file());
        let _ = fs::remove_dir_all(root);
    }
}