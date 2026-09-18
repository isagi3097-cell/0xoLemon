// _0xoLemonCore - Steam client hook layer for SteaMidra.
// Copyright (c) 2025-2026 Midrag (https://github.com/Midrags).
// Distributed under the GNU General Public License v3 or later.
// See <https://www.gnu.org/licenses/> for the full license text.
//
// Persistent manifest state, mirroring the behaviour HubcapTools gets from
// its on-disk cache/ directory. Three independent stores, all keyed on
// (depotId, gid) and all surviving a Steam restart:
//
//   * Request-code cache  - a manifest_request_code that Hubcap already
//     resolved for this exact depot+gid is valid for the life of that build,
//     so re-asking on every Steam boot burns quota for an answer we have.
//   * Unauthorized set    - a gid the provider answered 401/403 for will
//     answer 401/403 forever (the key/ownership is what is wrong, not the
//     request). HubcapTools skips the MRC call for those outright; we do the
//     same and fall straight to the blob path.
//   * Negative set        - a *definitive* provider not_found (a real 404 /
//     "no such manifest", not a transport error) is remembered so the next
//     install attempt fails fast instead of re-requesting.
//
// Everything is best-effort and never fatal: a failed read/write degrades to
// an empty (or un-persisted) store, exactly like the in-memory behaviour the
// core had before. Writes are atomic via a .tmp + rename, matching how
// manifests themselves are persisted.

#ifndef OXOLEMONCORE_MANIFEST_STATE_CACHE_H
#define OXOLEMONCORE_MANIFEST_STATE_CACHE_H

#include <cstdint>
#include <optional>
#include <string>

namespace ManifestStateCache
{

    // Loads all three stores from disk into memory. Safe to call more than
    // once; the second call is a no-op. Called automatically on first use.
    void LoadOnce();

    // ---- request-code cache -------------------------------------------------

    // Returns a previously persisted request code for this exact depot+gid.
    std::optional<uint64_t> GetRequestCode(uint32_t depotId, uint64_t gid);

    // Persists a resolved request code. Skips gid==0 and code==0 because
    // neither is a usable manifest request code (Steam answers code 0 with
    // "Access Denied", which is the failure mode the depotcache-first path
    // exists to avoid).
    void PutRequestCode(uint32_t depotId, uint64_t gid, uint64_t code);

    // ---- unauthorized set ---------------------------------------------------

    // True when the provider previously answered 401/403 for depot+gid.
    bool IsUnauthorized(uint32_t depotId, uint64_t gid);

    // Flags a depot+gid as permanently unauthorized and persists the change.
    void MarkUnauthorized(uint32_t depotId, uint64_t gid);

    // ---- definitive not_found ----------------------------------------------

    // True when the provider definitively reported this depot+gid as absent.
    bool IsKnownNotFound(uint32_t depotId, uint64_t gid);

    // Records a definitive not_found and persists it.
    void MarkNotFound(uint32_t depotId, uint64_t gid);

    // ---- resolved live gids -------------------------------------------------

    // The gid the provider last reported serving for `depotId`. Persisted so a
    // depot's "follow the provider" verdict survives a Steam restart: the next
    // launch knows a non-pinned depot's Lua gid is stale without asking the
    // network again, and without the launcher being open at the time.
    std::optional<uint64_t> GetLiveGid(uint32_t depotId);

    // Records the provider's answer for `depotId`. A zero gid is ignored: an
    // unresolved lookup must never overwrite a good answer.
    void PutLiveGid(uint32_t depotId, uint64_t gid);

    // ---- unservable depots --------------------------------------------------

    // Counts one CM/providers failure to produce a request code for `depotId`.
    // Returns the running total for this depot.
    int NoteUnservableAttempt(uint32_t depotId);

    // True once a depot has failed to produce a request code kUnservableThreshold
    // times. Callers use this to drop the depot from Steam's dependency vector
    // so it stops retrying a depot that will never be servable.
    bool IsUnservable(uint32_t depotId);

    // Clears the unservable counter (e.g. after a manifest eventually lands).
    void ClearUnservable(uint32_t depotId);

    // ---- maintenance --------------------------------------------------------

    // Drops the whole persisted state. Used on Lua hot-reload, where the pins
    // and gids we cached may no longer describe the active config.
    void ClearAll();

    // Absolute path of the JSON store, for logging/diagnostics.
    std::string StorePathForLog();

} // namespace ManifestStateCache

#endif // OXOLEMONCORE_MANIFEST_STATE_CACHE_H
