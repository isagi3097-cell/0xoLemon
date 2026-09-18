// _0xoLemonCore - Steam client hook layer for SteaMidra.
// Copyright (c) 2025-2026 Midrag (https://github.com/Midrags).
// Distributed under the GNU General Public License v3 or later.
// See <https://www.gnu.org/licenses/> for the full license text.

#include "hooks/client/ManifestBind.h"
#include "hooks/Macros.h"
#include "core/entry.h"
#include "runtime/HubcapManifestSync.h"
#include "runtime/ManifestStateCache.h"
#include <atomic>
#include <charconv>
#include <chrono>
#include <filesystem>
#include <format>
#include <map>
#include <mutex>
#include <optional>
#include <string>

// hook that patches depot gid/size in the output vector after Steam builds it.
// we don't hook BIsDlcEnabled / IsAppDlcInstalled / IsCloudEnabledForApp —
// CheckAppOwnership already covers those, adding em would be redundant.

namespace ManifestBind::Internal {

    constexpr uint32_t kDepotHardCap = 8192;

    // Resolving a missing GID over the network is a per-process budget, not a
    // per-depot one. Steam calls BuildDepotDependency dozens of times per session
    // and each call walks every depot of the app, so an unbounded resolve loop
    // here is what turned a single game page into hundreds of metadata requests.
    constexpr int kLiveGidResolveBudget = 8;
    static std::atomic<int> g_liveGidResolveBudget{kLiveGidResolveBudget};

    // ── live-depot reclassification ────────────────────────────────
    // A depot that is not pinned must follow whatever the provider currently
    // serves, even when the Lua file names an explicit gid for it. Without this
    // a depot whose configured gid was pinned ONCE at creation time sits on
    // that build forever: Steam reports it as installed and never asks again.
    //
    // The check is per-process and one-shot per depot. Steam's trust in the Lua
    // gid is only given up when the provider demonstrably serves a different
    // one, and that verdict is then persisted so the next launch does not
    // re-ask and does not depend on the launcher being open.
    static std::mutex g_liveReclassMutex;
    static std::unordered_set<uint32_t> g_liveReclassChecked;

    // A depot is a candidate only when the active Lua file explicitly marks it
    // for auto-update with skipManifestPin(). A literal setManifestid() without
    // that marker remains a real pin and must never be replaced.
    static bool IsDepotAutoUpdate(uint32_t depotId) {
        return LuaLoader::IsManifestAutoUpdate(depotId);
    }

    // Returns true when the depot should follow the provider's current GID
    // instead of the Lua GID. The provider is queried once per Steam process so
    // a non-pinned added game can advance without the launcher being open.
    static bool ShouldFollowProviderGid(uint64_t depotId, uint32_t appId,
                                        uint64_t targetGid, uint64_t& resolvedGid) {
        if (depotId == 0 || depotId > UINT32_MAX || appId == 0) return false;
        if (!IsDepotAutoUpdate(static_cast<uint32_t>(depotId))) return false;

        {
            std::lock_guard<std::mutex> lk(g_liveReclassMutex);
            if (!g_liveReclassChecked.insert(static_cast<uint32_t>(depotId)).second) return false;
        }

        if (!HubcapManifestSync::FetchPublicGidFromMetadata(appId, static_cast<uint32_t>(depotId), resolvedGid)) {
            // An unresolved provider is not proof that the Lua GID is current.
            // Leave the existing value untouched and allow a later Steam process
            // to retry rather than persisting a false "latest" answer.
            return false;
        }
        if (resolvedGid == 0 || resolvedGid == targetGid) return false;

        LOG_MANBND_INFO("ManifestBind: LIVE-UPDATE depot={} app={} was {} -> provider serves {}",
                        depotId, appId, targetGid, resolvedGid);
        return true;
    }

    // A manifest already present in Steam's real depotcache is authoritative for
    // this process. Lua may describe a different build, but replacing the GID in
    // Steam's dependency list would make a manually supplied/native manifest
    // unreachable during retry.
    static std::optional<uint64_t> FindNativeManifestGid(uint64_t depotId) {
        if (depotId == 0 || SteamInstallPath[0] == '\0') return std::nullopt;

        std::error_code ec;
        const std::filesystem::path cache =
            std::filesystem::path(SteamInstallPath) / "depotcache";
        if (std::filesystem::is_directory(cache, ec) && !ec) {
            std::optional<uint64_t> selected;
            std::filesystem::file_time_type selectedTime{};
            for (const auto& entry : std::filesystem::directory_iterator(cache, ec)) {
                if (ec || !entry.is_regular_file(ec) || ec) continue;
                if (!HubcapManifestSync::IsValidManifestFile(entry.path())) continue;

                const std::string name = entry.path().filename().string();
                uint64_t gid = 0;
                if (!ParseManifestFileName(name, depotId, gid)) continue;

                const auto writeTime = entry.last_write_time(ec);
                if (ec) continue;
                if (!selected || writeTime > selectedTime) {
                    selected = gid;
                    selectedTime = writeTime;
                }
            }
            if (selected) return selected;
        }

        // If not found in Steam's depotcache, auto-heal from the Launcher Vault in %APPDATA%!
        // The retired "file_size > 2048" filter that used to live here rejected valid
        // small manifests (a 179-byte installscript-only depot) and let tiny corrupted
        // stubs through, so validation now runs through the shared magic check.
        for (const auto& vaultDir : GetLauncherVaultDirs()) {
            if (!std::filesystem::is_directory(vaultDir, ec) || ec) continue;
            for (const auto& entry : std::filesystem::directory_iterator(vaultDir, ec)) {
                if (ec || !entry.is_regular_file(ec) || ec) continue;
                if (!HubcapManifestSync::IsValidManifestFile(entry.path())) continue;

                const std::string name = entry.path().filename().string();
                uint64_t gid = 0;
                if (!ParseManifestFileName(name, depotId, gid)) continue;

                // Auto-heal into Steam's depotcache immediately!
                std::filesystem::create_directories(cache, ec);
                std::filesystem::copy_file(entry.path(), cache / name, std::filesystem::copy_options::overwrite_existing, ec);
                if (!ec) {
                    LOG_MANBND_INFO("ManifestBind: Auto-healed {} from vault into depotcache for depot={}", name, depotId);
                    return gid;
                }
            }
        }

        return std::nullopt;
    }

    // safe window over CUtlVector<DepotEntry> — Steam's internal layout
    class DepotBank {
        CUtlVector<DepotEntry>* m_store = nullptr;
        uint32_t m_items = 0;

    public:
        explicit DepotBank(CUtlVector<DepotEntry>* store) : m_store(store) {
            if (!m_store || !m_store->m_Size) return;
            m_items = m_store->m_Size;
            if (m_items > kDepotHardCap) {
                LOG_MANBND_WARN("BuildDepotDependency: clipping count {} to {}", m_items, kDepotHardCap);
                m_items = kDepotHardCap;
            }
            if (!m_store->m_Memory.m_pMemory) {
                LOG_MANBND_ERROR("BuildDepotDependency: backing memory is null");
                m_items = 0;
            }
        }

        bool HasEntries() const { return m_items > 0; }
        uint32_t Len() const { return m_items; }
        const DepotEntry& Get(uint32_t ix) const { return m_store->m_Memory.m_pMemory[ix]; }
        DepotEntry& Mut(uint32_t ix) { return m_store->m_Memory.m_pMemory[ix]; }

        // Drops entry `ix` by shifting the tail down and publishing the new
        // count to both our view and Steam's vector. Used by the unservable
        // depot strip; the caller must not advance its index afterwards.
        void Remove(uint32_t ix) {
            if (!m_store || ix >= m_items) return;
            for (uint32_t i = ix; i + 1 < m_items; ++i) {
                m_store->m_Memory.m_pMemory[i] = m_store->m_Memory.m_pMemory[i + 1];
            }
            --m_items;
            m_store->m_Size = m_items;
        }

        std::string DumpEntry(uint32_t ix) const {
            const auto& e = Get(ix);
            return std::format("[DepotId={} | AppId={} | Gid={} | Size={} | Dlc={} | Lcs={} | Carry={} | Shared={}]",
                e.DepotId, e.AppId, e.ManifestGid, e.ManifestSize, e.DlcAppId,
                (int)e.LcsRequired, (int)e.bNotNewTarget, (int)e.SharedInstall);
        }
    };

    // Checks if the exact manifest (depotId_gid.manifest) exists in depotcache or vault/backups
    static bool HasExactManifest(uint64_t depotId, uint64_t gid) {
        if (depotId == 0 || gid == 0 || depotId > UINT32_MAX) return false;

        // 1. Check Steam's depotcache (pure read, no vault copy, no network)
        if (HubcapManifestSync::IsManifestOnDisk(static_cast<uint32_t>(depotId), gid)) {
            return true;
        }

        // 2. Check Launcher Vault & backups in %APPDATA% and auto-heal
        return HubcapManifestSync::TryAutoHealFromVault(static_cast<uint32_t>(depotId), gid);
    }

    // Detects whether Steam is actively downloading or updating this specific AppId.
    // Inspects appmanifest_<appId>.acf across all library folders in libraryfolders.vdf.
    // Non-installed or idle games return false (0 network quota consumed on startup).
    static bool IsAppInstallingOrUpdating(AppId_t appId) {
        if (appId == 0 || SteamInstallPath[0] == '\0') return false;

        // Steam rebuilds the dependency list several times per second while it
        // works through a queue, and this walks libraryfolders.vdf plus an .acf
        // file each time. Reuse the answer for a few seconds instead.
        static std::mutex s_stateMutex;
        static std::map<AppId_t, std::pair<bool, std::chrono::steady_clock::time_point>> s_stateCache;
        const auto now = std::chrono::steady_clock::now();
        {
            std::lock_guard<std::mutex> lock(s_stateMutex);
            auto it = s_stateCache.find(appId);
            if (it != s_stateCache.end()) {
                auto cacheDuration = it->second.first ? std::chrono::seconds(3) : std::chrono::milliseconds(500);
                if (now - it->second.second < cacheDuration) {
                    return it->second.first;
                }
            }
        }
        const auto remember = [&](bool value) {
            std::lock_guard<std::mutex> lock(s_stateMutex);
            if (s_stateCache.size() > 512) s_stateCache.clear();
            s_stateCache[appId] = {value, std::chrono::steady_clock::now()};
            return value;
        };

        namespace fs = std::filesystem;
        std::error_code ec;

        // Collect Steam library paths from libraryfolders.vdf
        std::vector<fs::path> libPaths;
        fs::path steamDir(SteamInstallPath);
        libPaths.push_back(steamDir);

        fs::path libVdf = steamDir / "steamapps" / "libraryfolders.vdf";
        if (fs::is_regular_file(libVdf, ec) && !ec) {
            std::ifstream f(libVdf);
            std::string line;
            while (std::getline(f, line)) {
                size_t pPos = line.find("\"path\"");
                if (pPos != std::string::npos) {
                    size_t q1 = line.find('"', pPos + 6);
                    if (q1 != std::string::npos) {
                        size_t q2 = line.find('"', q1 + 1);
                        if (q2 != std::string::npos) {
                            std::string pStr = line.substr(q1 + 1, q2 - q1 - 1);
                            std::string clean;
                            for (size_t i = 0; i < pStr.size(); ++i) {
                                if (pStr[i] == '\\' && i + 1 < pStr.size() && pStr[i+1] == '\\') {
                                    clean.push_back('\\');
                                    ++i;
                                } else {
                                    clean.push_back(pStr[i]);
                                }
                            }
                            if (!clean.empty()) libPaths.push_back(fs::path(clean));
                        }
                    }
                }
            }
        }

        // Look for appmanifest_<appId>.acf in each library folder
        std::string acfName = "appmanifest_" + std::to_string(appId) + ".acf";
        for (const auto& lib : libPaths) {
            fs::path acfPath = lib / "steamapps" / acfName;
            if (fs::is_regular_file(acfPath, ec) && !ec) {
                std::ifstream f(acfPath);
                std::string line;
                while (std::getline(f, line)) {
                    size_t sPos = line.find("\"StateFlags\"");
                    if (sPos != std::string::npos) {
                        size_t q1 = line.find('"', sPos + 12);
                        if (q1 != std::string::npos) {
                            size_t q2 = line.find('"', q1 + 1);
                            if (q2 != std::string::npos) {
                                uint64_t flags = 0;
                                std::string valStr = line.substr(q1 + 1, q2 - q1 - 1);
                                std::from_chars(valStr.data(), valStr.data() + valStr.size(), flags);
                                // k_EAppStateUpdateRequired = 2, UpdateRunning = 256, UpdateStarted = 1024, UpdateQueued = 8, Reconfiguring = 4096
                                constexpr uint64_t kDownloadingFlags = 2 | 8 | 256 | 1024 | 4096;
                                if ((flags & kDownloadingFlags) != 0) {
                                    return remember(true);
                                }
                            }
                        }
                    }
                }
            }
        }
        return remember(false);
    }

    // walk the depot list and slap in any overrides from lua config or auto-heal missing manifests
    static void SlapManifestOverrides(DepotBank& bank, bool isDownloading) {
        if (!bank.HasEntries()) return;
        const auto& overrides = LuaLoader::GetManifestOverrides();
        static std::once_flag s_once;
        std::call_once(s_once, [&]() {
            LOG_MANBND_INFO("manifest-map-dump size={}", static_cast<uint32_t>(overrides.size()));
            for (const auto& [k, v] : overrides)
                LOG_MANBND_INFO("manifest-map-entry depot={} gid={}", k, v.gid);
        });

        uint32_t idx = 0;
        while (idx < bank.Len()) {
            uint32_t depotId = bank.Get(idx).DepotId;
            uint32_t appId = bank.Get(idx).AppId;
            uint64_t curGid = bank.Get(idx).ManifestGid;
            uint64_t key = static_cast<uint64_t>(depotId);

            auto it = overrides.find(key);
            if (it != overrides.end() && it->second.gid != 0) {
                uint64_t targetGid = it->second.gid;

                // ── HubcapTools: PIN-LATEST ───────────────────
                // The Lua file pins a GID for this depot, but that pin may name
                // a build Hubcap no longer serves (the depot moved on and the
                // Lua was never updated). Before trusting the pin, ask the
                // /contents endpoint whether it still lists it; if not, re-pin
                // to the GID the provider currently serves. Resolving only when
                // curGid==0 (the old behaviour) never caught a stale pin.
                //
                // Cheap by construction: /contents is the free, 0-quota
                // endpoint, and the result is only consulted when the pinned
                // manifest is not already on disk.
                if (appId != 0 && !HasExactManifest(key, targetGid)) {
                    uint64_t latestGid = 0;
                    if (HubcapManifestSync::FetchPublicGidFromMetadata(appId, depotId, latestGid) &&
                        latestGid != 0 && latestGid != targetGid) {
                        LOG_MANBND_INFO("ManifestBind: PIN-LATEST depot={} pinned {} is stale, "
                                        "provider now serves {} (cur={})",
                                        depotId, targetGid, latestGid, curGid);
                        targetGid = latestGid;
                    } else {
                        LOG_MANBND_DEBUG("ManifestBind: PIN-LATEST depot={} pin {} still current "
                                         "(or unresolved)", depotId, targetGid);
                    }
                }

                // A non-pinned depot follows the provider even though Lua named
                // a gid for it. Only when no download is running, so the swap
                // cannot fight an update Steam has already started.
                if (!isDownloading) {
                    uint64_t liveGid = 0;
                    if (ShouldFollowProviderGid(key, appId, targetGid, liveGid)) {
                        targetGid = liveGid;
                    }
                }

                // Auto-heal from local vault / E:\Compressed / backups if present (offline, 0 network quota)
                bool hasLocal = HasExactManifest(key, targetGid);

                if (hasLocal) {
                    uint64_t newSz = it->second.size ? it->second.size : bank.Get(idx).ManifestSize;
                    LOG_MANBND_INFO("manifest-override depot={} gid={}->{} size={}->{}",
                        depotId, curGid, targetGid, bank.Get(idx).ManifestSize, newSz);
                    bank.Mut(idx).ManifestGid  = targetGid;
                    bank.Mut(idx).ManifestSize = newSz;
                } else if (isDownloading) {
                    LOG_MANBND_INFO("ManifestBind: App is actively downloading. Missing manifest for overridden depot={} gid={} -> queuing manifest fetch (Method 1: pre-cache)",
                        depotId, targetGid);
                    // NON-BLOCKING. This hook runs on Steam's UI thread and
                    // EnsureManifest can sit on a 45s HTTP timeout; blocking here
                    // is what made a big multi-part install freeze before it
                    // started. The fetch is queued on the async worker and Steam,
                    // which rebuilds this dependency list repeatedly, picks the
                    // manifest up on a later pass - then downloads at full speed.
                    if (HubcapManifestSync::EnsureManifestAsync(depotId, targetGid)) {
                        uint64_t newSz = it->second.size ? it->second.size : bank.Get(idx).ManifestSize;
                        LOG_MANBND_INFO("manifest-override-downloaded depot={} gid={}->{} size={}->{}",
                            depotId, curGid, targetGid, bank.Get(idx).ManifestSize, newSz);
                        bank.Mut(idx).ManifestGid  = targetGid;
                        bank.Mut(idx).ManifestSize = newSz;
                    } else if (auto nativeGid = FindNativeManifestGid(key)) {
                        LOG_MANBND_INFO("manifest-fallback depot={} targetGid={} fallbackNativeGid={}",
                            depotId, targetGid, *nativeGid);
                        bank.Mut(idx).ManifestGid = *nativeGid;
                    } else {
                        LOG_MANBND_INFO("manifest-unhealed depot={} targetGid={}", depotId, targetGid);
                        bank.Mut(idx).ManifestGid = targetGid;
                    }
                } else {
                    uint64_t newSz = it->second.size ? it->second.size : bank.Get(idx).ManifestSize;
                    LOG_MANBND_INFO("manifest-override (idle/offline) depot={} gid={}->{} size={}->{}",
                        depotId, curGid, targetGid, bank.Get(idx).ManifestSize, newSz);
                    bank.Mut(idx).ManifestGid  = targetGid;
                    bank.Mut(idx).ManifestSize = newSz;
                }
            } else {
                // Live depot or depot without explicit override:
                // If curGid is 0 and the launcher actually knows a gid for this depot,
                // resolve it from the metadata mirror (free, 0 quota) and bind it.
                //
                // Two guards keep this off the network during an idle Steam boot:
                //   * only depots the launcher tracks are resolved, so Steam's own
                //     shared/tool depots no longer trigger a metadata request each
                //     time they appear in the dependency list;
                //   * the resolve budget is per-process, because Steam rebuilds an
                //     app's dependency list repeatedly per session.
                const auto known = overrides.find(key);
                const bool launcherKnowsDepot = known != overrides.end();
                int budgetAfter = g_liveGidResolveBudget.load();
                if (budgetAfter > 0) budgetAfter = g_liveGidResolveBudget.fetch_sub(1) - 1;
                if (curGid == 0 && appId != 0 && launcherKnowsDepot && budgetAfter >= 0) {
                    uint64_t resolvedGid = 0;
                    if (HubcapManifestSync::FetchPublicGidFromMetadata(appId, depotId, resolvedGid) && resolvedGid != 0) {
                        LOG_MANBND_INFO("ManifestBind: Resolved live public gid={} for appId={} depot={} (budget left={})",
                            resolvedGid, appId, depotId, budgetAfter);
                        curGid = resolvedGid;
                        bank.Mut(idx).ManifestGid = resolvedGid;
                    } else {
                        LOG_MANBND_DEBUG("ManifestBind: no public gid for appId={} depot={} (budget left={})",
                            appId, depotId, budgetAfter);
                    }
                } else if (curGid == 0 && launcherKnowsDepot && budgetAfter < 0) {
                    LOG_MANBND_DEBUG("ManifestBind: gid resolve budget exhausted, leaving depot={} gid=0", depotId);
                }

                // If present in vault, auto-heal into depotcache (offline, 0 network quota)
                if (curGid != 0) {
                    bool hasExact = HasExactManifest(key, curGid);
                    if (!hasExact && isDownloading) {
                        LOG_MANBND_INFO("ManifestBind: App is actively downloading. Queuing live manifest for depot={} gid={}", depotId, curGid);
                        // NON-BLOCKING, same reasoning as the override branch above:
                        // never sit on an HTTP timeout inside BuildDepotDependency.
                        HubcapManifestSync::EnsureManifestAsync(depotId, curGid);
                    }
                }

                LOG_MANBND_INFO("manifest-scan depot={} gid={} appid={} size={}",
                    depotId, bank.Get(idx).ManifestGid, appId, bank.Get(idx).ManifestSize);
            }
            ++idx;
        }
    }

    // ── HubcapTools: STRIP unservable depots ─────
    // A depot whose manifest request code the providers can never produce (a
    // region-locked or delisted build, or one Hubcap simply does not carry)
    // makes Steam retry the install forever. Once the state cache has seen the
    // depot fail kUnservableThreshold times, drop it from the dependency vector
    // so Steam stops asking for something that cannot be served.
    //
    // Runs after SlapManifestOverrides so an override that *did* land a
    // manifest wins: only genuinely hopeless depots are removed.
    static void StripUnservableDepots(DepotBank& bank) {
        if (!bank.HasEntries()) return;
        uint32_t idx = 0;
        while (idx < bank.Len()) {
            const uint32_t depotId = bank.Get(idx).DepotId;
            if (depotId == 0 || !ManifestStateCache::IsUnservable(depotId)) {
                ++idx;
                continue;
            }
            // Never strip a depot whose exact manifest is already on disk - it
            // is installable, the counter just reflects earlier failures.
            if (HasExactManifest(depotId, bank.Get(idx).ManifestGid)) {
                ManifestStateCache::ClearUnservable(depotId);
                ++idx;
                continue;
            }
            LOG_MANBND_WARN("STRIP unservable depot={} (manifest never obtainable), "
                            "removing from dependency vector so Steam stops retrying",
                            depotId);
            bank.Remove(idx);   // does not advance: the next entry slides in
        }
    }

} // namespace ManifestBind::Internal
namespace {
    using ManifestBind::Internal::DepotBank;
    using ManifestBind::Internal::SlapManifestOverrides;
    using ManifestBind::Internal::StripUnservableDepots;
    using ManifestBind::Internal::IsAppInstallingOrUpdating;

    static BOOL(WINAPI* oDeleteFileW)(LPCWSTR lpFileName) = DeleteFileW;
    static BOOL(WINAPI* oDeleteFileA)(LPCSTR lpFileName) = DeleteFileA;

    static bool ShouldProtectManifestFile(const std::wstring& path) {
        if (path.size() < 9) return false;
        constexpr std::wstring_view suffix = L".manifest";
        if (path.size() < suffix.size()) return false;
        if (_wcsicmp(path.c_str() + path.size() - suffix.size(), suffix.data()) != 0) {
            return false;
        }
        std::wstring lower = path;
        for (auto& ch : lower) ch = towlower(ch);
        if (lower.find(L"depotcache") == std::wstring::npos) {
            return false;
        }
        return HubcapManifestSync::IsValidManifestFile(std::filesystem::path(path));
    }

    static BOOL WINAPI hkDeleteFileW(LPCWSTR lpFileName) {
        if (lpFileName && ShouldProtectManifestFile(lpFileName)) {
            LOG_MANBND_INFO("Anti-Deletion: Protected valid manifest from Steam deletion: {}",
                std::filesystem::path(lpFileName).filename().string());
            SetLastError(ERROR_SUCCESS);
            return TRUE;
        }
        return oDeleteFileW(lpFileName);
    }

    static BOOL WINAPI hkDeleteFileA(LPCSTR lpFileName) {
        if (lpFileName) {
            std::filesystem::path p = std::string(lpFileName);
            if (ShouldProtectManifestFile(p.wstring())) {
                LOG_MANBND_INFO("Anti-Deletion: Protected valid manifest from Steam deletion: {}",
                    p.filename().string());
                SetLastError(ERROR_SUCCESS);
                return TRUE;
            }
        }
        return oDeleteFileA(lpFileName);
    }

    LM_HOOK(BuildDepotDependency, bool, void* pUserAppMgr, AppId_t AppId,
              void* pUserConfig, CUtlVector<DepotEntry>* pDepotInfo,
              CUtlVector<DepotEntry>* pSharedDepotInfo, void* pSteamApp,
              uint32_t* pBuildId, bool* pbBetaFallback)
    {
        bool ok = oBuildDepotDependency(pUserAppMgr, AppId, pUserConfig,
            pDepotInfo, pSharedDepotInfo, pSteamApp, pBuildId, pbBetaFallback);

        if (pDepotInfo) {
            DepotBank db(pDepotInfo);
            bool isDownloading = IsAppInstallingOrUpdating(AppId);
            if (!isDownloading && pSteamApp) {
                auto* pApp = static_cast<CSteamApp*>(pSteamApp);
                constexpr uint32_t kActiveFlags = k_EAppStateUpdateRequired | k_EAppStateUpdateQueued |
                                                  k_EAppStateUpdateRunning  | k_EAppStateUpdateStarted |
                                                  k_EAppStateDownloading    | k_EAppStatePreallocating |
                                                  k_EAppStateReconfiguring;
                if ((static_cast<uint32_t>(pApp->AppStateFlags) & kActiveFlags) != 0) {
                    isDownloading = true;
                }
            }
            LOG_MANBND_TRACE("BuildDepotDependency appid={} depots={} ok={} isDownloading={}",
                             AppId, db.Len(), ok, isDownloading);
            if (ok) {
                SlapManifestOverrides(db, isDownloading);
                StripUnservableDepots(db);
            }
        }
        return ok;
    }

} // anonymous namespace

namespace ManifestBind {

    void Install() {
        LM_TX_BEGIN();
        LM_INSTALL(BuildDepotDependency);
        DetourAttach(&(PVOID&)oDeleteFileW, hkDeleteFileW);
        DetourAttach(&(PVOID&)oDeleteFileA, hkDeleteFileA);
        LM_TX_COMMIT();
    }

    void Uninstall() {
        LM_TX_BEGIN();
        LM_REMOVE(BuildDepotDependency);
        DetourDetach(&(PVOID&)oDeleteFileW, hkDeleteFileW);
        DetourDetach(&(PVOID&)oDeleteFileA, hkDeleteFileA);
        LM_TX_COMMIT();
    }
}
