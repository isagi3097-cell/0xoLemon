// _0xoLemonCore - Steam client hook layer for SteaMidra.
// Auto-Retry Manager for multi-depot and background-fetched games.

#pragma once

#include <cstdint>
#include "Steam/Types.h"

namespace AutoRetry {
    // Starts the background worker thread.
    void Start();

    // Stops the background worker thread.
    void Stop();

    // Records that Steam requested a manifest for (depotId, gid), belonging to parentAppId.
    // If the manifest is already present on disk in Steam depotcache, this is a no-op.
    void TrackManifestRequest(AppId_t parentAppId, uint32_t depotId, uint64_t gid);

    // Notifies that a manifest has landed on disk and is valid.
    void OnManifestReady(uint32_t depotId, uint64_t gid);

    // Notifies that a manifest fetch failed permanently or timed out.
    void OnManifestFailed(uint32_t depotId, uint64_t gid);

    // Directly triggers an install / resume for the given game.
    bool TriggerInstallRetry(AppId_t appId);
}
