// _0xoLemonCore - Steam client hook layer for SteaMidra.
// Auto-Retry Manager for multi-depot and background-fetched games.

#include "AutoRetry.h"
#include "HubcapManifestSync.h"
#include "Logger.h"
#include "core/entry.h"

#include <windows.h>
#include <shellapi.h>

#include <atomic>
#include <chrono>
#include <condition_variable>
#include <filesystem>
#include <mutex>
#include <set>
#include <string>
#include <thread>
#include <unordered_map>
#include <vector>

#pragma comment(lib, "shell32.lib")

namespace fs = std::filesystem;

namespace AutoRetry {

namespace {

    struct TrackedApp {
        AppId_t appId = 0;
        std::set<std::pair<uint32_t, uint64_t>> missingManifests;
        std::set<std::pair<uint32_t, uint64_t>> allRequestedManifests;
        std::chrono::steady_clock::time_point   lastStateChange;
        std::chrono::steady_clock::time_point   lastRetryAttempt;
        bool retryArmed = false;
        // False until the first retry for this app fires. The cooldown below
        // exists to stop a retry storm, but applying it to the very first
        // retry is what turned a big multi-part install into "failed, press
        // install again": the manifests were on disk ~2s in and the retry was
        // still held back for another 25s.
        bool hasRetriedOnce = false;
    };

    std::mutex                                g_mutex;
    std::condition_variable                   g_cv;
    std::unordered_map<AppId_t, TrackedApp>   g_tracked;
    std::atomic<bool>                         g_running{false};
    std::thread                               g_worker;

    std::string WideToNarrow(std::wstring_view wstr) {
        if (wstr.empty()) return {};
        int size = WideCharToMultiByte(CP_UTF8, 0, wstr.data(), static_cast<int>(wstr.size()), nullptr, 0, nullptr, nullptr);
        if (size <= 0) return {};
        std::string out(size, '\0');
        WideCharToMultiByte(CP_UTF8, 0, wstr.data(), static_cast<int>(wstr.size()), out.data(), size, nullptr, nullptr);
        return out;
    }

    void WorkerLoop() {
        LOG_INFO("AutoRetry: Background worker started");
        while (g_running) {
            std::unique_lock<std::mutex> lock(g_mutex);
            g_cv.wait_for(lock, std::chrono::milliseconds(250), [] {
                return !g_running;
            });

            if (!g_running) break;

            const auto now = std::chrono::steady_clock::now();
            std::vector<AppId_t> appsToRetry;

            for (auto it = g_tracked.begin(); it != g_tracked.end(); ) {
                auto& [appId, tracked] = *it;

                // Prune inactive apps older than 60s
                auto idleSec = std::chrono::duration_cast<std::chrono::seconds>(now - tracked.lastStateChange).count();
                if (idleSec > 60 && tracked.missingManifests.empty() && !tracked.retryArmed) {
                    it = g_tracked.erase(it);
                    continue;
                }

                if (tracked.retryArmed) {
                    auto elapsedMs = std::chrono::duration_cast<std::chrono::milliseconds>(now - tracked.lastStateChange).count();
                    // Short settle delay: give the last manifest write a moment to
                    // hit the disk before nudging Steam, but no more.
                    if (elapsedMs >= 250) {
                        tracked.retryArmed = false;

                        // Cooldown guard: 25 seconds between retries for the same
                        // app. Skipped for the first retry so the initial install
                        // proceeds as soon as the manifests are actually ready.
                        auto sinceLastRetry = std::chrono::duration_cast<std::chrono::seconds>(now - tracked.lastRetryAttempt).count();
                        if (tracked.hasRetriedOnce && sinceLastRetry < 25) {
                            LOG_WARN("AutoRetry: appId={} retried {}s ago, within cooldown; skipping",
                                     appId, sinceLastRetry);
                            tracked.missingManifests.clear();
                            tracked.allRequestedManifests.clear();
                            ++it;
                            continue;
                        }

                        // Verify that all requested manifests are genuinely on disk
                        bool allOnDisk = true;
                        for (const auto& [dId, g] : tracked.allRequestedManifests) {
                            if (!HubcapManifestSync::IsManifestOnDisk(dId, g)) {
                                allOnDisk = false;
                                LOG_WARN("AutoRetry: manifest depot={} gid={} not yet on disk for appId={}",
                                         dId, g, appId);
                                break;
                            }
                        }

                        if (allOnDisk && !tracked.allRequestedManifests.empty()) {
                            tracked.lastRetryAttempt = now;
                            tracked.hasRetriedOnce = true;
                            tracked.missingManifests.clear();
                            tracked.allRequestedManifests.clear();
                            appsToRetry.push_back(appId);
                        }
                    }
                }

                ++it;
            }

            lock.unlock();

            // Fire retries outside the lock
            for (AppId_t targetId : appsToRetry) {
                LOG_INFO("AutoRetry: Firing automatic install/resume for parent appId={}", targetId);
                TriggerInstallRetry(targetId);
            }
        }
        LOG_INFO("AutoRetry: Background worker stopped");
    }

} // namespace

void Start() {
    if (g_running.exchange(true)) return;
    g_worker = std::thread(WorkerLoop);
}

void Stop() {
    if (!g_running.exchange(false)) return;
    g_cv.notify_all();
    if (g_worker.joinable()) {
        g_worker.join();
    }
}

void TrackManifestRequest(AppId_t parentAppId, uint32_t depotId, uint64_t gid) {
    if (parentAppId == 0 || depotId == 0 || gid == 0) return;

    // If manifest is already present on disk in Steam depotcache, no tracking needed
    if (HubcapManifestSync::IsManifestOnDisk(depotId, gid)) {
        return;
    }

    std::lock_guard<std::mutex> lock(g_mutex);
    auto& tracked = g_tracked[parentAppId];
    tracked.appId = parentAppId;
    tracked.missingManifests.insert({depotId, gid});
    tracked.allRequestedManifests.insert({depotId, gid});
    tracked.lastStateChange = std::chrono::steady_clock::now();
    tracked.retryArmed = false; // Disarm until all are ready

    LOG_INFO("AutoRetry: Tracked missing manifest depot={} gid={} for parent appId={} (total pending: {})",
             depotId, gid, parentAppId, tracked.missingManifests.size());
}

void OnManifestReady(uint32_t depotId, uint64_t gid) {
    if (depotId == 0 || gid == 0) return;

    std::lock_guard<std::mutex> lock(g_mutex);
    auto key = std::make_pair(depotId, gid);

    for (auto& [appId, tracked] : g_tracked) {
        if (tracked.missingManifests.erase(key) > 0) {
            tracked.lastStateChange = std::chrono::steady_clock::now();
            LOG_INFO("AutoRetry: Manifest depot={} gid={} ready for appId={} (remaining missing: {})",
                     depotId, gid, appId, tracked.missingManifests.size());

            if (tracked.missingManifests.empty() && !tracked.allRequestedManifests.empty()) {
                tracked.retryArmed = true;
                LOG_INFO("AutoRetry: All requested manifests for appId={} are now on disk! Armed auto-retry.", appId);
                g_cv.notify_one();
            }
        }
    }
}

void OnManifestFailed(uint32_t depotId, uint64_t gid) {
    if (depotId == 0 || gid == 0) return;

    std::lock_guard<std::mutex> lock(g_mutex);
    auto key = std::make_pair(depotId, gid);

    for (auto& [appId, tracked] : g_tracked) {
        if (tracked.missingManifests.count(key)) {
            LOG_WARN("AutoRetry: Manifest depot={} gid={} failed to download for appId={}, aborting auto-retry",
                     depotId, gid, appId);
            tracked.retryArmed = false;
            tracked.missingManifests.clear();
            tracked.allRequestedManifests.clear();
            // Give the next install attempt a clean first-retry (no cooldown),
            // same as a freshly tracked app.
            tracked.hasRetriedOnce = false;
        }
    }
}

bool TriggerInstallRetry(AppId_t appId) {
    if (appId == 0) return false;

    fs::path steamExe;
    if (SteamInstallPath[0] != '\0') {
        steamExe = fs::path(SteamInstallPath) / "steam.exe";
    }

    HINSTANCE res = nullptr;
    if (!steamExe.empty() && fs::exists(steamExe)) {
        std::wstring args = L"-- steam://install/" + std::to_wstring(appId);
        LOG_INFO("AutoRetry: Invoking steam.exe {}", WideToNarrow(args));
        res = ShellExecuteW(nullptr, L"open", steamExe.wstring().c_str(), args.c_str(), nullptr, SW_SHOWNORMAL);
    } else {
        std::wstring url = L"steam://install/" + std::to_wstring(appId);
        LOG_INFO("AutoRetry: Invoking ShellExecuteW {}", WideToNarrow(url));
        res = ShellExecuteW(nullptr, L"open", url.c_str(), nullptr, nullptr, SW_SHOWNORMAL);
    }

    auto code = reinterpret_cast<INT_PTR>(res);
    if (code > 32) {
        LOG_INFO("AutoRetry: ShellExecuteW succeeded for appId={} (code={})", appId, code);
        return true;
    } else {
        LOG_ERROR("AutoRetry: ShellExecuteW failed for appId={} (code={})", appId, code);
        return false;
    }
}

} // namespace AutoRetry
