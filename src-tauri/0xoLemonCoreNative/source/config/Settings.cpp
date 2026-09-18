// _0xoLemonCore - Steam client hook layer for SteaMidra.
// Copyright (c) 2025-2026 Midrag (https://github.com/Midrags).
// Distributed under the GNU General Public License v3 or later.
// See <https://www.gnu.org/licenses/> for the full license text.

#include "Settings.h"
#include "runtime/Logger.h"
#include "runtime/SteamlessApply.h"
#include <toml++/toml.hpp>
#include <cstdint>
#include <filesystem>
#include <mutex>
#include <string_view>

namespace Settings {

    namespace {
        std::mutex g_reloadLock;
        std::string g_loadedPath;
        std::filesystem::file_time_type g_loadedStamp{};
        bool g_haveStamp = false;

        std::vector<std::string> DefaultManifestUrls()
        {
            return {
                "https://manifest.steam.run/api/manifest/{gid}",
                "https://manifest.opensteamtool.com/{gid}",
                "http://gmrc.wudrm.com/manifest/{gid}",
            };
        }

        std::vector<std::string> DefaultManifestTrustedHosts()
        {
            return {
                "manifest.steam.run",
                "manifest.opensteamtool.com",
                "gmrc.wudrm.com",
            };
        }

        void ResetConfigValues()
        {
            logLevel = LogLevel::Debug;
            verbose = true;
            luaPaths.clear();
            patternMirror.clear();
            patternGitflicEnabled = true;
            patternRequireSigned = false;
            manifestFetchUrls = DefaultManifestUrls();
            manifestFetchTrustedHosts = DefaultManifestTrustedHosts();
            manifestFetchTimeoutSec = 12;
            statsEnableApi = true;
            processExtensionEnabled = false;
            processExtensionX86.clear();
            processExtensionX64.clear();
            processExtensionRules.clear();
            onlineFixInjectEnabled = true;
            steamstubAutoEnabled = false;
            steamlessAutoEnabled = false;
            steamlessWatchIntervalSec = 15;
        }

        void RememberStamp(const std::filesystem::path& cfgPath)
        {
            std::error_code ec;
            if (std::filesystem::exists(cfgPath, ec)) {
                g_loadedStamp = std::filesystem::last_write_time(cfgPath, ec);
                g_haveStamp = !ec;
            } else {
                g_haveStamp = false;
            }
        }
    }

    // Lookup table: TOML string → LogLevel enum.
    // Returns the current logLevel unchanged if the input string isn't recognised.
    static LogLevel ParseLogLevel(std::string_view s)
    {
        static const struct { std::string_view name; LogLevel lvl; } kLevels[] = {
            { "trace", LogLevel::Trace },
            { "debug", LogLevel::Debug },
            { "info",  LogLevel::Info  },
            { "warn",  LogLevel::Warn  },
            { "error", LogLevel::Error },
        };
        for (const auto& entry : kLevels)
            if (entry.name == s) return entry.lvl;
        return logLevel;
    }

    static const char* LevelName(LogLevel lvl)
    {
        switch (lvl) {
        case LogLevel::Trace: return "trace";
        case LogLevel::Debug: return "debug";
        case LogLevel::Info:  return "info";
        case LogLevel::Warn:  return "warn";
        case LogLevel::Error: return "error";
        default:              return "unknown";
        }
    }

    static void LoadUnlocked(const std::string& configPath)
    {
        std::filesystem::path cfgPath(configPath);
        g_loadedPath = configPath;
        logDir = (cfgPath.parent_path() / "_0xolemoncore").string();
        ResetConfigValues();

        if (!std::filesystem::exists(cfgPath)) {
            RememberStamp(cfgPath);
            LOG_INFO("Settings: config not found at '{}', using defaults", configPath);
            return;
        }

        try {
            auto tbl = toml::parse_file(configPath);

            // [log]
            if (auto logTbl = tbl["log"].as_table()) {
                if (auto lvl = (*logTbl)["level"].value<std::string>())
                    logLevel = ParseLogLevel(*lvl);
                if (auto v = (*logTbl)["verbose"].value<bool>())
                    verbose = *v;
            }

            // [lua]
            if (auto luaTbl = tbl["lua"].as_table()) {
                if (auto arr = (*luaTbl)["paths"].as_array()) {
                    for (const auto& elem : *arr) {
                        if (auto s = elem.value<std::string>())
                            luaPaths.push_back(*s);
                    }
                }
            }

            // [pattern_fetch]
            if (auto patternTbl = tbl["pattern_fetch"].as_table()) {
                if (auto m = (*patternTbl)["mirror"].value<std::string>())
                    patternMirror = *m;
                if (auto g = (*patternTbl)["gitflic_enabled"].value<bool>())
                    patternGitflicEnabled = *g;
                if (auto r = (*patternTbl)["require_signed"].value<bool>())
                    patternRequireSigned = *r;
            }

            // [manifest_fetch]
            // - urls = [...] takes priority and replaces the default chain
            // - url = "..." overrides the chain with a single endpoint
            //   (back-compat with the 6.2.x single-URL config)
            // - neither = the 3-default chain in Settings.h stays
            if (auto mfetch = tbl["manifest_fetch"].as_table()) {
                if (auto arr = (*mfetch)["urls"].as_array()) {
                    std::vector<std::string> chain;
                    chain.reserve(arr->size());
                    for (const auto& elem : *arr) {
                        if (auto s = elem.value<std::string>())
                            chain.push_back(*s);
                    }
                    if (!chain.empty())
                        manifestFetchUrls = std::move(chain);
                } else if (auto u = (*mfetch)["url"].value<std::string>()) {
                    manifestFetchUrls = { *u };
                }
                if (auto t = (*mfetch)["timeout_sec"].value<int64_t>())
                    manifestFetchTimeoutSec = static_cast<int>(*t);
                if (auto hosts = (*mfetch)["trusted_hosts"].as_array()) {
                    std::vector<std::string> allow;
                    allow.reserve(hosts->size());
                    for (const auto& elem : *hosts) {
                        if (auto s = elem.value<std::string>())
                            allow.push_back(*s);
                    }
                    manifestFetchTrustedHosts = std::move(allow);
                }
                if (auto hk = (*mfetch)["hubcap_api_key"].value<std::string>())
                    hubcapApiKey = *hk;
                if (auto mk = (*mfetch)["manifesthub_api_key"].value<std::string>())
                    manifesthubApiKey = *mk;
            }

            // [hubcap]
            if (auto hubcap = tbl["hubcap"].as_table()) {
                if (auto key = (*hubcap)["api_key"].value<std::string>())
                    hubcapApiKey = *key;
                if (auto sync = (*hubcap)["auto_sync"].value<bool>())
                    hubcapAutoSyncEnabled = *sync;
                if (auto interval = (*hubcap)["sync_interval_min"].value<int64_t>())
                    hubcapSyncIntervalMinutes = static_cast<int>(*interval);
            }

            // [stats]
            if (auto stats = tbl["stats"].as_table()) {
                if (auto enableApi = (*stats)["enable_api"].value<bool>())
                    statsEnableApi = *enableApi;
            }

            // [process_extension]
            if (auto ext = tbl["process_extension"].as_table()) {
                if (auto enabled = (*ext)["enabled"].value<bool>())
                    processExtensionEnabled = *enabled;
                if (auto x86 = (*ext)["x86"].value<std::string>())
                    processExtensionX86 = *x86;
                if (auto x64 = (*ext)["x64"].value<std::string>())
                    processExtensionX64 = *x64;
                if (auto rules = (*ext)["rules"].as_array()) {
                    std::size_t declarationOrder = 0;
                    for (const auto& node : *rules) {
                        if (processExtensionRules.size() >= 64) break;
                        const auto* ruleTable = node.as_table();
                        if (!ruleTable) continue;
                        InjectionPolicy::Rule rule;
                        rule.declarationOrder = declarationOrder++;
                        if (auto value = (*ruleTable)["name"].value<std::string>()) rule.name = *value;
                        if (auto value = (*ruleTable)["x86"].value<std::string>()) rule.libraryX86 = *value;
                        if (auto value = (*ruleTable)["x64"].value<std::string>()) rule.libraryX64 = *value;
                        if (auto value = (*ruleTable)["priority"].value<int64_t>())
                            rule.priority = static_cast<int>((std::max)(int64_t{-1000}, (std::min)(int64_t{1000}, *value)));
                        auto readProcesses = [&](const char* key, std::vector<std::string>& out) {
                            if (auto values = (*ruleTable)[key].as_array()) {
                                for (const auto& item : *values) {
                                    if (out.size() >= 128) break;
                                    if (auto value = item.value<std::string>(); value && InjectionPolicy::IsSafeProcessPattern(*value))
                                        out.push_back(InjectionPolicy::NormalizeProcessName(*value));
                                }
                            }
                        };
                        readProcesses("allow_processes", rule.allowProcesses);
                        readProcesses("deny_processes", rule.denyProcesses);
                        if (auto values = (*ruleTable)["app_ids"].as_array()) {
                            for (const auto& item : *values) {
                                if (rule.appIds.size() >= 128) break;
                                if (auto value = item.value<int64_t>(); value && *value > 0 && *value <= UINT32_MAX)
                                    rule.appIds.push_back(static_cast<uint32_t>(*value));
                            }
                        }
                        if ((!rule.allowProcesses.empty() || !rule.appIds.empty()) &&
                            (!rule.libraryX86.empty() || !rule.libraryX64.empty()))
                            processExtensionRules.push_back(std::move(rule));
                    }
                }
            }

            // [onlinefix]
            if (auto of = tbl["onlinefix"].as_table()) {
                if (auto v = (*of)["inject_enabled"].value<bool>())
                    onlineFixInjectEnabled = *v;
            }

            // [boot]
            if (auto boot = tbl["boot"].as_table()) {
                if (auto v = (*boot)["diagnostic_popup"].value<bool>())
                    diagnosticPopupEnabled = *v;
            }

            // [steamstub]
            if (auto stub = tbl["steamstub"].as_table()) {
                if (auto v = (*stub)["auto_enabled"].value<bool>())
                    steamstubAutoEnabled = *v;
                if (auto v = (*stub)["auto_steamless"].value<bool>())
                    steamlessAutoEnabled = *v;
                if (auto v = (*stub)["auto_steamless_interval_sec"].value<int64_t>()) {
                    int secs = static_cast<int>(*v);
                    if (secs < 5) secs = 5;
                    if (secs > 600) secs = 600;
                    steamlessWatchIntervalSec = secs;
                }
            }

            // [steamless]
            if (auto sl = tbl["steamless"].as_table()) {
                if (auto v = (*sl)["component_dir"].value<std::string>())
                    steamlessComponentDir = *v;
            }

            std::string urlsLog;
            for (const auto& u : manifestFetchUrls) {
                if (!urlsLog.empty()) urlsLog += " | ";
                urlsLog += u;
            }
            if (urlsLog.empty()) urlsLog = "<disabled>";

            std::string trustedLog;
            for (const auto& h : manifestFetchTrustedHosts) {
                if (!trustedLog.empty()) trustedLog += ",";
                trustedLog += h;
            }
            if (trustedLog.empty()) trustedLog = "<none>";

            LOG_INFO("Settings: log.level={} log.verbose={} lua.paths_count={} "
                     "pattern_fetch.mirror={} manifest_fetch.urls=[{}] "
                     "manifest_fetch.timeout_sec={} manifest_fetch.trusted_hosts=[{}] "
                     "stats.enable_api={} process_extension.enabled={} "
                     "onlinefix.inject_enabled={} steamstub.auto_enabled={} "
                     "steamstub.auto_steamless={} steamstub.interval_sec={}",
                     LevelName(logLevel), verbose ? "true" : "false",
                     static_cast<uint32_t>(luaPaths.size()),
                     patternMirror.empty() ? "<none>" : patternMirror,
                     urlsLog,
                     manifestFetchTimeoutSec,
                     trustedLog,
                     statsEnableApi ? "true" : "false",
                     processExtensionEnabled ? "true" : "false",
                     onlineFixInjectEnabled ? "true" : "false",
                     steamstubAutoEnabled ? "true" : "false",
                     steamlessAutoEnabled ? "true" : "false",
                     steamlessWatchIntervalSec);
            RememberStamp(cfgPath);

        } catch (const toml::parse_error& e) {
            RememberStamp(cfgPath);
            LOG_WARN("Settings: TOML parse error: {}", e.what());
        } catch (...) {
            RememberStamp(cfgPath);
            LOG_WARN("Settings: load failed, using defaults");
        }
    }

    void Load(const std::string& configPath)
    {
        std::scoped_lock lock(g_reloadLock);
        LoadUnlocked(configPath);
    }

    // Locate the Steamless.CLI.exe directory that ships with the launcher under
    // resources/gse-uc/embedded/steamless and hand it to SteamlessApply. The
    // launcher mirrors embedded components next to 0xoCore.dll at setup time,
    // so that is the primary candidate; the dev-tree / explicit-setting
    // fallbacks keep a source checkout working without an install step.
    void ResolveSteamlessComponentDir()
    {
        namespace fs = std::filesystem;
        std::error_code ec;

        std::vector<fs::path> candidates;
        if (!steamlessComponentDir.empty())
            candidates.emplace_back(fs::u8path(steamlessComponentDir));

        // 1) Next to the running 0xoCore.dll (launcher mirrors it here).
        char modPath[MAX_PATH] = {};
        if (GetModuleFileNameA(nullptr, modPath, MAX_PATH)) {
            const fs::path self(modPath);
            const fs::path base = self.parent_path();
            candidates.push_back(base / "steamless");
            candidates.push_back(base / "embedded" / "steamless");
            candidates.push_back(base / "gse-uc" / "embedded" / "steamless");
        }

        // 2) Launcher dev tree, relative to this module / cwd.
        candidates.push_back(fs::current_path() /
                             "src-tauri" / "resources" / "gse-uc" /
                             "embedded" / "steamless");

        // 3) Absolute dev tree used by this workspace.
        candidates.emplace_back(
            fs::path("E:/007Launcher/src-tauri/resources/gse-uc/embedded/steamless"));

        for (const auto& dir : candidates) {
            const fs::path cli = dir / "Steamless.CLI.exe";
            if (fs::is_regular_file(cli, ec)) {
                const std::u8string u8 = dir.u8string();
                const std::string dirUtf8(reinterpret_cast<const char*>(u8.data()), u8.size());
                SteamlessApply::SetComponentDir(dirUtf8);
                LOG_INFO("Settings: steamless component_dir resolved to \"{}\"", dirUtf8);
                return;
            }
        }

        LOG_WARN("Settings: Steamless.CLI.exe not found in any known location; "
                 "auto_steamless will report a component-missing error");
    }

    ReloadResult ReloadIfChanged()
    {
        std::scoped_lock lock(g_reloadLock);
        ReloadResult result{};
        if (g_loadedPath.empty())
            return result;

        std::filesystem::path cfgPath(g_loadedPath);
        std::error_code ec;
        if (!std::filesystem::exists(cfgPath, ec)) {
            if (g_haveStamp) {
                LOG_WARN("Settings: config disappeared, reverting hot settings to defaults");
                std::vector<std::string> oldLuaPaths = luaPaths;
                LoadUnlocked(g_loadedPath);
                result.reloaded = true;
                result.luaPathsChanged = oldLuaPaths != luaPaths;
            }
            return result;
        }

        auto current = std::filesystem::last_write_time(cfgPath, ec);
        if (ec)
            return result;
        if (g_haveStamp && current == g_loadedStamp)
            return result;

        LOG_INFO("Settings: config changed, hot-reloading {}", g_loadedPath);
        std::vector<std::string> oldLuaPaths = luaPaths;
        LoadUnlocked(g_loadedPath);
        result.reloaded = true;
        result.luaPathsChanged = oldLuaPaths != luaPaths;
        return result;
    }

}

