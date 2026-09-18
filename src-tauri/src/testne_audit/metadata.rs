//! Bounded laboratory observation cache. JSON is an index, never executable
//! input; payloads are immutable, content-addressed blobs. No live provider.

use super::{err, read_bounded, sha256, Freshness, LabRoot};
use fs2::FileExt;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};
use std::fs::{self, File, OpenOptions};
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::sync::{Arc, Condvar, Mutex};

const MAX_CONCURRENT: usize = 4;
const MAX_ENTRIES: usize = 500;
const MAX_BLOB_BYTES: usize = 512 * 1024;
const MAX_TOTAL_BLOB_BYTES: u64 = 32 * 1024 * 1024;
const SUCCESS_TTL_MS: u64 = 10 * 60_000;
const FAILURE_TTL_MS: u64 = 2 * 60_000;
const PROVIDER_TTL_MS: u64 = 5 * 60_000;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MetadataKey {
    pub app_id: u32,
    pub locale: String,
    pub provider: String,
    pub schema_revision: String,
}

impl MetadataKey {
    fn id(&self) -> Result<String, String> {
        if self.app_id == 0
            || [&self.locale, &self.provider, &self.schema_revision]
                .iter()
                .any(|v| v.is_empty() || v.len() > 128)
        {
            return Err("Invalid metadata cache identity".into());
        }
        Ok(sha256(&serde_json::to_vec(self).map_err(err)?))
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MetadataPayload {
    pub data: Value,
    /// Adapter-validated completeness, not a value trusted from remote JSON.
    /// A lower score cannot silently replace an existing richer observation.
    pub completeness: u32,
}

#[derive(Debug, Clone)]
pub(crate) struct MetadataObservation {
    pub payload: Option<MetadataPayload>,
    pub freshness: Freshness,
    pub observed_at: Option<u64>,
    pub last_error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Entry {
    key: MetadataKey,
    blob: Option<String>,
    blob_bytes: u64,
    observed_at: Option<u64>,
    expires_at: u64,
    failure_until: u64,
    last_error: Option<String>,
    order: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProviderUsage {
    pub used: Option<u64>,
    pub limit: Option<u64>,
    pub credential_valid: Option<bool>,
    pub service_ready: Option<bool>,
    pub expires_at: Option<u64>,
}

impl ProviderUsage {
    pub fn remaining(&self) -> Option<u64> {
        self.limit
            .zip(self.used)
            .map(|(limit, used)| limit.saturating_sub(used))
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProviderEntry {
    usage: ProviderUsage,
    observed_at: u64,
    last_error: Option<String>,
}

#[derive(Debug, Clone)]
pub(crate) struct ProviderObservation {
    pub usage: Option<ProviderUsage>,
    pub freshness: Freshness,
    pub observed_at: Option<u64>,
    pub last_error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Index {
    version: u32,
    next_order: u64,
    entries: BTreeMap<String, Entry>,
    providers: BTreeMap<String, ProviderEntry>,
    owned_blobs: BTreeSet<String>,
}

impl Default for Index {
    fn default() -> Self {
        Self {
            version: 1,
            next_order: 0,
            entries: BTreeMap::new(),
            providers: BTreeMap::new(),
            owned_blobs: BTreeSet::new(),
        }
    }
}

struct State {
    index: Index,
    active_keys: BTreeSet<String>,
}

pub(crate) struct ObservationCache {
    lab: LabRoot,
    clock: Arc<dyn Fn() -> u64 + Send + Sync>,
    state: Mutex<State>,
    changed: Condvar,
    _directory_lock: File,
}

fn valid_hash(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

impl ObservationCache {
    pub fn open(lab: LabRoot, clock: Arc<dyn Fn() -> u64 + Send + Sync>) -> Result<Self, String> {
        lab.validate()?;
        let lock = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(lab.file("cache.lock")?)
            .map_err(err)?;
        lock.try_lock_exclusive()
            .map_err(|_| "Laboratory cache is already open".to_string())?;
        let path = lab.file("cache-index.json")?;
        let index = if path.exists() {
            if fs::metadata(&path).map_err(err)?.len() > 2 * 1024 * 1024 {
                return Err("Cache index exceeds size budget".into());
            }
            let bytes = read_bounded(&path, 2 * 1024 * 1024).map_err(err)?;
            let index: Index = serde_json::from_slice(&bytes)
                .map_err(|e| format!("Malformed cache index preserved: {e}"))?;
            if index.version != 1
                || index.entries.len() > MAX_ENTRIES
                || index.providers.len() > MAX_ENTRIES
                || index.owned_blobs.len() > MAX_ENTRIES + 1
            {
                return Err("Unsupported or oversized cache index preserved".into());
            }
            for (id, entry) in &index.entries {
                if entry.key.id()? != *id
                    || entry.blob_bytes > MAX_BLOB_BYTES as u64
                    || entry
                        .blob
                        .as_ref()
                        .is_some_and(|hash| !valid_hash(hash) || !index.owned_blobs.contains(hash))
                {
                    return Err("Invalid cache entry preserved".into());
                }
            }
            if index.owned_blobs.iter().any(|hash| !valid_hash(hash)) {
                return Err("Invalid owned blob identity".into());
            }
            index
        } else {
            Index::default()
        };
        Ok(Self {
            lab,
            clock,
            state: Mutex::new(State {
                index,
                active_keys: BTreeSet::new(),
            }),
            changed: Condvar::new(),
            _directory_lock: lock,
        })
    }

    fn read_payload(&self, entry: &Entry) -> Result<Option<MetadataPayload>, String> {
        let Some(hash) = &entry.blob else {
            return Ok(None);
        };
        let path = self.lab.file(&format!("blob-{hash}.json"))?;
        let metadata = fs::metadata(&path).map_err(err)?;
        if metadata.len() != entry.blob_bytes || metadata.len() > MAX_BLOB_BYTES as u64 {
            return Err("Cache blob size mismatch; preserved for audit".into());
        }
        let bytes = read_bounded(&path, MAX_BLOB_BYTES).map_err(err)?;
        if sha256(&bytes) != *hash {
            return Err("Cache blob hash mismatch; preserved for audit".into());
        }
        serde_json::from_slice(&bytes).map(Some).map_err(err)
    }

    fn observation(&self, entry: &Entry, now: u64) -> Result<MetadataObservation, String> {
        let payload = self.read_payload(entry)?;
        let freshness = if payload.is_none() {
            Freshness::Unknown
        } else if entry.expires_at > now && entry.last_error.is_none() {
            Freshness::Fresh
        } else {
            Freshness::Stale
        };
        Ok(MetadataObservation {
            payload,
            freshness,
            observed_at: entry.observed_at,
            last_error: entry.last_error.clone(),
        })
    }

    pub fn fetch(
        &self,
        key: MetadataKey,
        provider: impl FnOnce() -> Result<MetadataPayload, String>,
    ) -> Result<MetadataObservation, String> {
        let id = key.id()?;
        let mut state = self
            .state
            .lock()
            .map_err(|_| "Cache lock poisoned".to_string())?;
        loop {
            let now = (self.clock)();
            if let Some(entry) = state.index.entries.get(&id) {
                if entry.expires_at > now || entry.failure_until > now {
                    return self.observation(entry, now);
                }
            }
            if !state.active_keys.contains(&id) && state.active_keys.len() < MAX_CONCURRENT {
                state.active_keys.insert(id.clone());
                break;
            }
            state = self
                .changed
                .wait(state)
                .map_err(|_| "Cache lock poisoned".to_string())?;
        }
        drop(state);
        // Provider failure (including panic) must release the single-flight slot.
        let fetched = catch_unwind(AssertUnwindSafe(provider))
            .unwrap_or_else(|_| Err("Provider panicked".into()));
        let mut state = self
            .state
            .lock()
            .map_err(|_| "Cache lock poisoned".to_string())?;
        let result = self.record_result(&mut state.index, id.clone(), key, fetched);
        state.active_keys.remove(&id);
        self.changed.notify_all();
        result
    }

    fn persist(&self, index: &Index) -> Result<(), String> {
        self.lab
            .write_atomic("cache-index.json", &serde_json::to_vec(index).map_err(err)?)
    }

    fn record_result(
        &self,
        index: &mut Index,
        id: String,
        key: MetadataKey,
        fetched: Result<MetadataPayload, String>,
    ) -> Result<MetadataObservation, String> {
        let now = (self.clock)();
        let old = index.entries.get(&id).cloned();
        let previous = old
            .as_ref()
            .map(|entry| self.read_payload(entry))
            .transpose()?
            .flatten();
        let fetched = fetched.and_then(|payload| {
            if previous
                .as_ref()
                .is_some_and(|old| payload.completeness < old.completeness)
            {
                Err("INCOMPLETE_METADATA".into())
            } else if !payload.data.is_object() && !payload.data.is_array() {
                Err("INVALID_METADATA".into())
            } else if serde_json::to_vec(&payload).map_err(err)?.len() > MAX_BLOB_BYTES {
                Err("METADATA_TOO_LARGE".into())
            } else {
                Ok(payload)
            }
        });
        let mut next = index.clone();
        next.next_order = next.next_order.saturating_add(1);
        let mut entry = old.unwrap_or(Entry {
            key,
            blob: None,
            blob_bytes: 0,
            observed_at: None,
            expires_at: 0,
            failure_until: 0,
            last_error: None,
            order: next.next_order,
        });
        match fetched {
            Ok(payload) => {
                let bytes = serde_json::to_vec(&payload).map_err(err)?;
                if bytes.len() > MAX_BLOB_BYTES {
                    return Err("Metadata blob exceeds size budget".into());
                }
                let hash = sha256(&bytes);
                let name = format!("blob-{hash}.json");
                let path = self.lab.file(&name)?;
                if path.exists() {
                    if sha256(&read_bounded(&path, MAX_BLOB_BYTES).map_err(err)?) != hash {
                        return Err("Existing immutable blob was modified".into());
                    }
                } else {
                    self.lab.write_new(&name, &bytes)?;
                }
                next.owned_blobs.insert(hash.clone());
                entry.blob = Some(hash);
                entry.blob_bytes = bytes.len() as u64;
                entry.observed_at = Some(now);
                entry.expires_at = now.saturating_add(SUCCESS_TTL_MS);
                entry.failure_until = 0;
                entry.last_error = None;
                entry.order = next.next_order;
            }
            Err(error) => {
                // Keep prior bytes and their observation time. Failure is not a
                // new successful observation and cannot renew freshness.
                entry.failure_until = now.saturating_add(FAILURE_TTL_MS);
                // Persist a bounded code, never a raw HTTP body/URL that might
                // contain a provider credential or signed download parameter.
                entry.last_error = Some(
                    if !error.is_empty()
                        && error.len() <= 64
                        && error.bytes().all(|byte| {
                            byte.is_ascii_uppercase() || byte.is_ascii_digit() || byte == b'_'
                        })
                    {
                        error
                    } else {
                        "PROVIDER_FAILED".into()
                    },
                );
            }
        }
        next.entries.insert(id.clone(), entry);
        while next.entries.len() > MAX_ENTRIES
            || next
                .entries
                .values()
                .map(|entry| entry.blob_bytes)
                .sum::<u64>()
                > MAX_TOTAL_BLOB_BYTES
        {
            let victim = next
                .entries
                .iter()
                .filter(|(key, _)| *key != &id)
                .min_by_key(|(_, value)| value.order)
                .map(|(key, _)| key.clone())
                .ok_or_else(|| "Cache payload cannot fit budget".to_string())?;
            next.entries.remove(&victim);
        }
        self.persist(&next)?;
        *index = next;
        self.prune_owned_blobs(index)?;
        self.observation(&index.entries[&id], now)
    }

    fn prune_owned_blobs(&self, index: &mut Index) -> Result<(), String> {
        let referenced: BTreeSet<_> = index
            .entries
            .values()
            .filter_map(|entry| entry.blob.clone())
            .collect();
        let obsolete: Vec<_> = index.owned_blobs.difference(&referenced).cloned().collect();
        for hash in obsolete {
            let path = self.lab.file(&format!("blob-{hash}.json"))?;
            if path.exists() {
                // No glob/directory deletion; never remove an externally edited
                // file merely because its filename resembles a cache artifact.
                if sha256(&read_bounded(&path, MAX_BLOB_BYTES).map_err(err)?) != hash {
                    return Err("Obsolete cache blob drifted; exact file preserved".into());
                }
                fs::remove_file(path).map_err(err)?;
            }
            index.owned_blobs.remove(&hash);
        }
        self.persist(index)
    }

    fn provider_id(provider: &str, credential_identity: &str) -> Result<String, String> {
        // A caller-generated opaque credential identity, never the API key.
        if provider.is_empty() || provider.len() > 128 || !valid_hash(credential_identity) {
            return Err("Provider cache requires an opaque credential identity".into());
        }
        Ok(sha256(
            format!("{provider}\0{credential_identity}").as_bytes(),
        ))
    }

    pub fn observe_provider(
        &self,
        provider: &str,
        credential_identity: &str,
        usage: ProviderUsage,
    ) -> Result<(), String> {
        let id = Self::provider_id(provider, credential_identity)?;
        let mut state = self
            .state
            .lock()
            .map_err(|_| "Cache lock poisoned".to_string())?;
        let mut next = state.index.clone();
        next.providers.insert(
            id.clone(),
            ProviderEntry {
                usage,
                observed_at: (self.clock)(),
                last_error: None,
            },
        );
        while next.providers.len() > MAX_ENTRIES {
            let oldest = next
                .providers
                .iter()
                .filter(|(key, _)| *key != &id)
                .min_by_key(|(_, entry)| entry.observed_at)
                .map(|(key, _)| key.clone())
                .unwrap();
            next.providers.remove(&oldest);
        }
        self.persist(&next)?;
        state.index = next;
        Ok(())
    }

    pub fn observe_provider_failure(
        &self,
        provider: &str,
        credential_identity: &str,
        error_code: &str,
    ) -> Result<(), String> {
        let id = Self::provider_id(provider, credential_identity)?;
        if !error_code
            .bytes()
            .all(|b| b.is_ascii_uppercase() || b.is_ascii_digit() || b == b'_')
            || error_code.len() > 64
        {
            return Err("Provider errors must be non-secret codes".into());
        }
        let mut state = self
            .state
            .lock()
            .map_err(|_| "Cache lock poisoned".to_string())?;
        let mut next = state.index.clone();
        if let Some(entry) = next.providers.get_mut(&id) {
            entry.last_error = Some(error_code.into());
            self.persist(&next)?;
            state.index = next;
        }
        Ok(())
    }

    pub fn provider(
        &self,
        provider: &str,
        credential_identity: &str,
    ) -> Result<ProviderObservation, String> {
        let id = Self::provider_id(provider, credential_identity)?;
        let state = self
            .state
            .lock()
            .map_err(|_| "Cache lock poisoned".to_string())?;
        let Some(entry) = state.index.providers.get(&id) else {
            return Ok(ProviderObservation {
                usage: None,
                freshness: Freshness::Unknown,
                observed_at: None,
                last_error: None,
            });
        };
        let now = (self.clock)();
        let fresh = now < entry.observed_at.saturating_add(PROVIDER_TTL_MS)
            && entry.usage.expires_at.is_none_or(|expires| expires > now)
            && entry.last_error.is_none();
        Ok(ProviderObservation {
            usage: Some(entry.usage.clone()),
            freshness: if fresh {
                Freshness::Fresh
            } else {
                Freshness::Stale
            },
            observed_at: Some(entry.observed_at),
            last_error: entry.last_error.clone(),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
    use std::thread;
    use std::time::Duration;

    fn clock() -> (Arc<AtomicU64>, Arc<dyn Fn() -> u64 + Send + Sync>) {
        let now = Arc::new(AtomicU64::new(1000));
        let shared = now.clone();
        (now, Arc::new(move || shared.load(Ordering::SeqCst)))
    }
    fn key(app_id: u32, locale: &str) -> MetadataKey {
        MetadataKey {
            app_id,
            locale: locale.into(),
            provider: "fixture".into(),
            schema_revision: "1".into(),
        }
    }
    fn payload(locale: &str, completeness: u32) -> MetadataPayload {
        MetadataPayload {
            data: json!({"locale": locale, "achievement": {"id":"A", "name": "Tên", "description":"Nội dung"}}),
            completeness,
        }
    }

    #[test]
    fn locales_revisions_and_providers_are_separate_and_restart_keeps_blobs() {
        let lab = LabRoot::create(&LabRoot::approved_parent()).unwrap();
        let (_, clock) = clock();
        let cache = ObservationCache::open(lab.clone(), clock.clone()).unwrap();
        for locale in ["vi", "en"] {
            assert_eq!(
                cache
                    .fetch(key(480, locale), || Ok(payload(locale, 3)))
                    .unwrap()
                    .payload
                    .unwrap()
                    .data["locale"],
                locale
            );
        }
        let mut other = key(480, "vi");
        other.schema_revision = "2".into();
        cache
            .fetch(other.clone(), || Ok(payload("revision2", 3)))
            .unwrap();
        other.provider = "another".into();
        cache.fetch(other, || Ok(payload("provider2", 3))).unwrap();
        assert_eq!(cache.state.lock().unwrap().index.entries.len(), 4);
        drop(cache);
        let reopened = ObservationCache::open(lab, clock).unwrap();
        let result = reopened
            .fetch(key(480, "vi"), || {
                panic!("Must use persistent fresh observation")
            })
            .unwrap();
        assert_eq!(result.payload.unwrap(), payload("vi", 3));
        assert_eq!(result.freshness, Freshness::Fresh);
    }

    #[test]
    fn stale_on_error_keeps_exact_rich_schema_and_failure_backoff() {
        let lab = LabRoot::create(&LabRoot::approved_parent()).unwrap();
        let (now, clock) = clock();
        let cache = ObservationCache::open(lab, clock).unwrap();
        let good = cache
            .fetch(key(480, "vi"), || Ok(payload("vi", 4)))
            .unwrap();
        now.fetch_add(SUCCESS_TTL_MS, Ordering::SeqCst);
        let stale = cache
            .fetch(key(480, "vi"), || Ok(payload("en-only", 1)))
            .unwrap();
        assert_eq!(stale.payload, good.payload);
        assert_eq!(stale.observed_at, good.observed_at);
        assert_eq!(stale.freshness, Freshness::Stale);
        assert_eq!(stale.last_error.as_deref(), Some("INCOMPLETE_METADATA"));
        cache
            .fetch(key(480, "vi"), || {
                panic!("Failure TTL must coalesce retries")
            })
            .unwrap();
        now.fetch_add(FAILURE_TTL_MS, Ordering::SeqCst);
        let offline = cache
            .fetch(key(480, "vi"), || Err("OFFLINE".into()))
            .unwrap();
        assert_eq!(offline.payload, good.payload);
        assert_eq!(offline.last_error.as_deref(), Some("OFFLINE"));
    }

    #[test]
    fn concurrent_same_key_is_single_flight_and_provider_parallelism_is_four() {
        let lab = LabRoot::create(&LabRoot::approved_parent()).unwrap();
        let (_, clock) = clock();
        let cache = Arc::new(ObservationCache::open(lab, clock).unwrap());
        let calls = Arc::new(AtomicUsize::new(0));
        let barrier = Arc::new(std::sync::Barrier::new(12));
        let threads: Vec<_> = (0..12)
            .map(|_| {
                let cache = cache.clone();
                let calls = calls.clone();
                let barrier = barrier.clone();
                thread::spawn(move || {
                    barrier.wait();
                    cache
                        .fetch(key(480, "vi"), || {
                            calls.fetch_add(1, Ordering::SeqCst);
                            thread::sleep(Duration::from_millis(30));
                            Ok(payload("vi", 1))
                        })
                        .unwrap()
                })
            })
            .collect();
        for worker in threads {
            assert_eq!(worker.join().unwrap().freshness, Freshness::Fresh);
        }
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        let active = Arc::new(AtomicUsize::new(0));
        let maximum = Arc::new(AtomicUsize::new(0));
        let barrier = Arc::new(std::sync::Barrier::new(4));
        let threads: Vec<_> = (1..=12)
            .map(|app_id| {
                let cache = cache.clone();
                let active = active.clone();
                let maximum = maximum.clone();
                let barrier = barrier.clone();
                thread::spawn(move || {
                    cache
                        .fetch(key(app_id, "vi"), || {
                            let count = active.fetch_add(1, Ordering::SeqCst) + 1;
                            maximum.fetch_max(count, Ordering::SeqCst);
                            barrier.wait();
                            thread::sleep(Duration::from_millis(10));
                            active.fetch_sub(1, Ordering::SeqCst);
                            Ok(payload("vi", 1))
                        })
                        .unwrap()
                })
            })
            .collect();
        for worker in threads {
            worker.join().unwrap();
        }
        assert_eq!(maximum.load(Ordering::SeqCst), MAX_CONCURRENT);
    }

    #[test]
    fn bounded_index_evicts_only_exact_owned_blobs() {
        let lab = LabRoot::create(&LabRoot::approved_parent()).unwrap();
        lab.write_new("unrelated.json", b"user file").unwrap();
        let (_, clock) = clock();
        let cache = ObservationCache::open(lab.clone(), clock).unwrap();
        for app in 1..=(MAX_ENTRIES as u32 + 2) {
            cache
                .fetch(key(app, "en"), || {
                    Ok(MetadataPayload {
                        data: json!({"app":app}),
                        completeness: 1,
                    })
                })
                .unwrap();
        }
        let state = cache.state.lock().unwrap();
        assert_eq!(state.index.entries.len(), MAX_ENTRIES);
        assert_eq!(state.index.owned_blobs.len(), MAX_ENTRIES);
        assert!(!state
            .index
            .entries
            .contains_key(&key(1, "en").id().unwrap()));
        assert_eq!(
            fs::read(lab.file("unrelated.json").unwrap()).unwrap(),
            b"user file"
        );
    }

    #[test]
    fn provider_restart_stale_expiry_and_key_change_never_invent_quota() {
        let lab = LabRoot::create(&LabRoot::approved_parent()).unwrap();
        let (now, clock) = clock();
        let credential = sha256(b"opaque credential identity A");
        let cache = ObservationCache::open(lab.clone(), clock.clone()).unwrap();
        assert_eq!(
            cache.provider("hubcap", &credential).unwrap().freshness,
            Freshness::Unknown
        );
        let usage = ProviderUsage {
            used: Some(42),
            limit: Some(100),
            credential_valid: Some(true),
            service_ready: None,
            expires_at: Some(900_000),
        };
        cache
            .observe_provider("hubcap", &credential, usage.clone())
            .unwrap();
        drop(cache);
        let cache = ObservationCache::open(lab.clone(), clock).unwrap();
        let initial = fs::read(lab.file("cache-index.json").unwrap()).unwrap();
        let observation = cache.provider("hubcap", &credential).unwrap();
        assert_eq!(observation.usage.unwrap().remaining(), Some(58));
        assert_eq!(observation.observed_at, Some(1000));
        assert_eq!(
            fs::read(lab.file("cache-index.json").unwrap()).unwrap(),
            initial
        );
        now.fetch_add(PROVIDER_TTL_MS, Ordering::SeqCst);
        assert_eq!(
            cache.provider("hubcap", &credential).unwrap().freshness,
            Freshness::Stale
        );
        let unknown = cache.provider("hubcap", &sha256(b"identity B")).unwrap();
        assert!(unknown.usage.is_none());
        assert!(unknown.observed_at.is_none());
        assert!(cache.provider("hubcap", "a raw API key").is_err());
        now.store(899_999, Ordering::SeqCst);
        cache
            .observe_provider("hubcap", &credential, usage)
            .unwrap();
        now.store(900_000, Ordering::SeqCst);
        assert_eq!(
            cache.provider("hubcap", &credential).unwrap().freshness,
            Freshness::Stale
        );
        cache
            .observe_provider_failure("hubcap", &credential, "RATE_LIMITED")
            .unwrap();
        assert_eq!(
            cache
                .provider("hubcap", &credential)
                .unwrap()
                .last_error
                .as_deref(),
            Some("RATE_LIMITED")
        );
        let no_observation = ProviderUsage {
            used: None,
            limit: Some(100),
            credential_valid: None,
            service_ready: None,
            expires_at: None,
        };
        assert_eq!(no_observation.remaining(), None);
    }

    #[test]
    fn malformed_index_and_same_size_blob_tamper_are_preserved_not_overwritten() {
        let lab = LabRoot::create(&LabRoot::approved_parent()).unwrap();
        let (_, clock) = clock();
        lab.write_new("cache-index.json", b"malformed").unwrap();
        assert!(ObservationCache::open(lab.clone(), clock.clone()).is_err());
        assert_eq!(
            fs::read(lab.file("cache-index.json").unwrap()).unwrap(),
            b"malformed"
        );
        let clean = LabRoot::create(&LabRoot::approved_parent()).unwrap();
        let cache = ObservationCache::open(clean.clone(), clock).unwrap();
        cache
            .fetch(key(480, "en"), || Ok(payload("en", 1)))
            .unwrap();
        let hash = cache
            .state
            .lock()
            .unwrap()
            .index
            .entries
            .values()
            .next()
            .unwrap()
            .blob
            .clone()
            .unwrap();
        let path = clean.file(&format!("blob-{hash}.json")).unwrap();
        let original_metadata = fs::metadata(&path).unwrap();
        let mut bytes = fs::read(&path).unwrap();
        let len = bytes.len();
        bytes[len - 2] ^= 1;
        fs::write(&path, &bytes).unwrap();
        File::options()
            .write(true)
            .open(&path)
            .unwrap()
            .set_times(fs::FileTimes::new().set_modified(original_metadata.modified().unwrap()))
            .unwrap();
        assert_eq!(fs::metadata(&path).unwrap().len(), original_metadata.len());
        assert_eq!(
            fs::metadata(&path).unwrap().modified().unwrap(),
            original_metadata.modified().unwrap()
        );
        assert!(cache
            .fetch(key(480, "en"), || panic!(
                "Tamper must not trigger silent overwrite"
            ))
            .is_err());
        assert_eq!(fs::read(path).unwrap(), bytes);
    }

    #[test]
    fn provider_panic_releases_slot_and_directory_lock_prevents_two_writers() {
        let lab = LabRoot::create(&LabRoot::approved_parent()).unwrap();
        let (_, clock) = clock();
        let cache = ObservationCache::open(lab.clone(), clock.clone()).unwrap();
        assert!(ObservationCache::open(lab, clock).is_err());
        let failed = cache
            .fetch(key(1, "en"), || panic!("fixture panic"))
            .unwrap();
        assert_eq!(failed.freshness, Freshness::Unknown);
        assert!(failed.payload.is_none());
        assert!(cache.state.lock().unwrap().active_keys.is_empty());
        assert_eq!(
            cache
                .fetch(key(2, "en"), || Ok(payload("en", 1)))
                .unwrap()
                .freshness,
            Freshness::Fresh
        );
    }
}
