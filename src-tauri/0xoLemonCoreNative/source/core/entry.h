// _0xoLemonCore — Steam client hook layer for SteaMidra.
// Copyright (c) 2025-2026 Midrag (https://github.com/Midrags).
// Distributed under the GNU General Public License v3 or later.
// See <https://www.gnu.org/licenses/> for the full license text.

#ifndef ENTRY_H
#define ENTRY_H

#include <windows.h>
#include <string>
#include <fstream>
#include <filesystem>
#include <array>
#include <vector>
#include <unordered_set>
#include <unordered_map>
#include <memory>
#include <atomic>
#include <format>
#include <charconv>
#include <cstdint>
#include <string_view>
#include <system_error>

#include "Steam/Types.h"
#include "Steam/Enums.h"
#include "Steam/Structs.h"
#include "Steam/Callback.h"
#include "config/LuaLoader.h"
#include "runtime/Logger.h"
#include "config/Settings.h"


// Handle to lcoverlay.dll once LoadDiversion() copies and loads it.
// All hook targets in steamclient64.dll are resolved through this module.
// Null until LoadDiversion() succeeds.
inline HMODULE diversion_hModule = nullptr;

// InitThread handle retained so DLL_PROCESS_DETACH can wait for init to finish
// before unhooking. Closed after the wait completes.
inline HANDLE g_InitThread = nullptr;

// Set to true by InitThread after every hook has been installed.
// SteamUI.cpp's LoadModuleWithPath hook polls this before returning diversion_hModule
// to the caller, so all hooks are in place before Steam starts using the module.
inline std::atomic<bool> g_HooksInstalled{false};

// Runtime paths filled in by LoadDiversion() from the process working directory.
inline char SteamInstallPath[MAX_PATH] = {};  // Steam root: the folder containing steam.exe
inline char SteamclientPath[MAX_PATH] = {};  // <SteamInstallPath>\steamclient64.dll
inline char DiversionPath[MAX_PATH]   = {};  // <SteamInstallPath>\bin\lcoverlay.dll (hooked copy)
inline char LuaDir[MAX_PATH]          = {};  // <SteamInstallPath>\config\stplug-in
inline char ConfigPath[MAX_PATH]      = {};  // <SteamInstallPath>\_0xolemoncore.toml
inline char PayloadPath[MAX_PATH]    = {};  // <SteamInstallPath>\0xoPayload.dll

// Steam build number read at startup from steam.exe!GetBootstrapperVersion.
// ByteSearch uses this string to select the best-matching Signature entry in PatternDb.h
// before falling back to trying every other entry in order.
// Stays empty if steam.exe is not loaded or does not export GetBootstrapperVersion.
inline std::string g_steamBuildId;

// The fake AppId substituted when -onlinefix is active (Valve's SpaceWar lobby app).
constexpr AppId_t kOnlineFixAppId = 480;

// Dispatches the PatternFetcher worker for steamui.dll on a detached thread.
// Defined in entry.cpp. Idempotent: subsequent calls after the first are no-ops.
// Called from InitThread when steamui.dll is already mapped, and from the
void DispatchSteamUiPatternFetch();

// ── Manifest probe helpers (shared by ManifestBind / ManifestFetch / HubcapManifestSync) ──
// These are deliberately defined in the header so every translation unit sees the
// identical rule. They used to be duplicated per file, and the duplicates drifted:
// one copy accepted any file whose first two bytes were "PK" (which matched tiny
// corrupted 2-byte stubs) and another still used the retired "> 2048 bytes" size
// heuristic, so a perfectly valid 179-byte manifest was treated as missing and
// re-downloaded on every single Steam retry.

// Steam binary depot manifest magic: 0x71F617D0, little endian on disk as D0 17 F6 71.
// We require the full 4-byte header plus a 64-byte floor because every authentic
// manifest observed in the wild (smallest 126 bytes) carries that magic.
inline bool IsValidManifestBuffer(const void* data, size_t size) {
    if (!data || size < 64) return false;
    const auto* bytes = static_cast<const unsigned char*>(data);
    return bytes[0] == 0xD0 && bytes[1] == 0x17 && bytes[2] == 0xF6 && bytes[3] == 0x71;
}

// True when the file exists, is at least 64 bytes and starts with the depot manifest magic.
inline bool IsValidManifestOnDisk(const std::filesystem::path& path) {
    std::error_code ec;
    auto sz = std::filesystem::file_size(path, ec);
    if (ec || sz < 64) return false;
    std::ifstream f(path, std::ios::binary);
    if (!f) return false;
    unsigned char magic[4] = {};
    f.read(reinterpret_cast<char*>(magic), 4);
    if (f.gcount() < 4) return false;
    return magic[0] == 0xD0 && magic[1] == 0x17 &&
           magic[2] == 0xF6 && magic[3] == 0x71;
}

// "<depotId>_<gid>.manifest". gid==0 yields the "<depotId>_" prefix, which the
// matcher below treats as a prefix test (used to enumerate a depot's manifests).
inline std::string MakeManifestFileName(uint32_t depotId, uint64_t gid) {
    return std::to_string(depotId) + "_" +
           (gid == 0 ? std::string() : std::to_string(gid)) + ".manifest";
}

// Parses "<depotId>_<gid>.manifest". Returns false for unrelated names, for the
// reserved steam_*.manifest files and for non-numeric gid prefixes like "1741_suffix".
inline bool ParseManifestFileName(std::string_view name, uint32_t depotId, uint64_t& outGid) {
    outGid = 0;
    if (depotId == 0 || name.size() < 12) return false;
    if (name.rfind("steam_", 0) == 0) return false;
    constexpr std::string_view suffix = ".manifest";
    std::string prefix = std::to_string(depotId) + "_";
    if (name.size() <= prefix.size() + suffix.size() ||
        name.rfind(prefix, 0) != 0 ||
        name.compare(name.size() - suffix.size(), suffix.size(), suffix) != 0) {
        return false;
    }
    auto num = name.substr(prefix.size(), name.size() - prefix.size() - suffix.size());
    for (char c : num) {
        if (c < '0' || c > '9') return false;
    }
    uint64_t parsed = 0;
    auto [end, ec] = std::from_chars(num.data(), num.data() + num.size(), parsed);
    if (ec != std::errc{} || end != num.data() + num.size() || parsed == 0) return false;
    outGid = parsed;
    return true;
}

inline bool LooksLikeManifestFileName(std::string_view name) {
    return name.size() > 9 && name.compare(name.size() - 9, 9, ".manifest") == 0;
}

// Returns the single official Launcher Vault directory path in %APPDATA%
inline std::vector<std::filesystem::path> GetLauncherVaultDirs() {
    namespace fs = std::filesystem;
    std::vector<fs::path> dirs;
    const wchar_t* appdata = _wgetenv(L"APPDATA");
    if (appdata && appdata[0] != L'\0') {
        fs::path roaming(appdata);
        dirs.push_back(roaming / L"com.0xolemon.launcher" / L"depotcache");
    }
    return dirs;
}

#endif // ENTRY_H
