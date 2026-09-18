// _0xoLemonCore - Steam client hook layer for SteaMidra.
// Copyright (c) 2025-2026 Midrag (https://github.com/Midrags).
// Distributed under the GNU General Public License v3 or later.
// See <https://www.gnu.org/licenses/> for the full license text.
//
// SteamlessWatch — background watcher that strips SteamStub from Lua-tracked
// games as soon as Steam reports the download finished.
//
// Steam publishes per-app download state in
//   <library>/steamapps/appmanifest_<appid>.acf
// under the "StateFlags" key. While a download runs, the flags carry
// UpdateRunning/Downloading/Staging/Committing; when it settles they clear
// and (fully-installed) bit 4 is set. This module polls those manifests for a
// Lua-tracked app and, on the downloading -> installed edge, runs the native
// Steamless remover against the game's main executable.
//
// Only apps the Lua layer already tracks AND that are not owned are
// considered (the same gate SteamStubAuto uses), so the watcher never
// touches a game the user actually owns on Steam.
#pragma once
#include "Steam/Types.h"

#include <string>

namespace SteamlessWatch {

    // Starts the watcher thread. Idempotent. Does nothing when
    // Settings::steamlessAutoEnabled is false.
    void Start();

    // Stops the watcher and joins the thread (called on DLL detach).
    void Stop();

    // Force a single synchronous sweep over every Lua-tracked app right now,
    // regardless of the poll schedule. Used right after a Lua file is dropped
    // so a game that finished downloading before the .lua appeared still gets
    // fixed. Blocking — never call from a Steam UI thread.
    void ScanNow();

    // Manually fix / restore one app. These back the Lua bindings
    // steamlessApply(appId) / steamlessRestore(appId) so a shop script can
    // drive the remover on demand. Both are BLOCKING (read+rewrite the whole
    // game exe) — never call from a Steam UI thread. Return a short
    // user-facing status string.
    std::string FixAppNow(AppId_t appId);
    std::string RestoreAppNow(AppId_t appId);

    enum class LaunchFixResult {
        Disabled,
        NotEligible,
        AlreadyClean,
        Applied,
        Failed,
    };

    // Play-button fallback. Called from the CUser_SpawnProcess hook with the
    // exact exe Steam is about to launch. This deliberately completes before
    // the hook resumes the spawn: otherwise Steam can open the original image
    // while Steamless is still rewriting it, and a restored original may never
    // be fixed. The returned result also enforces Steamless-first routing — a
    // successful/clean result suppresses the runtime SteamStub fallback, while
    // Failed leaves that fallback eligible.
    LaunchFixResult OnGameLaunch(AppId_t appId, const std::string& exePath);

} // namespace SteamlessWatch
