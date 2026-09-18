// _0xoLemonCore - Steam client hook layer for SteaMidra.
// Copyright (c) 2025-2026 Midrag (https://github.com/Midrags).
// Distributed under the GNU General Public License v3 or later.
// See <https://www.gnu.org/licenses/> for the full license text.

#include "runtime/SteamlessWatch.h"
#include "runtime/SteamlessApply.h"
#include "sffcore/CoreAcf.h"
#include "sffcore/CoreTypes.h"
#include "config/LuaLoader.h"
#include "config/Settings.h"
#include "core/entry.h"
#include "runtime/Logger.h"

#include <atomic>
#include <cctype>
#include <chrono>
#include <filesystem>
#include <mutex>
#include <string>
#include <thread>
#include <unordered_map>
#include <vector>

namespace SteamlessWatch {
namespace {

    std::atomic<bool>     g_alive{false};
    std::thread           g_thread;

    // Per-app last-observed StateFlags so we can detect the downloading ->
    // installed edge instead of re-running the fix on every poll. Guarded by
    // g_stateLock because ScanNow() can run on a different thread than the
    // watcher loop.
    std::mutex                                   g_stateLock;
    std::unordered_map<AppId_t, std::uint32_t>   g_lastState;

    // Steam install root, cached from the global set during bootstrap.
    std::filesystem::path SteamRoot() {
        return std::filesystem::path(SteamInstallPath);
    }

    // Bits that mean "a download / install is still in flight". While any of
    // these is set the app has NOT finished downloading and must be skipped.
    // Mirrors the Rust side's IsAppInstallingOrUpdating set.
    bool IsDownloading(std::uint32_t flags) {
        using S = SffCore::AppState;
        return SffCore::HasState(flags, S::UpdateRequired)
            || SffCore::HasState(flags, S::UpdateRunning)
            || SffCore::HasState(flags, S::UpdateStarted)
            || SffCore::HasState(flags, S::UpdatePaused)
            || SffCore::HasState(flags, S::Downloading)
            || SffCore::HasState(flags, S::Staging)
            || SffCore::HasState(flags, S::Committing)
            || SffCore::HasState(flags, S::Preallocating)
            || SffCore::HasState(flags, S::AddingFiles)
            || SffCore::HasState(flags, S::Validating);
    }

    // Fully installed AND no download bit left set.
    bool IsFullyInstalled(std::uint32_t flags) {
        return SffCore::HasState(flags, SffCore::AppState::FullyInstalled)
            && !IsDownloading(flags);
    }

    // Locate the game's main executable. installDir comes straight from the
    // acf; the exe is the file whose stem matches the folder name (case
    // insensitive, spaces ignored), which is what SteamStub-protected titles
    // overwhelmingly use. Falls back to the single .exe in the folder root.
    std::filesystem::path FindMainExe(const std::filesystem::path& gameDir,
                                      const std::string& installDir) {
        namespace fs = std::filesystem;
        std::error_code ec;
        if (!fs::is_directory(gameDir, ec)) return {};

        auto normalize = [](std::string s) {
            std::string out;
            for (char c : s) {
                if (c == ' ') continue;
                out.push_back(static_cast<char>(
                    std::tolower(static_cast<unsigned char>(c))));
            }
            return out;
        };
        const std::string want = normalize(installDir);

        std::vector<fs::path> exes;
        for (fs::directory_iterator it(gameDir, fs::directory_options::skip_permission_denied, ec);
             !ec && it != fs::directory_iterator(); it.increment(ec)) {
            if (!it->is_regular_file(ec)) continue;
            const auto& p = it->path();
            if (p.extension() != ".exe") continue;
            // Skip the Steamless backup so we never try to fix it.
            if (p.extension() == ".bak") continue;
            exes.push_back(p);
        }

        for (const auto& p : exes) {
            if (normalize(p.stem().string()) == want) return p;
        }
        return exes.size() == 1 ? exes.front() : fs::path{};
    }

    // Directory of an installed app, from the appmanifest. Empty when the app
    // is not installed or its manifest is missing.
    std::filesystem::path ResolveGameDir(AppId_t appId) {
        auto parsed = SffCore::Acf::FindAndParse(SteamRoot(), appId);
        if (!parsed) return {};
        return parsed->libraryRoot / "steamapps" / "common" / parsed->info.installDir;
    }

    // Resolve the game's main executable for an app, or an empty path when the
    // app is not installed / has no single obvious exe.
    std::filesystem::path ResolveGameExe(AppId_t appId) {
        auto parsed = SffCore::Acf::FindAndParse(SteamRoot(), appId);
        if (!parsed) return {};
        std::filesystem::path gameDir =
            parsed->libraryRoot / "steamapps" / "common" / parsed->info.installDir;
        return FindMainExe(gameDir, parsed->info.installDir);
    }

    // Resolve every protected executable in the install directory. A title may
    // ship more than one real game executable (for example separate DX11/DX12
    // launch targets), so selecting the first match would leave the others
    // untouched and make the result depend on directory enumeration order.
    std::vector<std::filesystem::path> ResolveProtectedExes(AppId_t appId) {
        const std::filesystem::path gameDir = ResolveGameDir(appId);
        if (gameDir.empty()) return {};

        namespace fs = std::filesystem;
        std::vector<fs::path> protectedExes;
        std::error_code ec;
        for (fs::recursive_directory_iterator it(
                 gameDir, fs::directory_options::skip_permission_denied, ec), end;
             !ec && it != end; it.increment(ec)) {
            if (it.depth() > 4) {
                it.disable_recursion_pending();
                continue;
            }
            if (!it->is_regular_file(ec)) continue;
            const fs::path& path = it->path();
            if (path.extension() != ".exe") continue;
            if (SteamlessApply::DetectProtected(path)) protectedExes.push_back(path);
        }
        return protectedExes;
    }

    // Try to fix every protected executable in one app. Returns true when at
    // least one executable was successfully fixed.
    bool MaybeFixApp(AppId_t appId) {
        auto parsed = SffCore::Acf::FindAndParse(SteamRoot(), appId);
        if (!parsed) return false;

        const std::uint32_t flags = parsed->info.stateFlags;
        if (!IsFullyInstalled(flags)) return false;

        // Only fix apps the Lua layer tracks and that Steam does not own —
        // identical to the SteamStubAuto ownership gate.
        if (!LuaLoader::HasDepot(appId) || LuaLoader::IsOwned(appId)) return false;

        std::vector<std::filesystem::path> exes = ResolveProtectedExes(appId);
        if (exes.empty()) {
            LOG_MISC_DEBUG("SteamlessWatch: appid={} no SteamStub-protected exe found", appId);
            return false;
        }

        bool fixedAny = false;
        for (const auto& exe : exes) {
            if (SteamlessApply::IsPatched(exe)) {
                LOG_MISC_DEBUG("SteamlessWatch: appid={} already patched, skip \"{}\"",
                               appId, exe.string());
                continue;
            }
            LOG_MISC_INFO("SteamlessWatch: appid={} download finished, applying Steamless to \"{}\"",
                          appId, exe.string());
            SteamlessApply::Result result = SteamlessApply::Unpack(exe);
            if (result.success) {
                fixedAny = true;
                LOG_MISC_INFO("SteamlessWatch: appid={} Steamless ok variant={} exe=\"{}\"",
                              appId, result.variant, exe.string());
            } else {
                LOG_MISC_WARN("SteamlessWatch: appid={} Steamless failed exe=\"{}\": {}",
                              appId, exe.string(), result.message);
            }
        }
        return fixedAny;
    }

    // One sweep across every Lua-tracked app. Public ScanNow() and the poll
    // loop both funnel through here.
    void Sweep() {
        if (!Settings::steamlessAutoEnabled) return;

        std::vector<AppId_t> apps = LuaLoader::GetLibraryAppIds();
        for (AppId_t appId : apps) {
            if (!appId) continue;

            auto parsed = SffCore::Acf::FindAndParse(SteamRoot(), appId);
            if (!parsed) continue;
            const std::uint32_t flags = parsed->info.stateFlags;

            {
                std::scoped_lock lock(g_stateLock);
                g_lastState[appId] = flags;
            }

            // Re-check every fully-installed app. MaybeFixApp is idempotent:
            // it only rewrites an executable that currently carries .bind.
            // The old edge-only gate missed a user-restored original because
            // g_lastState still contained the already-installed state.
            const bool finishedNow = IsFullyInstalled(flags);
            if (finishedNow) {
                MaybeFixApp(appId);
            }
        }
    }

    void MonitorThread() {
        const int intervalSec = Settings::steamlessWatchIntervalSec > 0
            ? Settings::steamlessWatchIntervalSec : 15;
        LOG_PKGCH_INFO("SteamlessWatch: started (interval={}s auto_steamless={})",
                       intervalSec, Settings::steamlessAutoEnabled ? "on" : "off");

        // Initial settle delay so a burst of apps loading at boot doesn't
        // race the pattern-fetch / compatibility work on the main path.
        for (int i = 0; i < 20 && g_alive; ++i)
            std::this_thread::sleep_for(std::chrono::milliseconds(250));

        while (g_alive) {
            // Re-read the flag each pass so a config reload takes effect.
            if (Settings::steamlessAutoEnabled) {
                Sweep();
            }
            for (int i = 0; i < intervalSec * 4 && g_alive; ++i)
                std::this_thread::sleep_for(std::chrono::milliseconds(250));
        }
        LOG_PKGCH_INFO("SteamlessWatch: stopped");
    }

} // namespace

void Start() {
    if (!Settings::steamlessAutoEnabled) {
        LOG_PKGCH_INFO("SteamlessWatch: auto_steamless disabled, watcher not started");
        return;
    }
    if (g_alive.exchange(true)) {
        LOG_PKGCH_WARN("SteamlessWatch: already running");
        return;
    }
    g_thread = std::thread(MonitorThread);
}

void Stop() {
    if (!g_alive) return;
    g_alive = false;
    if (g_thread.joinable()) g_thread.join();
}

void ScanNow() {
    if (!Settings::steamlessAutoEnabled) return;
    Sweep();
}

std::string FixAppNow(AppId_t appId) {
    if (!appId) return "appid khong hop le.";

    const auto exes = ResolveProtectedExes(appId);
    if (exes.empty()) return "Game khong dung Steam DRM hoac da sach.";

    unsigned fixed = 0;
    unsigned skipped = 0;
    for (const auto& exe : exes) {
        if (SteamlessApply::IsPatched(exe)) {
            ++skipped;
            continue;
        }
        const SteamlessApply::Result result = SteamlessApply::Unpack(exe);
        LOG_MISC_INFO("SteamlessWatch: manual fix appid={} ok={} exe=\"{}\"",
                      appId, result.success ? 1 : 0, exe.string());
        if (result.success) ++fixed;
    }
    return "Da fix " + std::to_string(fixed) + " file EXE" +
           (skipped ? " (" + std::to_string(skipped) + " file da fix truoc do)." : ".");
}

// Play-button path. Steam is about to start `exePath`; make sure the stub is
// gone before returning to the spawn hook. This must be synchronous: the old
// detached worker raced Steam's process creation and could leave a restored
// original executable untouched.
LaunchFixResult OnGameLaunch(AppId_t appId, const std::string& exePath) {
    if (!Settings::steamlessAutoEnabled) return LaunchFixResult::Disabled;
    if (!appId || !LuaLoader::HasDepot(appId) || LuaLoader::IsOwned(appId))
        return LaunchFixResult::NotEligible;

    std::filesystem::path exe;
    if (!exePath.empty()) {
        std::error_code ec;
        const std::filesystem::path candidate = std::filesystem::u8path(exePath);
        if (std::filesystem::is_regular_file(candidate, ec))
            exe = candidate;
    }

    bool protectedNow = !exe.empty() && SteamlessApply::DetectProtected(exe);
    if (!protectedNow) {
        // Steam may provide a launcher/shim path. Only replace it with a file
        // that the content scan proves is SteamStub-protected.
        const auto scanned = ResolveProtectedExes(appId);
        if (!scanned.empty()) {
            exe = scanned.front();
            protectedNow = true;
        }
    }

    if (exe.empty()) {
        LOG_MISC_DEBUG("SteamlessWatch(launch): appid={} no executable resolved", appId);
        return LaunchFixResult::Failed;
    }
    if (!protectedNow) {
        LOG_MISC_DEBUG("SteamlessWatch(launch): appid={} executable already clean \"{}\"",
                       appId, exe.string());
        return LaunchFixResult::AlreadyClean;
    }

    LOG_MISC_INFO("SteamlessWatch(launch): appid={} play pressed, applying Steamless to \"{}\"",
                  appId, exe.string());
    SteamlessApply::Result r = SteamlessApply::Unpack(exe);
    if (r.success) {
        LOG_MISC_INFO("SteamlessWatch(launch): appid={} Steamless ok variant={} exe=\"{}\"",
                      appId, r.variant, exe.string());
        return LaunchFixResult::Applied;
    }

    LOG_MISC_WARN("SteamlessWatch(launch): appid={} Steamless failed: {}",
                  appId, r.message);
    return LaunchFixResult::Failed;
}

std::string RestoreAppNow(AppId_t appId) {
    if (!appId) return "appid khong hop le.";

    const std::filesystem::path gameDir = ResolveGameDir(appId);
    if (gameDir.empty()) return "Khong tim thay thu muc cai dat cua game.";

    namespace fs = std::filesystem;
    unsigned restored = 0;
    std::error_code ec;
    for (fs::recursive_directory_iterator it(
             gameDir, fs::directory_options::skip_permission_denied, ec), end;
         !ec && it != end; it.increment(ec)) {
        if (it.depth() > 4) {
            it.disable_recursion_pending();
            continue;
        }
        if (!it->is_regular_file(ec) || it->path().extension() != ".exe") continue;
        const fs::path backup = it->path().string() + ".bak";
        if (!fs::is_regular_file(backup, ec)) continue;
        const std::string message = SteamlessApply::Restore(it->path());
        if (message.find("Da khoi phuc") != std::string::npos) ++restored;
        LOG_MISC_INFO("SteamlessWatch: manual restore appid={} exe=\"{}\"",
                      appId, it->path().string());
    }
    return "Da khoi phuc " + std::to_string(restored) + " file EXE.";
}

} // namespace SteamlessWatch
