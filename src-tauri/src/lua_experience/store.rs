use super::metadata::{sha256, Freshness, LuaMetadata, Provider, SourceObservation};
use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use std::{
    fs,
    path::{Path, PathBuf},
    sync::Mutex,
    time::Duration,
};

pub(super) const SUCCESS_TTL: i64 = 600;
pub(super) const FAILURE_TTL: i64 = 120;
const WINNER_TTL: i64 = 600;
const IMAGE_TTL: i64 = 86_400;
const MAX_ROWS: i64 = 500;
const MAX_IMAGE_BYTES: i64 = 128 * 1024 * 1024;
const MAX_JSON_BYTES: usize = 512 * 1024;
const SCHEMA_REVISION: i64 = 1;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LuaCacheHealth {
    pub namespace: String,
    pub metadata_entries: u64,
    pub image_entries: u64,
    pub image_bytes: u64,
    pub db_bytes: u64,
    pub native_steam_kit_available: bool,
}

pub(super) struct Stored {
    pub data: Option<LuaMetadata>,
    pub observation: SourceObservation,
    pub retry_after: i64,
}

pub(super) struct StoredImage {
    pub bytes: Vec<u8>,
    pub mime: String,
    pub hash: String,
}

pub(super) struct Store {
    connection: Mutex<Connection>,
    path: PathBuf,
}

fn sql_error(error: rusqlite::Error) -> String {
    match error.sqlite_error_code() {
        Some(rusqlite::ErrorCode::DiskFull) => "LUA_CACHE_DISK_FULL",
        Some(rusqlite::ErrorCode::DatabaseBusy) | Some(rusqlite::ErrorCode::DatabaseLocked) => {
            "LUA_CACHE_BUSY"
        }
        Some(rusqlite::ErrorCode::DatabaseCorrupt) | Some(rusqlite::ErrorCode::NotADatabase) => {
            "LUA_CACHE_CORRUPT"
        }
        _ => "LUA_CACHE_DATABASE",
    }
    .into()
}

/// Reject links/reparse points before opening this fixed, app-owned cache namespace.
pub(super) fn regular_boundary(path: &Path) -> Result<(), String> {
    for part in path.ancestors() {
        match fs::symlink_metadata(part) {
            Ok(meta) => {
                #[cfg(windows)]
                {
                    use std::os::windows::fs::MetadataExt;
                    if meta.file_attributes() & 0x400 != 0 {
                        return Err("LUA_CACHE_REPARSE_POINT".into());
                    }
                }
                if meta.file_type().is_symlink() {
                    return Err("LUA_CACHE_SYMLINK".into());
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => (),
            Err(_) => return Err("LUA_CACHE_PATH_ACCESS".into()),
        }
    }
    Ok(())
}

impl Store {
    pub fn open(root: &Path) -> Result<Self, String> {
        regular_boundary(root)?;
        fs::create_dir_all(root).map_err(|_| "LUA_CACHE_CREATE")?;
        regular_boundary(root)?;
        let path = root.join("metadata.sqlite3");
        for suffix in ["", "-wal", "-shm", "-journal"] {
            regular_boundary(&root.join(format!("metadata.sqlite3{suffix}")))?;
        }
        let connection = Connection::open(&path).map_err(sql_error)?;
        connection
            .busy_timeout(Duration::from_secs(3))
            .map_err(sql_error)?;
        // DELETE journal bounds disk usage; immutable image bytes and index commit together.
        connection.execute_batch("PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA max_page_count=65536;
          CREATE TABLE IF NOT EXISTS lua_metadata(
            appid INTEGER NOT NULL, locale TEXT NOT NULL, provider TEXT NOT NULL,
            schema_revision INTEGER NOT NULL, revision TEXT NOT NULL, payload TEXT, payload_hash TEXT,
            observed_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, retry_after INTEGER NOT NULL,
            error_code TEXT, PRIMARY KEY(appid,locale,provider,schema_revision));
          CREATE TABLE IF NOT EXISTS lua_winners(appid INTEGER NOT NULL,locale TEXT NOT NULL,provider TEXT NOT NULL,expires_at INTEGER NOT NULL,PRIMARY KEY(appid,locale));
          CREATE TABLE IF NOT EXISTS lua_image_blobs(hash TEXT PRIMARY KEY,mime TEXT NOT NULL,payload BLOB NOT NULL,size INTEGER NOT NULL);
          CREATE TABLE IF NOT EXISTS lua_images(url_key TEXT PRIMARY KEY,hash TEXT NOT NULL REFERENCES lua_image_blobs(hash),expires_at INTEGER NOT NULL,last_access INTEGER NOT NULL);")
            .map_err(sql_error)?;
        Ok(Self {
            connection: Mutex::new(connection),
            path,
        })
    }

    pub fn get(
        &self,
        appid: u32,
        locale: &str,
        provider: Provider,
        now: i64,
    ) -> Result<Option<Stored>, String> {
        let conn = self.connection.lock().map_err(|_| "LUA_CACHE_LOCK")?;
        Self::read_row(&conn, appid, locale, provider, now)
    }

    fn read_row(
        conn: &Connection,
        appid: u32,
        locale: &str,
        provider: Provider,
        now: i64,
    ) -> Result<Option<Stored>, String> {
        let row = conn.query_row("SELECT substr(revision,1,64),CASE WHEN length(CAST(payload AS BLOB))<=524288 THEN payload ELSE NULL END,substr(payload_hash,1,64),observed_at,expires_at,retry_after,substr(error_code,1,128) FROM lua_metadata WHERE appid=?1 AND locale=?2 AND provider=?3 AND schema_revision=?4",
            params![appid,locale,provider.id(),SCHEMA_REVISION], |row| Ok((row.get::<_,String>(0)?,row.get::<_,Option<String>>(1)?,row.get::<_,Option<String>>(2)?,row.get::<_,i64>(3)?,row.get::<_,i64>(4)?,row.get::<_,i64>(5)?,row.get::<_,Option<String>>(6)?))).optional().map_err(sql_error)?;
        let Some((revision, payload, hash, observed_at, expires_at, retry_after, error_code)) = row
        else {
            return Ok(None);
        };
        let data = match payload {
            Some(json)
                if json.len() <= MAX_JSON_BYTES
                    && hash.as_deref() == Some(sha256(json.as_bytes()).as_str()) =>
            {
                serde_json::from_str::<LuaMetadata>(&json)
                    .ok()
                    .filter(|d| d.app_id == appid)
            }
            _ => None,
        };
        let corrupt = data.is_none() && hash.is_some();
        let freshness = if data.is_none() {
            Freshness::Unknown
        } else if expires_at > now && error_code.is_none() {
            Freshness::Fresh
        } else {
            Freshness::Stale
        };
        Ok(Some(Stored {
            data,
            retry_after: if corrupt { 0 } else { retry_after },
            observation: SourceObservation {
                provider: provider.id().into(),
                revision,
                observed_at: if observed_at > 0 {
                    Some(observed_at)
                } else {
                    None
                },
                expires_at: Some(expires_at),
                freshness,
                error_code: if corrupt {
                    Some("CACHE_ROW_CORRUPT".into())
                } else {
                    error_code
                },
            },
        }))
    }

    pub fn save(
        &self,
        appid: u32,
        locale: &str,
        provider: Provider,
        data: &LuaMetadata,
        now: i64,
    ) -> Result<(), String> {
        let mut conn = self.connection.lock().map_err(|_| "LUA_CACHE_LOCK")?;
        let tx = conn
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
            .map_err(sql_error)?;
        // Compare and merge under the same SQLite write transaction, including across processes.
        let old = Self::read_row(&tx, appid, locale, provider, now)?;
        // An empty/partial response cannot replace known names, schema or depot detail.
        let merged = old
            .as_ref()
            .and_then(|r| r.data.as_ref())
            .map(|d| d.preserve_quality(data))
            .unwrap_or_else(|| data.clone());
        let degraded = old
            .as_ref()
            .and_then(|r| r.data.as_ref())
            .map(|d| !data.covers(d))
            .unwrap_or(false);
        let json = serde_json::to_string(&merged).map_err(|_| "LUA_CACHE_ENCODE")?;
        if json.len() > MAX_JSON_BYTES {
            return Err("LUA_METADATA_TOO_LARGE".into());
        }
        let hash = sha256(json.as_bytes());
        let observed_at = if degraded {
            old.as_ref()
                .and_then(|r| r.observation.observed_at)
                .unwrap_or(now)
        } else {
            now
        };
        let expires_at = if degraded { now } else { now + SUCCESS_TTL };
        let error = degraded.then_some("PARTIAL_RESPONSE_RETAINED");
        tx.execute("INSERT INTO lua_metadata VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11) ON CONFLICT(appid,locale,provider,schema_revision) DO UPDATE SET revision=excluded.revision,payload=excluded.payload,payload_hash=excluded.payload_hash,observed_at=excluded.observed_at,expires_at=excluded.expires_at,retry_after=excluded.retry_after,error_code=excluded.error_code",
            params![appid,locale,provider.id(),SCHEMA_REVISION,hash,json,hash,observed_at,expires_at,if degraded {now+FAILURE_TTL} else {0},error]).map_err(sql_error)?;
        tx.execute("DELETE FROM lua_metadata WHERE rowid IN (SELECT rowid FROM lua_metadata ORDER BY observed_at DESC,rowid DESC LIMIT -1 OFFSET ?1)", [MAX_ROWS]).map_err(sql_error)?;
        tx.execute("DELETE FROM lua_winners WHERE NOT EXISTS (SELECT 1 FROM lua_metadata m WHERE m.appid=lua_winners.appid AND m.locale=lua_winners.locale)", []).map_err(sql_error)?;
        tx.commit().map_err(sql_error)
    }

    pub fn failure(
        &self,
        appid: u32,
        locale: &str,
        provider: Provider,
        error: &str,
        now: i64,
    ) -> Result<(), String> {
        let mut conn = self.connection.lock().map_err(|_| "LUA_CACHE_LOCK")?;
        let tx = conn.transaction().map_err(sql_error)?;
        tx.execute("INSERT INTO lua_metadata VALUES(?1,?2,?3,?4,'',NULL,NULL,0,0,?5,?6) ON CONFLICT(appid,locale,provider,schema_revision) DO UPDATE SET error_code=excluded.error_code,retry_after=excluded.retry_after",
            params![appid,locale,provider.id(),SCHEMA_REVISION,now+FAILURE_TTL,error]).map_err(sql_error)?;
        tx.execute("DELETE FROM lua_metadata WHERE rowid IN (SELECT rowid FROM lua_metadata ORDER BY observed_at DESC,rowid DESC LIMIT -1 OFFSET ?1)", [MAX_ROWS]).map_err(sql_error)?;
        tx.commit().map_err(sql_error)
    }

    pub fn winner(&self, appid: u32, locale: &str, now: i64) -> Result<Option<Provider>, String> {
        let conn = self.connection.lock().map_err(|_| "LUA_CACHE_LOCK")?;
        let id: Option<String> = conn
            .query_row(
                "SELECT provider FROM lua_winners WHERE appid=?1 AND locale=?2 AND expires_at>?3",
                params![appid, locale, now],
                |r| r.get(0),
            )
            .optional()
            .map_err(sql_error)?;
        Ok(match id.as_deref() {
            Some("steamStore") => Some(Provider::SteamStore),
            Some("steamCmd") => Some(Provider::SteamCmd),
            Some("steamKit") => Some(Provider::SteamKit),
            _ => None,
        })
    }

    pub fn set_winner(
        &self,
        appid: u32,
        locale: &str,
        provider: Provider,
        now: i64,
    ) -> Result<(), String> {
        if !matches!(
            provider,
            Provider::SteamStore | Provider::SteamCmd | Provider::SteamKit
        ) {
            return Err("LUA_WINNER_NOT_METADATA_PROVIDER".into());
        }
        self.connection.lock().map_err(|_| "LUA_CACHE_LOCK")?.execute("INSERT INTO lua_winners VALUES(?1,?2,?3,?4) ON CONFLICT(appid,locale) DO UPDATE SET provider=excluded.provider,expires_at=excluded.expires_at",params![appid,locale,provider.id(),now+WINNER_TTL]).map_err(sql_error)?;
        Ok(())
    }

    pub fn image(&self, url: &str, now: i64) -> Result<Option<StoredImage>, String> {
        let conn = self.connection.lock().map_err(|_| "LUA_CACHE_LOCK")?;
        let key = sha256(url.as_bytes());
        let row = conn.query_row("SELECT b.payload,b.mime,b.hash FROM lua_images i JOIN lua_image_blobs b ON i.hash=b.hash WHERE i.url_key=?1 AND i.expires_at>?2 AND b.size<=4194304 AND length(b.payload)<=4194304",params![key,now], |r| Ok(StoredImage {bytes:r.get(0)?,mime:r.get(1)?,hash:r.get(2)?})).optional().map_err(sql_error)?;
        if let Some(row) = row {
            if row.bytes.len() <= 4 * 1024 * 1024 && sha256(&row.bytes) == row.hash {
                conn.execute(
                    "UPDATE lua_images SET last_access=?1 WHERE url_key=?2",
                    params![now, key],
                )
                .map_err(sql_error)?;
                return Ok(Some(row));
            }
        }
        Ok(None)
    }

    pub fn save_image(
        &self,
        url: &str,
        bytes: &[u8],
        mime: &str,
        now: i64,
    ) -> Result<String, String> {
        if bytes.len() > 4 * 1024 * 1024 {
            return Err("LUA_IMAGE_TOO_LARGE".into());
        }
        let hash = sha256(bytes);
        let mut conn = self.connection.lock().map_err(|_| "LUA_CACHE_LOCK")?;
        let tx = conn.transaction().map_err(sql_error)?;
        tx.execute("INSERT INTO lua_image_blobs VALUES(?1,?2,?3,?4) ON CONFLICT(hash) DO UPDATE SET payload=excluded.payload,mime=excluded.mime,size=excluded.size",params![hash,mime,bytes,bytes.len() as i64]).map_err(sql_error)?;
        tx.execute("INSERT INTO lua_images VALUES(?1,?2,?3,?4) ON CONFLICT(url_key) DO UPDATE SET hash=excluded.hash,expires_at=excluded.expires_at,last_access=excluded.last_access",params![sha256(url.as_bytes()),hash,now+IMAGE_TTL,now]).map_err(sql_error)?;
        tx.execute("DELETE FROM lua_images WHERE url_key IN (SELECT url_key FROM lua_images ORDER BY last_access DESC,rowid DESC LIMIT -1 OFFSET ?1)",[MAX_ROWS]).map_err(sql_error)?;
        tx.execute("DELETE FROM lua_image_blobs WHERE NOT EXISTS(SELECT 1 FROM lua_images i WHERE i.hash=lua_image_blobs.hash)",[]).map_err(sql_error)?;
        loop {
            let size: i64 = tx
                .query_row(
                    "SELECT COALESCE(SUM(size),0) FROM lua_image_blobs",
                    [],
                    |r| r.get(0),
                )
                .map_err(sql_error)?;
            if size <= MAX_IMAGE_BYTES {
                break;
            }
            tx.execute("DELETE FROM lua_images WHERE url_key=(SELECT url_key FROM lua_images ORDER BY last_access,rowid LIMIT 1)",[]).map_err(sql_error)?;
            tx.execute("DELETE FROM lua_image_blobs WHERE NOT EXISTS(SELECT 1 FROM lua_images i WHERE i.hash=lua_image_blobs.hash)",[]).map_err(sql_error)?;
        }
        tx.commit().map_err(sql_error)?;
        Ok(hash)
    }

    pub fn health(&self) -> Result<LuaCacheHealth, String> {
        let conn = self.connection.lock().map_err(|_| "LUA_CACHE_LOCK")?;
        let count = |query: &str| -> Result<u64, String> {
            let value: i64 = conn.query_row(query, [], |r| r.get(0)).map_err(sql_error)?;
            u64::try_from(value).map_err(|_| "LUA_CACHE_INVALID_COUNT".into())
        };
        Ok(LuaCacheHealth {
            namespace: "lua_shop".into(),
            metadata_entries: count("SELECT COUNT(*) FROM lua_metadata")?,
            image_entries: count("SELECT COUNT(*) FROM lua_images")?,
            image_bytes: count("SELECT COALESCE(SUM(size),0) FROM lua_image_blobs")?,
            db_bytes: fs::metadata(&self.path)
                .map_err(|_| "LUA_CACHE_STAT")?
                .len(),
            native_steam_kit_available: false,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use uuid::Uuid;
    struct Fixture(PathBuf);
    impl Fixture {
        fn new() -> Self {
            let p = std::env::temp_dir().join(format!("lua-cache-test-{}", Uuid::new_v4()));
            fs::create_dir(&p).unwrap();
            Self(p)
        }
    }
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
    fn data(name: &str) -> LuaMetadata {
        LuaMetadata {
            app_id: 480,
            name: name.into(),
            ..Default::default()
        }
    }

    #[test]
    fn sqlite_ttl_restart_identity_and_winner_expiry() {
        let f = Fixture::new();
        {
            let s = Store::open(&f.0).unwrap();
            s.save(480, "english", Provider::SteamStore, &data("Spacewar"), 100)
                .unwrap();
            s.set_winner(480, "english", Provider::SteamStore, 100)
                .unwrap();
        }
        let s = Store::open(&f.0).unwrap();
        assert_eq!(
            s.get(480, "english", Provider::SteamStore, 699)
                .unwrap()
                .unwrap()
                .observation
                .freshness,
            Freshness::Fresh
        );
        assert_eq!(
            s.get(480, "english", Provider::SteamStore, 700)
                .unwrap()
                .unwrap()
                .observation
                .freshness,
            Freshness::Stale
        );
        assert!(s
            .get(480, "german", Provider::SteamStore, 100)
            .unwrap()
            .is_none());
        assert!(s
            .get(480, "english", Provider::SteamCmd, 100)
            .unwrap()
            .is_none());
        assert_eq!(
            s.winner(480, "english", 699).unwrap(),
            Some(Provider::SteamStore)
        );
        assert_eq!(s.winner(480, "english", 700).unwrap(), None);
        assert!(s
            .set_winner(480, "english", Provider::ScopedGseSchema, 100)
            .is_err());
    }
    #[test]
    fn sqlite_fallback_never_overwrites_rich_schema_and_failure_retains_bytes() {
        let f = Fixture::new();
        let s = Store::open(&f.0).unwrap();
        let mut rich = data("Rich");
        rich.short_description = Some("Known details".into());
        rich.achievements.push(super::super::metadata::Achievement {
            id: "A".into(),
            name: Some("Localized".into()),
            ..Default::default()
        });
        s.save(480, "english", Provider::SteamStore, &rich, 100)
            .unwrap();
        s.save(480, "english", Provider::SteamStore, &data("Rich"), 200)
            .unwrap();
        let before = s
            .get(480, "english", Provider::SteamStore, 200)
            .unwrap()
            .unwrap();
        assert_eq!(
            before.data.unwrap().achievements[0].name.as_deref(),
            Some("Localized")
        );
        assert_eq!(before.observation.freshness, Freshness::Stale);
        s.failure(480, "english", Provider::SteamStore, "HTTP_TIMEOUT", 220)
            .unwrap();
        let after = s
            .get(480, "english", Provider::SteamStore, 221)
            .unwrap()
            .unwrap();
        assert_eq!(after.observation.observed_at, Some(100));
        assert_eq!(after.retry_after, 340);
        assert_eq!(
            after.data.unwrap().short_description.as_deref(),
            Some("Known details")
        );
    }
    #[test]
    fn sqlite_corrupt_row_is_unknown_not_fresh_or_empty_success() {
        let f = Fixture::new();
        let s = Store::open(&f.0).unwrap();
        s.save(480, "english", Provider::SteamStore, &data("OK"), 100)
            .unwrap();
        s.connection
            .lock()
            .unwrap()
            .execute("UPDATE lua_metadata SET payload='{}'", [])
            .unwrap();
        let row = s
            .get(480, "english", Provider::SteamStore, 101)
            .unwrap()
            .unwrap();
        assert!(row.data.is_none());
        assert_eq!(
            row.observation.error_code.as_deref(),
            Some("CACHE_ROW_CORRUPT")
        );
        assert_eq!(row.retry_after, 0);
    }
    #[test]
    fn sqlite_image_content_deduplicates_and_detects_tampering() {
        let f = Fixture::new();
        let s = Store::open(&f.0).unwrap();
        s.save_image("https://cdn/a", b"one", "image/png", 100)
            .unwrap();
        s.save_image("https://cdn/b", b"one", "image/png", 100)
            .unwrap();
        assert_eq!(s.health().unwrap().image_bytes, 3);
        assert_eq!(s.health().unwrap().image_entries, 2);
        s.connection
            .lock()
            .unwrap()
            .execute("UPDATE lua_image_blobs SET payload=X'74776F'", [])
            .unwrap();
        assert!(s.image("https://cdn/a", 101).unwrap().is_none());
    }

    #[test]
    fn sqlite_concurrent_connections_merge_without_lost_schema() {
        let f = Fixture::new();
        let first = Store::open(&f.0).unwrap();
        let second = Store::open(&f.0).unwrap();
        let start = std::sync::Arc::new(std::sync::Barrier::new(3));
        let mut rich = data("Known");
        rich.short_description = Some("Keep this field".into());
        let mut extra = data("Known");
        extra.publishers.push("Publisher".into());
        let b = start.clone();
        let a = std::thread::spawn(move || {
            b.wait();
            first
                .save(480, "english", Provider::SteamStore, &rich, 100)
                .unwrap();
        });
        let b = start.clone();
        let c = std::thread::spawn(move || {
            b.wait();
            second
                .save(480, "english", Provider::SteamStore, &extra, 101)
                .unwrap();
        });
        start.wait();
        a.join().unwrap();
        c.join().unwrap();
        let s = Store::open(&f.0).unwrap();
        let result = s
            .get(480, "english", Provider::SteamStore, 102)
            .unwrap()
            .unwrap()
            .data
            .unwrap();
        assert_eq!(result.short_description.as_deref(), Some("Keep this field"));
        assert_eq!(result.publishers, vec!["Publisher"]);
    }

    #[test]
    fn sqlite_failure_backoff_survives_restart_and_keeps_provider_identity() {
        let f = Fixture::new();
        {
            let s = Store::open(&f.0).unwrap();
            s.failure(
                480,
                "english",
                Provider::SteamStore,
                "HTTP_RATE_LIMITED",
                100,
            )
            .unwrap();
        }
        let s = Store::open(&f.0).unwrap();
        let row = s
            .get(480, "english", Provider::SteamStore, 150)
            .unwrap()
            .unwrap();
        assert_eq!(row.retry_after, 220);
        assert!(row.data.is_none());
        assert!(row.observation.observed_at.is_none());
        assert_eq!(row.observation.freshness, Freshness::Unknown);
        assert!(s
            .get(480, "english", Provider::SteamCmd, 150)
            .unwrap()
            .is_none());
    }
}
