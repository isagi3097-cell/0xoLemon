//! Secure local key storage using Windows DPAPI (Data Protection API).
//!
//! Keys are encrypted with `CryptProtectData` (per-user, machine-bound) and
//! stored in `%APPDATA%\0xoLemon\lm.dat` — a binary file invisible to users.
//! An additional entropy blob embedded in the binary further hardens the blob
//! against offline attacks (attacker needs both the file AND the binary).
//!
//! Priority for key resolution (see `secure_keys.rs`):
//!   1. DPAPI-encrypted local file (lm.dat) — primary, opaque to users
//!   2. Embedded obfuscated bytes in binary — always-available fallback
//!
//! File format (lm.dat):
//!   [4]  magic: b"0KYS"
//!   [4]  steam_blob_len: u32 LE
//!   [N]  DPAPI-encrypted steam key
//!   [4]  sgdb_blob_len:  u32 LE
//!   [M]  DPAPI-encrypted sgdb key

// Additional entropy — makes the DPAPI blob machine+binary bound.
// Attacker needs this exact sequence AND the user session to decrypt.
const DPAPI_ENTROPY: &[u8] = &[
    0x4f, 0x78, 0x6f, 0x4c, 0x65, 0x6d, 0x6f, 0x6e,
    0x2d, 0x4b, 0x65, 0x79, 0x53, 0x74, 0x6f, 0x72,
    0x65, 0x2d, 0x76, 0x31, 0x00, 0x5a, 0x37, 0xa3,
];

const FILE_MAGIC: &[u8; 4] = b"0KYS";

fn key_store_path() -> Option<std::path::PathBuf> {
    std::env::var_os("APPDATA")
        .map(std::path::PathBuf::from)
        .map(|p| p.join("0xoLemon").join("lm.dat"))
}

// ── DPAPI helpers ──────────────────────────────────────────────────────────

#[cfg(target_os = "windows")]
fn dpapi_encrypt(plaintext: &[u8]) -> Option<Vec<u8>> {
    use winapi::um::dpapi::CryptProtectData;
    use winapi::um::wincrypt::DATA_BLOB;
    use winapi::um::winbase::LocalFree;
    use std::ptr;

    unsafe {
        let mut input = DATA_BLOB {
            cbData: plaintext.len() as u32,
            pbData: plaintext.as_ptr() as *mut u8,
        };
        let mut entropy = DATA_BLOB {
            cbData: DPAPI_ENTROPY.len() as u32,
            pbData: DPAPI_ENTROPY.as_ptr() as *mut u8,
        };
        let mut output = DATA_BLOB { cbData: 0, pbData: ptr::null_mut() };

        let ok = CryptProtectData(
            &mut input,
            ptr::null(),       // description (none)
            &mut entropy,      // optional entropy
            ptr::null_mut(),   // reserved
            ptr::null_mut(),   // prompt struct (none)
            0,                 // flags: 0 = per-user
            &mut output,
        );

        if ok == 0 || output.pbData.is_null() {
            return None;
        }

        let blob = std::slice::from_raw_parts(output.pbData, output.cbData as usize).to_vec();
        LocalFree(output.pbData as *mut _);
        Some(blob)
    }
}

#[cfg(target_os = "windows")]
fn dpapi_decrypt(ciphertext: &[u8]) -> Option<Vec<u8>> {
    use winapi::um::dpapi::CryptUnprotectData;
    use winapi::um::wincrypt::DATA_BLOB;
    use winapi::um::winbase::LocalFree;
    use std::ptr;

    unsafe {
        let mut input = DATA_BLOB {
            cbData: ciphertext.len() as u32,
            pbData: ciphertext.as_ptr() as *mut u8,
        };
        let mut entropy = DATA_BLOB {
            cbData: DPAPI_ENTROPY.len() as u32,
            pbData: DPAPI_ENTROPY.as_ptr() as *mut u8,
        };
        let mut output = DATA_BLOB { cbData: 0, pbData: ptr::null_mut() };

        let ok = CryptUnprotectData(
            &mut input,
            ptr::null_mut(),   // description out (ignore)
            &mut entropy,
            ptr::null_mut(),   // reserved
            ptr::null_mut(),   // prompt struct (none)
            0,                 // flags
            &mut output,
        );

        if ok == 0 || output.pbData.is_null() {
            return None;
        }

        let plain = std::slice::from_raw_parts(output.pbData, output.cbData as usize).to_vec();
        LocalFree(output.pbData as *mut _);
        Some(plain)
    }
}

#[cfg(not(target_os = "windows"))]
fn dpapi_encrypt(_plaintext: &[u8]) -> Option<Vec<u8>> { None }
#[cfg(not(target_os = "windows"))]
fn dpapi_decrypt(_ciphertext: &[u8]) -> Option<Vec<u8>> { None }

// ── lm.dat read/write ──────────────────────────────────────────────────────

fn write_key_file(steam_blob: &[u8], sgdb_blob: &[u8]) -> bool {
    let Some(path) = key_store_path() else { return false };

    // Create parent dir if needed
    if let Some(dir) = path.parent() {
        if std::fs::create_dir_all(dir).is_err() {
            return false;
        }
    }

    let mut buf: Vec<u8> = Vec::with_capacity(8 + steam_blob.len() + 4 + sgdb_blob.len());
    buf.extend_from_slice(FILE_MAGIC);
    buf.extend_from_slice(&(steam_blob.len() as u32).to_le_bytes());
    buf.extend_from_slice(steam_blob);
    buf.extend_from_slice(&(sgdb_blob.len() as u32).to_le_bytes());
    buf.extend_from_slice(sgdb_blob);

    std::fs::write(&path, &buf).is_ok()
}

fn read_key_file() -> Option<(Vec<u8>, Vec<u8>)> {
    let path = key_store_path()?;
    let data = std::fs::read(&path).ok()?;

    if data.len() < 12 || &data[..4] != FILE_MAGIC {
        return None;
    }

    let steam_len = u32::from_le_bytes(data[4..8].try_into().ok()?) as usize;
    if data.len() < 8 + steam_len + 4 {
        return None;
    }
    let steam_blob = &data[8..8 + steam_len];

    let sgdb_offset = 8 + steam_len;
    let sgdb_len = u32::from_le_bytes(data[sgdb_offset..sgdb_offset + 4].try_into().ok()?) as usize;
    if data.len() < sgdb_offset + 4 + sgdb_len {
        return None;
    }
    let sgdb_blob = &data[sgdb_offset + 4..sgdb_offset + 4 + sgdb_len];

    Some((steam_blob.to_vec(), sgdb_blob.to_vec()))
}

// ── Public API ─────────────────────────────────────────────────────────────

/// Read the Steam Web API key from the DPAPI-encrypted local file.
/// Returns `None` if file doesn't exist or decryption fails.
pub(crate) fn read_steam_api_key() -> Option<String> {
    let (steam_blob, _) = read_key_file()?;
    let plain = dpapi_decrypt(&steam_blob)?;
    let key = String::from_utf8(plain).ok()?;
    let key = key.trim().to_string();
    if key.is_empty() { None } else { Some(key) }
}

/// Read the SteamGridDB API key from the DPAPI-encrypted local file.
/// Returns `None` if file doesn't exist or decryption fails.
pub(crate) fn read_steamgriddb_key() -> Option<String> {
    let (_, sgdb_blob) = read_key_file()?;
    let plain = dpapi_decrypt(&sgdb_blob)?;
    let key = String::from_utf8(plain).ok()?;
    let key = key.trim().to_string();
    if key.is_empty() { None } else { Some(key) }
}

/// Called once at launcher startup.
/// If `lm.dat` doesn't exist, decode embedded keys and encrypt+save them.
/// Subsequent launches read from the DPAPI file — no binary decode at runtime.
pub(crate) fn bootstrap_keys_if_absent() {
    // Already have the file → nothing to do
    if key_store_path().map(|p| p.exists()).unwrap_or(false) {
        return;
    }

    let mut steam_blob: Option<Vec<u8>> = None;
    let mut sgdb_blob: Option<Vec<u8>> = None;

    crate::secure_keys::with_embedded_steam_api_key(|key| {
        if !key.is_empty() {
            steam_blob = dpapi_encrypt(key.as_bytes());
        }
    });

    crate::secure_keys::with_embedded_sgdb_key(|key| {
        if !key.is_empty() {
            sgdb_blob = dpapi_encrypt(key.as_bytes());
        }
    });

    if let (Some(sb), Some(gb)) = (steam_blob, sgdb_blob) {
        if write_key_file(&sb, &gb) {
            eprintln!("[0xoLemon] Key store initialized (lm.dat).");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dpapi_roundtrip() {
        let plain = b"test_key_abcdef1234567890";
        let Some(enc) = dpapi_encrypt(plain) else {
            eprintln!("DPAPI unavailable (CI?), skip");
            return;
        };
        assert_ne!(enc, plain);
        let dec = dpapi_decrypt(&enc).expect("DPAPI decrypt failed");
        assert_eq!(dec, plain);
    }
}
