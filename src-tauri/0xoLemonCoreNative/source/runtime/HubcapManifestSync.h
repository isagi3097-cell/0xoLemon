// _0xoLemonCore - Steam client hook layer for SteaMidra.
// Hubcap Single Manifest Auto-Updater & Synchronizer.

#pragma once

#include <cstddef>
#include <cstdint>
#include <string>
#include <vector>

#include <filesystem>

namespace HubcapManifestSync {

    // Why a single-manifest fetch ended the way it did. The reason matters for
    // throttling decisions: after RateLimited/Unauthorized every further request
    // is wasted, so the caller must answer from disk until the window expires.
    enum class FetchState {
        Success,
        NoProvider,
        RateLimited,
        Unauthorized,
        Failed
    };

    struct FetchExOutcome {
        FetchState state = FetchState::Failed;
        int        status = 0;
    };

    // Validates whether data buffer represents a valid Steam depot manifest (magic 0x71F617D0 or zip header)
    bool IsValidManifestBuffer(const void* data, size_t size);

    // Validates whether a file on disk is a valid Steam depot manifest (size >= 64 and valid magic bytes)
    bool IsValidManifestFile(const std::filesystem::path& path);

    // Checks Launcher Vault and lua-source-backups in %APPDATA% and auto-heals into Steam depotcache if found
    bool TryAutoHealFromVault(uint32_t depotId, uint64_t gid);

    // True when <Steam>/depotcache/<depotId>_<gid>.manifest exists and passes validation.
    // Pure read — never touches the vault and never hits the network.
    bool IsManifestOnDisk(uint32_t depotId, uint64_t gid);

    // Copies a depotcache manifest for this depot into the launcher vault.
    // Used after a successful download so the vault stays in sync for offline installs.
    void ArchiveManifestToVault(uint32_t depotId, uint64_t gid);

    // Starts the background worker thread. Performs an initial check/sync
    // after a short delay (e.g. 5 seconds) to avoid slowing Steam startup,
    // and then periodically (default every 30 minutes) checks installed Lua games
    // for missing depot manifests and downloads them from Hubcap.
    void StartBackgroundWorker();

    // Stops the background worker thread (called on DLL detach).
    void StopBackgroundWorker();

    // Triggers an immediate asynchronous check and sync across all installed Lua files.
    // Called when DirWatch detects that a .lua file was added or updated.
    void TriggerSync();

    // Synchronously checks and, if missing from Steam depotcache and Launcher Vault,
    // fetches the single manifest for (depotId, gid) from Hubcap Manifest API.
    // Writes to <Steam>/depotcache/<depotId>_<gid>.manifest and Launcher Vault.
    // Returns true if the manifest is now present in depotcache and is valid.
    //
    // BLOCKS the caller for up to the HTTP timeout (45s Hubcap / 25s ManifestHub).
    // Do NOT call this from a Steam UI-thread hook; use EnsureManifestAsync there.
    bool EnsureManifest(uint32_t depotId, uint64_t gid);

    // Non-blocking variant for UI-thread callers (the BuildDepotDependency hook).
    // Queues the depot on a dedicated worker and returns immediately:
    //   * true  - the manifest is already on disk / in the vault, so the caller
    //             can bind the gid right now with no wait at all;
    //   * false - it is not on disk yet and the fetch has been queued. The caller
    //             must NOT block; Steam rebuilds the dependency list repeatedly
    //             during an install, so a later pass picks the manifest up.
    //
    // Deduped per (depotId, gid): queueing the same pair twice is a no-op, so the
    // dozens of BuildDepotDependency calls per session only ever cost one fetch.
    // The queue is bounded; overflow drops the oldest pending entry rather than
    // growing without limit.
    bool EnsureManifestAsync(uint32_t depotId, uint64_t gid);

    // Starts the dedicated async-fetch worker. Idempotent.
    void StartAsyncWorker();

    // Stops the async-fetch worker and drains the queue. Called on DLL detach.
    void StopAsyncWorker();

    // Number of fetches currently queued but not yet completed. Diagnostics only.
    size_t AsyncQueueDepth();

    // True when (depotId, gid) was attempted recently — succeeded or failed — and
    // must therefore be answered from disk instead of from the manifest API.
    // Also used to fail a Steam manifest request code fast (no 45s stall) while
    // the window is open, so the game shows a clean error instead of a hang.
    bool IsManifestFetchCoolingDown(uint32_t depotId, uint64_t gid);

    // Runs a full check across all installed Lua files in Steam\config\stplug-in\*.lua
    // and checks depotcache. If any manifest is missing or outdated, downloads it.
    // Returns the number of manifests downloaded/auto-healed.
    size_t CheckAndSyncAll();

    // Resolves the active Hubcap API key (from Settings, env, or decrypted from %APPDATA% launcher settings).
    std::string GetHubcapApiKey();

    // Resolves the active ManifestHub API key if configured.
    std::string GetManifestHubApiKey();

    // Resolves the public GID for an app depot from the Hubcap /contents endpoint (free, 0 quota).
    bool FetchGidFromHubcapContents(uint32_t appId, uint32_t depotId, uint64_t& outGid);

    // Resolves the public GID for an app depot from the metadata mirror, with Hubcap contents fallback.
    bool FetchPublicGidFromMetadata(uint32_t appId, uint32_t depotId, uint64_t& outGid);

} // namespace HubcapManifestSync
