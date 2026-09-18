//! Runtime credentials and versioned asset-pack key derivation.
//! Keys are embedded as obfuscated byte arrays and decoded at runtime.

use std::hint::black_box;
use std::time::{SystemTime, UNIX_EPOCH};

// --- Embedded API keys (obfuscated) ---
// Both decode to the correct API keys via decode_obfuscated_key().
// Seed + index-dependent XOR with rotate ensures bytes are not plaintext in binary.

const STEAM_KEY_SEED: u8 = 0x5a;
const STEAM_KEY_BYTES: [u8; 32] = [
    0x32, 0x7d, 0x3a, 0x9b, 0xf6, 0xb6, 0x4f, 0xe9, 0x1e, 0xef, 0x8e, 0x1a, 0xb0, 0x9a, 0x4c, 0x65,
    0xd0, 0x67, 0x2e, 0xd8, 0xb6, 0xbe, 0xf0, 0x36, 0xba, 0x7b, 0xa7, 0xfe, 0xe9, 0x83, 0x1d, 0xbd,
];

const SGDB_KEY_SEED: u8 = 0x37;
const SGDB_KEY_BYTES: [u8; 32] = [
    0x02, 0xf5, 0x2b, 0x76, 0xcb, 0xd2, 0x5b, 0xed, 0xfb, 0x4e, 0x8d, 0xff, 0xf9, 0x6a, 0xb3, 0x62,
    0xb9, 0x17, 0x23, 0x12, 0x84, 0x58, 0xcc, 0x38, 0xe5, 0xc9, 0x2e, 0xfb, 0x27, 0x4f, 0x74, 0xaf,
];

// --- Embedded Hugging Face tokens (obfuscated) ---
const PENALDO_CR7_PENALDOCR7_SEED: u8 = 0x41;
const PENALDO_CR7_PENALDOCR7_BYTES: [u8; 37] = [0x52, 0xa0, 0x20, 0x30, 0x26, 0xb9, 0xe4, 0xf7, 0xc3, 0xfe, 0xab, 0x74, 0x26, 0xde, 0x35, 0x25, 0x2b, 0x96, 0x88, 0x95, 0x06, 0x60, 0x38, 0x11, 0xf2, 0xd9, 0x30, 0xe7, 0x8d, 0x0b, 0x2d, 0x89, 0x52, 0x2f, 0xc4, 0x8a, 0xf5];

const CATMANGA_CAT_MANGA_SEED: u8 = 0x42;
const CATMANGA_CAT_MANGA_BYTES: [u8; 37] = [0x54, 0xa4, 0x18, 0xe2, 0xe3, 0x75, 0xf2, 0xd1, 0x97, 0xb6, 0x98, 0xf4, 0x6c, 0xd9, 0x23, 0xa5, 0xb2, 0xb7, 0xca, 0x50, 0x89, 0x7c, 0xe8, 0x21, 0xc2, 0xfa, 0x7d, 0x7b, 0x91, 0xd3, 0x3c, 0x7b, 0xb5, 0x22, 0xc8, 0xe6, 0xfd];

const JOINCANE_0XOLEMON_SEED: u8 = 0x43;
const JOINCANE_0XOLEMON_BYTES: [u8; 37] = [0x56, 0xd8, 0x10, 0xc1, 0xa6, 0x7a, 0x70, 0xf3, 0x47, 0x77, 0x1a, 0x16, 0x25, 0xc4, 0x59, 0xcd, 0x3b, 0x96, 0xef, 0x93, 0x89, 0x3a, 0x24, 0x08, 0x90, 0x1a, 0xff, 0x64, 0xc9, 0xbb, 0x2d, 0x6a, 0x76, 0x67, 0xdf, 0xda, 0x59];

const CHAT_STORIES_CHAT_STORIES_SEED: u8 = 0x44;
const CHAT_STORIES_CHAT_STORIES_BYTES: [u8; 37] = [0x58, 0xdc, 0x08, 0x33, 0x24, 0xfd, 0x63, 0xb5, 0x27, 0x0e, 0x4a, 0x16, 0xe0, 0x55, 0x51, 0x31, 0x92, 0x55, 0x0d, 0x9e, 0x98, 0x7e, 0x5c, 0xc9, 0x42, 0x5b, 0x3f, 0x67, 0xf7, 0x2b, 0x6c, 0xfb, 0x10, 0xa6, 0x5e, 0xe2, 0x65];

const AKATSUKI_TUSU_NARUTO_SEED: u8 = 0x45;
const AKATSUKI_TUSU_NARUTO_BYTES: [u8; 37] = [0x5a, 0xd0, 0x00, 0x60, 0x06, 0xb5, 0x6f, 0x91, 0xa7, 0x6e, 0x9a, 0xd1, 0xec, 0xc1, 0x57, 0x25, 0x32, 0x96, 0xca, 0x12, 0x16, 0x32, 0x00, 0x51, 0xa3, 0x9b, 0xb1, 0x71, 0x91, 0x7f, 0x4d, 0xc8, 0xd1, 0x6e, 0x47, 0x82, 0xc9];

const IMMAKING_LUAS_SEED: u8 = 0x46;
const IMMAKING_LUAS_BYTES: [u8; 37] = [0x5c, 0xd4, 0xf9, 0xf1, 0x83, 0xf3, 0xf0, 0xcd, 0x87, 0xd6, 0xda, 0x91, 0x62, 0xdd, 0x27, 0xcd, 0xaa, 0x35, 0x2c, 0x95, 0x1e, 0x36, 0x50, 0xf8, 0x81, 0x1f, 0xb6, 0x75, 0xad, 0x7b, 0x5c, 0xe8, 0x93, 0x61, 0xb1, 0xbc, 0xb9];

const PROBBI_PROBBINE_SEED: u8 = 0x47;
const PROBBI_PROBBINE_BYTES: [u8; 37] = [0x5e, 0xc8, 0xf1, 0x83, 0xa3, 0x7f, 0x6b, 0xf7, 0x7f, 0xd7, 0xe8, 0x36, 0xa4, 0xd4, 0x29, 0xf5, 0x3a, 0x54, 0x4e, 0x1d, 0x9c, 0x7c, 0x0c, 0x98, 0xc0, 0xb8, 0xfd, 0x66, 0xe1, 0xb6, 0xdd, 0xca, 0x96, 0xe1, 0x29, 0xbc, 0x39];

/// Decodes the embedded obfuscated Hugging Face token for a specific repository.
pub(crate) fn get_embedded_hf_token(repo_id: &str) -> Option<String> {
    let clean = repo_id.trim().trim_matches('/');
    let (bytes, seed): (&[u8], u8) = if clean.eq_ignore_ascii_case("Penaldo-CR7/PenaldoCR7") {
        (&PENALDO_CR7_PENALDOCR7_BYTES, PENALDO_CR7_PENALDOCR7_SEED)
    } else if clean.eq_ignore_ascii_case("CatManga/Cat-Manga") {
        (&CATMANGA_CAT_MANGA_BYTES, CATMANGA_CAT_MANGA_SEED)
    } else if clean.eq_ignore_ascii_case("JOINCANE/0XoLemon") {
        (&JOINCANE_0XOLEMON_BYTES, JOINCANE_0XOLEMON_SEED)
    } else if clean.eq_ignore_ascii_case("Chat-stories/Chat-stories") {
        (&CHAT_STORIES_CHAT_STORIES_BYTES, CHAT_STORIES_CHAT_STORIES_SEED)
    } else if clean.eq_ignore_ascii_case("Akatsuki-tusu/naruto") {
        (&AKATSUKI_TUSU_NARUTO_BYTES, AKATSUKI_TUSU_NARUTO_SEED)
    } else if clean.eq_ignore_ascii_case("Immaking/Luas") {
        (&IMMAKING_LUAS_BYTES, IMMAKING_LUAS_SEED)
    } else if clean.eq_ignore_ascii_case("PROBBI/PROBBINE") {
        (&PROBBI_PROBBINE_BYTES, PROBBI_PROBBINE_SEED)
    } else {
        (&PENALDO_CR7_PENALDOCR7_BYTES, PENALDO_CR7_PENALDOCR7_SEED)
    };

    let key = decode_obfuscated_key(bytes, seed);
    String::from_utf8(key).ok()
}

/// Returns the default embedded Hugging Face token for global launcher operations.
pub(crate) fn get_default_embedded_hf_token() -> Option<String> {
    let key = decode_obfuscated_key(&PENALDO_CR7_PENALDOCR7_BYTES, PENALDO_CR7_PENALDOCR7_SEED);
    String::from_utf8(key).ok()
}

/// Derive the asset-pack encryption key from a per-pack salt.
/// Uses both embedded API keys as key material via BLAKE3.
pub(crate) fn derive_asset_pack_key(salt: &[u8; 16]) -> [u8; 32] {
    let mut steam = decode_obfuscated_key(&STEAM_KEY_BYTES, STEAM_KEY_SEED);
    let mut sgdb = decode_obfuscated_key(&SGDB_KEY_BYTES, SGDB_KEY_SEED);
    let mut hasher = blake3::Hasher::new();
    hasher.update(b"0xo asset pack key v1");
    hasher.update(salt);
    hasher.update(&steam);
    hasher.update(&sgdb);
    steam.fill(0);
    sgdb.fill(0);
    *hasher.finalize().as_bytes()
}

/// Decode the Steam Web API key directly from embedded bytes (no Credential Manager check).
/// Used only by `credential_store::bootstrap_keys_if_absent` to avoid circular calls.
pub(crate) fn with_embedded_steam_api_key<T>(f: impl FnOnce(&str) -> T) -> T {
    let mut key = decode_obfuscated_key(&STEAM_KEY_BYTES, STEAM_KEY_SEED);
    let result = {
        let key_str = std::str::from_utf8(&key).unwrap_or_default();
        f(key_str)
    };
    key.fill(0);
    result
}

/// Decode the SteamGridDB API key directly from embedded bytes (no Credential Manager check).
/// Used only by `credential_store::bootstrap_keys_if_absent` to avoid circular calls.
pub(crate) fn with_embedded_sgdb_key<T>(f: impl FnOnce(&str) -> T) -> T {
    let mut key = decode_obfuscated_key(&SGDB_KEY_BYTES, SGDB_KEY_SEED);
    let result = {
        let key_str = std::str::from_utf8(&key).unwrap_or_default();
        f(key_str)
    };
    key.fill(0);
    result
}

/// Decode and use the Steam Web API key.
/// Priority:
///   1. Windows Credential Manager (`0xoLemon/steam_web_api_key`) — updatable without rebuild
///   2. Embedded obfuscated bytes in binary — always-available built-in fallback
///
/// Key is zeroed from memory immediately after the closure returns.
#[inline(never)]
pub(crate) fn with_steam_api_key<T>(f: impl FnOnce(&str) -> T) -> T {
    // 1. Try Windows Credential Manager
    if let Some(cred_key) = crate::credential_store::read_steam_api_key() {
        let mut owned = cred_key;
        let result = f(&owned);
        // zero the String's memory
        unsafe {
            let bytes = owned.as_bytes_mut();
            bytes.fill(0);
        }
        return result;
    }
    // 2. Fallback: decode from embedded obfuscated bytes
    let mut key = decode_obfuscated_key(&STEAM_KEY_BYTES, STEAM_KEY_SEED);
    let result = {
        let key_str = std::str::from_utf8(&key).unwrap_or_default();
        f(key_str)
    };
    key.fill(0);
    result
}

/// Decode and use the SteamGridDB API key.
/// Priority:
///   1. Windows Credential Manager (`0xoLemon/steamgriddb_api_key`) — updatable without rebuild
///   2. Embedded obfuscated bytes in binary — always-available built-in fallback
///
/// Key is zeroed from memory immediately after the closure returns.
#[inline(never)]
pub(crate) fn with_steamgriddb_key<T>(f: impl FnOnce(&str) -> T) -> T {
    // 1. Try Windows Credential Manager
    if let Some(cred_key) = crate::credential_store::read_steamgriddb_key() {
        let mut owned = cred_key;
        let result = f(&owned);
        unsafe {
            let bytes = owned.as_bytes_mut();
            bytes.fill(0);
        }
        return result;
    }
    // 2. Fallback: decode from embedded obfuscated bytes
    let mut key = decode_obfuscated_key(&SGDB_KEY_BYTES, SGDB_KEY_SEED);
    let result = {
        let key_str = std::str::from_utf8(&key).unwrap_or_default();
        f(key_str)
    };
    key.fill(0);
    result
}

/// Decode an obfuscated key from embedded bytes.
/// The runtime mask (nanos ^ pid) is XORed twice and cancels out — 
/// it exists purely to resist simple static analysis of the decode routine.
/// Actual decryption: rotate_right(byte, rotate) ^ seed.wrapping_add(index * 13)
#[inline(never)]
fn decode_obfuscated_key(bytes: &[u8], seed: u8) -> Vec<u8> {
    let seed = black_box(seed);
    let mask = runtime_decode_mask();
    black_box(bytes)
        .iter()
        .enumerate()
        .map(|(index, byte)| {
            let rotate = (index as u32 % 7) + 1;
            let mixed = byte.rotate_right(rotate) ^ mask.rotate_left((index as u32 % 5) + 1);
            let unmasked = black_box(mixed) ^ mask.rotate_left((index as u32 % 5) + 1);
            unmasked ^ seed.wrapping_add((index as u8).wrapping_mul(13))
        })
        .collect()
}

#[inline(never)]
fn runtime_decode_mask() -> u8 {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.subsec_nanos() as u8)
        .unwrap_or(0);
    black_box(nanos ^ (std::process::id() as u8))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn steam_api_key_decodes_to_expected_length() {
        with_steam_api_key(|key| {
            assert_eq!(key.len(), 32, "Steam Web API key should be 32 hex chars");
            assert!(key.chars().all(|c| c.is_ascii_hexdigit()), "Steam key should be hex");
        });
    }

    #[test]
    fn steamgriddb_key_decodes_to_expected_length() {
        with_steamgriddb_key(|key| {
            assert_eq!(key.len(), 32, "SteamGridDB key should be 32 hex chars");
            assert!(key.chars().all(|c| c.is_ascii_hexdigit()), "SGDB key should be hex");
        });
    }
}
