// _0xoLemonCore - Steam client hook layer for SteaMidra.
// Copyright (c) 2025-2026 Midrag (https://github.com/Midrags).
// Distributed under the GNU General Public License v3 or later.
// See <https://www.gnu.org/licenses/> for the full license text.

#pragma once

#include <atomic>
#include <string>
#include <vector>
#include <windows.h>
#include "runtime/InjectionPolicy.h"

namespace Settings {

    enum class LogLevel { Trace, Debug, Info, Warn, Error };

    void Load(const std::string& configPath);
    struct ReloadResult { bool reloaded = false; bool luaPathsChanged = false; };
    ReloadResult ReloadIfChanged();

    // [log]
    inline LogLevel logLevel = LogLevel::Debug;

    // When true, every per-module logger is forced to Trace at startup so
    // we get the most detailed possible log of every IPC, network packet,
    // and hook call. Useful for diagnosing launch failures (Steam error 54
    // and similar). Defaults on so users do not need to touch config.toml
    // before sending logs.
    inline bool verbose = true;

    // derived from configPath: <steam>/_0xolemoncore/
    inline std::string logDir;

    // [lua]
    inline std::vector<std::string> luaPaths;

    // [lua] http_allowlist
    // Extra hosts that lcHttpGet() lua binding may reach. The default set
    // (manifesthub, github raw, jsdelivr cdn) is hardcoded and always
    // honoured even when the user clears this list. Any host in this
    // list is matched case-insensitively against the URL's host portion;
    // exact match only, no wildcards. Anything not on the combined list
    // gets a 403/empty-body response without the network ever being hit,
    // which is the data-exfil mitigation. Adding "*" is treated as
    // empty (we do NOT support disabling the gate).
    inline std::vector<std::string> luaHttpAllowlistExtra;

    // [pattern_fetch] mirror
    // Optional URL template for the pattern repo, with {subdir} and {sha}
    // placeholders. Empty string means "no override; go straight to the
    // GitHub primary -> jsDelivr -> gitflic -> local cache fallback chain".
    inline std::string patternMirror;

    // [pattern_fetch] gitflic_enabled
    // gitflic.ru fallback for users in regions where github + jsdelivr are
    // blocked or rate-limited (RU primarily). Sits after the github + cdn
    // legs and before the local cache. Set to false to skip it entirely.
    inline bool patternGitflicEnabled = true;

    // [pattern_fetch] require_signed
    // When true, the pattern fetcher refuses every TOML body whose .sig
    // sidecar fails RSA-PSS-SHA256 verification against the _0xoLemonCore-
    // embedded public key. The signature lives at <body_url>.sig — same
    // path with a ".sig" suffix appended. When false, we still verify and
    // log a warning on a missing/bad signature but installed entries from
    // unsigned legs are accepted for back-compat with pattern repos that
    // haven't started shipping signatures yet. Default false until the
    // pattern repo rolls out signed TOMLs across the whole tree, then
    // flip this to true to make rejection fatal.
    inline bool patternRequireSigned = false;

    // [manifest_fetch]
    // URL templates the wire-level GetManifestRequestCode bridge hits when
    // Steam asks for a manifest gid we have a depot binding for but the
    // server returned eresult != OK. Placeholders: {gid}, {appid}, {depotid}.
    // The body is parsed as either a plain decimal uint64 OR a JSON object
    // with a "content" digit-string field, so wudrm-style and steam.run-style
    // endpoints both work as is.
    //
    // The list is tried in order, first one that gives back a parseable code
    // wins. An empty list (e.g. user set [manifest_fetch] urls = []) disables
    // the bridge and lets the original eresult fall through.
    //
    // Single-string [manifest_fetch] url = "..." is honoured for back-compat
    // by Settings::Load: when present it OVERRIDES the chain (single-URL mode).
    // [manifest_fetch] urls = [...] takes precedence over the single form.
    inline std::vector<std::string> manifestFetchUrls = {
        "https://manifest.steam.run/api/manifest/{gid}",
        "https://manifest.opensteamtool.com/{gid}",
        "http://gmrc.wudrm.com/manifest/{gid}",
    };

    // Minimum wall clock the recv handler waits on the HTTP future before
    // letting the original eresult fall through. This is a FLOOR, not a cap:
    // ManifestFetch raises it to at least 55s internally so a Hubcap single
    // manifest generate (up to 45s on a slow link) finishes within the same
    // install attempt. A lower value here only shortens the *provider chain*
    // budget; a first install no longer fails and asks the user to retry.
    // Applied per-provider; the chain stops as soon as one returns a code, so
    // a healthy first provider doesn't pay the budget of the slow ones.
    inline int manifestFetchTimeoutSec = 12;
    inline std::vector<std::string> manifestFetchTrustedHosts;

    // [hubcap]
    inline std::string hubcapApiKey;
    inline std::string manifesthubApiKey;
    inline bool hubcapAutoSyncEnabled = true;
    inline int hubcapSyncIntervalMinutes = 30;

    inline std::atomic_bool statsEnableApi{true};
    inline bool processExtensionEnabled = false;
    inline std::string processExtensionX86;
    inline std::string processExtensionX64;
    // Optional conditional rules. Legacy x86/x64 remain the fallback pair.
    // Rules without an app-id or exact process allow-list never match.
    inline std::vector<InjectionPolicy::Rule> processExtensionRules;

    // [onlinefix]
    // Master switch for the CreateProcessW/AsUserW injection hooks that load
    // 0xoPayload.dll into -onlinefix game processes. Set to false when
    // only Lua-level decoy / ticket forging is needed (no multiplayer bridge).
    inline bool onlineFixInjectEnabled = true;

    // [steamstub]
    // When true, SteamStubAuto automatically activates the Spacewar route
    // for Lua-tracked games that have SteamStub protection and aren't
    // owned. Set to false to disable automatic bypass (manual stub flag
    // override in the Lua pattern still works).
    inline bool steamstubAutoEnabled = false;

    // [steamstub] auto_steamless
    // When true, 0xoCore.dll strips SteamStub from a game executable *on
    // disk* as soon as the game finishes downloading (the appmanifest
    // leaves the downloading state). This is the native, dependency-free
    // equivalent of the launcher's Steamless button: no .NET, no external
    // tool, no user click. The original file is preserved as
    // "<name>.bak" so Restore() can undo it. Default off — on-disk
    // rewriting is the more invasive of the two SteamStub strategies.
    inline bool steamlessAutoEnabled = false;

    // [steamstub] auto_steamless_interval_sec
    // How often the download-watcher polls appmanifest_*.acf for a
    // downloading -> installed transition. Clamped to [5, 600].
    inline int steamlessWatchIntervalSec = 15;

    // Resolve <launcher>/resources/gse-uc/embedded/steamless (the Steamless.CLI.exe
    // directory shipped with the launcher) and hand it to SteamlessApply.
    // Search order: explicit [steamless] component_dir setting, then the
    // directory next to 0xoCore.dll (the launcher mirrors embedded components
    // there at setup time), then a few launcher-install candidates. Safe to
    // call once at bootstrap; logs which candidate won.
    void ResolveSteamlessComponentDir();

    // [steamless] component_dir
    // Absolute path override for the Steamless.CLI.exe directory.
    inline std::string steamlessComponentDir;

    // [boot]
    // When true, BootDiag::ReportMissing shows a MessageBoxA popup with
    // Steam build ID and steamclient SHA256 when IPC specs cannot be
    // loaded (pattern repo doesn't yet support this build). Default false
    // so users are not surprised by a popup on first launch. When a Steam
    // update breaks dispatch, users can flip this to true and share the
    // popup content in bug reports.
    inline bool diagnosticPopupEnabled = false;


}
