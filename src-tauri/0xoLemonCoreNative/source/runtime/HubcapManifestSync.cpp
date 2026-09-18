// _0xoLemonCore - Steam client hook layer for SteaMidra.
// Hubcap Single Manifest Auto-Updater & Synchronizer.

#include "HubcapManifestSync.h"
#include "AutoRetry.h"
#include "ManifestStateCache.h"
#include "RuntimeHttp.h"
#include "Logger.h"
#include "core/entry.h"
#include "config/Settings.h"
#include "config/LuaLoader.h"

#include <windows.h>
#include <wincrypt.h>
#include <dpapi.h>

#include "core/entry.h"

#include <atomic>
#include <charconv>
#include <chrono>
#include <condition_variable>
#include <deque>
#include <filesystem>
#include <fstream>
#include <map>
#include <mutex>
#include <set>
#include <string>
#include <string_view>
#include <thread>
#include <vector>

namespace fs = std::filesystem;

namespace HubcapManifestSync {

namespace {

    constexpr int kSuccessCooldownSec = 30;
    constexpr int kFailureCooldownSec = 60; // reduced from 600: retry faster after transient failures

    std::mutex        g_singleflightMutex;
    std::set<std::pair<uint32_t, uint64_t>> g_inflightFetches;

    std::atomic<bool> g_workerRunning{false};
    std::thread       g_workerThread;
    std::mutex        g_workerMutex;
    std::condition_variable g_workerCv;
    bool              g_syncRequested = false;
    std::mutex        g_syncExecutionMutex;

    // ── async on-demand fetch queue ───────────────────
    // A dedicated worker so a UI-thread hook (BuildDepotDependency) never has
    // to sit on a 45s HTTP timeout. The existing background worker is unusable
    // for this: it sleeps in multi-minute waits between sync passes, so a
    // queued fetch could be delayed by the whole sync interval.
    //
    // Order matters: std::deque gives FIFO with O(1) pop_front for the bounded
    // overflow case, and the set gives O(1) dedupe against both the queue and
    // the currently-in-flight slot.
    std::deque<std::pair<uint32_t, uint64_t>> g_asyncQueue;
    std::set<std::pair<uint32_t, uint64_t>>   g_asyncQueued;   // queue + inflight
    std::mutex                                g_asyncMutex;
    std::condition_variable                   g_asyncCv;
    std::atomic<bool>                         g_asyncRunning{false};
    std::thread                               g_asyncThread;

    // Bounded so a pathological dependency list cannot grow the queue without
    // limit. 512 is far above any real app's depot count.
    constexpr size_t kAsyncQueueMax = 512;

    std::string       g_cachedHubcapKey;
    std::string       g_cachedManifestHubKey;
    std::mutex        g_keyMutex;

    // Fast string helpers
    bool PullJsonField(std::string_view json, std::string_view key, std::string& out) {
        std::string pat = "\"" + std::string(key) + "\"";
        size_t pos = json.find(pat);
        if (pos == std::string_view::npos) return false;
        size_t col = json.find(':', pos + pat.size());
        if (col == std::string_view::npos) return false;
        size_t valStart = col + 1;
        while (valStart < json.size() && (json[valStart] == ' ' || json[valStart] == '\t' || json[valStart] == '\r' || json[valStart] == '\n'))
            ++valStart;
        if (valStart >= json.size() || json[valStart] != '"') return false;
        size_t q1 = valStart;
        size_t q2 = json.find('"', q1 + 1);
        if (q2 == std::string_view::npos) return false;
        out.assign(json.data() + q1 + 1, q2 - q1 - 1);
        return !out.empty();
    }

    std::vector<uint8_t> Base64Decode(std::string_view b64) {
        if (b64.empty()) return {};
        DWORD outLen = 0;
        if (!CryptStringToBinaryA(b64.data(), static_cast<DWORD>(b64.size()),
                                 CRYPT_STRING_BASE64, nullptr, &outLen, nullptr, nullptr)) {
            return {};
        }
        std::vector<uint8_t> out(outLen);
        if (!CryptStringToBinaryA(b64.data(), static_cast<DWORD>(b64.size()),
                                 CRYPT_STRING_BASE64, out.data(), &outLen, nullptr, nullptr)) {
            return {};
        }
        out.resize(outLen);
        return out;
    }

    std::string DecryptDpapi(const std::vector<uint8_t>& ciphertext) {
        if (ciphertext.empty()) return {};
        DATA_BLOB in{};
        in.pbData = const_cast<BYTE*>(ciphertext.data());
        in.cbData = static_cast<DWORD>(ciphertext.size());
        DATA_BLOB out{};
        if (!CryptUnprotectData(&in, nullptr, nullptr, nullptr, nullptr, CRYPTPROTECT_UI_FORBIDDEN, &out)) {
            return {};
        }
        std::string result(reinterpret_cast<char*>(out.pbData), out.cbData);
        LocalFree(out.pbData);
        return result;
    }

    std::string ExtractKeyCandidate(const fs::path& filePath, const std::vector<const char*>& fieldNames) {
        std::error_code ec;
        if (!fs::is_regular_file(filePath, ec) || ec) return {};
        std::ifstream f(filePath, std::ios::binary);
        if (!f) return {};
        std::string content((std::istreambuf_iterator<char>(f)), std::istreambuf_iterator<char>());
        if (content.empty()) return {};

        for (const char* field : fieldNames) {
            std::string val;
            if (PullJsonField(content, field, val) && !val.empty()) {
                // If already plaintext (e.g. smm_... or mh_... or normal ascii key)
                if (val.rfind("smm_", 0) == 0 || val.rfind("mh_", 0) == 0) {
                    return val;
                }
                // Try Base64 decode
                auto decoded = Base64Decode(val);
                if (!decoded.empty()) {
                    // Try Windows DPAPI decrypt
                    auto decrypted = DecryptDpapi(decoded);
                    while (!decrypted.empty() && (decrypted.back() == '\r' || decrypted.back() == '\n' || decrypted.back() == ' '))
                        decrypted.pop_back();
                    if (!decrypted.empty()) {
                        return decrypted;
                    }
                    // Fallback: check if the base64 decoded bytes themselves are ascii key
                    std::string decodedStr(reinterpret_cast<char*>(decoded.data()), decoded.size());
                    if (decodedStr.rfind("smm_", 0) == 0 || decodedStr.rfind("mh_", 0) == 0) {
                        return decodedStr;
                    }
                }
            }
        }
        return {};
    }

    std::string TryReadPlaintextFile(const fs::path& filePath) {
        std::error_code ec;
        if (!fs::is_regular_file(filePath, ec) || ec) return {};
        std::ifstream f(filePath);
        if (!f) return {};
        std::string line;
        if (std::getline(f, line)) {
            while (!line.empty() && (line.back() == '\r' || line.back() == '\n' || line.back() == ' ' || line.back() == '\t'))
                line.pop_back();
            while (!line.empty() && (line.front() == ' ' || line.front() == '\t'))
                line.erase(line.begin());
            if (!line.empty()) return line;
        }
        return {};
    }

    std::string ResolveHubcapApiKeyInternal() {
        if (!Settings::hubcapApiKey.empty())
            return Settings::hubcapApiKey;

        // 1. Check environment variable
        if (const char* envVal = getenv("HUBCAP_API_KEY"); envVal && envVal[0] != '\0')
            return std::string(envVal);

        // 2. Check dedicated key file in Steam folder
        if (SteamInstallPath[0] != '\0') {
            fs::path steamDir(SteamInstallPath);
            std::vector<fs::path> steamKeyFiles = {
                steamDir / "_0xolemoncore" / "hubcap_key.txt",
                steamDir / "hubcap_key.txt",
                steamDir / "hubcap.key",
            };
            for (const auto& kf : steamKeyFiles) {
                std::string k = TryReadPlaintextFile(kf);
                if (!k.empty()) return k;
            }
        }

        // 3. Check Launcher AppData & LocalAppData paths (JSON settings)
        static const std::vector<const char*> hubcapFields = {
            "encryptedHubcapKey",
            "encrypted_hubcap_key",
            "hubcapApiKey",
            "hubcap_api_key",
            "hubcapKey",
            "hubcap_key"
        };

        const wchar_t* appdata = _wgetenv(L"APPDATA");
        const wchar_t* localappdata = _wgetenv(L"LOCALAPPDATA");

        std::vector<fs::path> settingsFiles;
        if (appdata && appdata[0] != L'\0') {
            fs::path roaming(appdata);
            settingsFiles.push_back(roaming / L"com.0xolemon.launcher" / L"lua-sources" / L"settings.json");
            settingsFiles.push_back(roaming / L"0xoLemon-Launcher" / L"lua-sources" / L"settings.json");
            settingsFiles.push_back(roaming / L"0xoLemon" / L"lua-sources" / L"settings.json");
            settingsFiles.push_back(roaming / L"com.0xolemon.launcher" / L"settings.json");
            settingsFiles.push_back(roaming / L"0xoLemon-Launcher" / L"settings.json");

            std::vector<fs::path> roamingKeyFiles = {
                roaming / L"com.0xolemon.launcher" / L"hubcap_key.txt",
                roaming / L"0xoLemon-Launcher" / L"hubcap_key.txt",
                roaming / L"0xoLemon" / L"hubcap_key.txt",
            };
            for (const auto& kf : roamingKeyFiles) {
                std::string k = TryReadPlaintextFile(kf);
                if (!k.empty()) return k;
            }
        }
        if (localappdata && localappdata[0] != L'\0') {
            fs::path local(localappdata);
            settingsFiles.push_back(local / L"com.0xolemon.launcher" / L"lua-sources" / L"settings.json");
            settingsFiles.push_back(local / L"0xoLemon-Launcher" / L"lua-sources" / L"settings.json");
            settingsFiles.push_back(local / L"0xoLemon" / L"lua-sources" / L"settings.json");
        }

        for (const auto& sf : settingsFiles) {
            std::string k = ExtractKeyCandidate(sf, hubcapFields);
            if (!k.empty()) return k;
        }

        return {};
    }

    std::string ResolveManifestHubApiKeyInternal() {
        if (!Settings::manifesthubApiKey.empty())
            return Settings::manifesthubApiKey;

        if (const char* envVal = getenv("MANIFESTHUB_API_KEY"); envVal && envVal[0] != '\0')
            return std::string(envVal);

        if (SteamInstallPath[0] != '\0') {
            fs::path steamDir(SteamInstallPath);
            std::vector<fs::path> steamKeyFiles = {
                steamDir / "_0xolemoncore" / "manifesthub_key.txt",
                steamDir / "manifesthub_key.txt",
            };
            for (const auto& kf : steamKeyFiles) {
                std::string k = TryReadPlaintextFile(kf);
                if (!k.empty()) return k;
            }
        }

        static const std::vector<const char*> mhFields = {
            "encryptedManifesthubKey",
            "encrypted_manifesthub_key",
            "manifesthubApiKey",
            "manifesthub_api_key",
            "manifesthubKey",
            "manifesthub_key"
        };

        const wchar_t* appdata = _wgetenv(L"APPDATA");
        const wchar_t* localappdata = _wgetenv(L"LOCALAPPDATA");

        std::vector<fs::path> settingsFiles;
        if (appdata && appdata[0] != L'\0') {
            fs::path roaming(appdata);
            settingsFiles.push_back(roaming / L"com.0xolemon.launcher" / L"lua-sources" / L"settings.json");
            settingsFiles.push_back(roaming / L"0xoLemon-Launcher" / L"lua-sources" / L"settings.json");
            settingsFiles.push_back(roaming / L"0xoLemon" / L"lua-sources" / L"settings.json");
        }
        if (localappdata && localappdata[0] != L'\0') {
            fs::path local(localappdata);
            settingsFiles.push_back(local / L"com.0xolemon.launcher" / L"lua-sources" / L"settings.json");
            settingsFiles.push_back(local / L"0xoLemon-Launcher" / L"lua-sources" / L"settings.json");
        }

        for (const auto& sf : settingsFiles) {
            std::string k = ExtractKeyCandidate(sf, mhFields);
            if (!k.empty()) return k;
        }

        return {};
    }

    // Sharded public manifest metadata mirrors used by the launcher's
    // Lua live-channel reconciler. Gives the public gid for every depot of
    // an app, which is what we need for "live" Lua files that only call
    // addappid(...) and never pin a manifest with setManifestid(...).
    //
    // Tried in order. `raw.githubusercontent.com` is listed first because it is
    // the freshest, but a flagged or blocked GitHub repository must not make
    // live-manifest resolution fail, so the jsDelivr and HuggingFace mirrors of
    // the same sharded tree follow it.
    constexpr const char *kSteamMetadataBases[] = {
        "https://raw.githubusercontent.com/isagi3097-cell/steam-metadata/main/data",
        "https://cdn.jsdelivr.net/gh/isagi3097-cell/steam-metadata@main/data",
        "https://huggingface.co/datasets/Immaking/Luas/resolve/main/steam-metadata/data",
    };

    struct DepotTarget
    {
        uint32_t appId = 0;
        uint32_t depotId = 0;
        uint64_t gid = 0;              // 0 = unresolved, needs metadata lookup
        std::string source;
    };

    bool ParseUint64Dec(std::string_view s, uint64_t& out) {
        if (s.empty()) return false;
        uint64_t v = 0;
        auto [ptr, ec] = std::from_chars(s.data(), s.data() + s.size(), v);
        if (ec != std::errc{} || ptr != s.data() + s.size()) return false;
        out = v;
        return true;
    }

    bool ParseUint32Dec(std::string_view s, uint32_t& out) {
        if (s.empty()) return false;
        uint32_t v = 0;
        auto [ptr, ec] = std::from_chars(s.data(), s.data() + s.size(), v);
        if (ec != std::errc{} || ptr != s.data() + s.size()) return false;
        out = v;
        return true;
    }

    // Extracts the public gid for `depotId` out of a metadata JSON blob.
    // Layout: "depots": { "<depotId>": { "manifests": { "public": { "gid": "..." } }
    // We scan the depot object first so we never accidentally read the gid
    // of a sibling depot or of the branches block.
    bool ExtractPublicGidFromMetadata(std::string_view json, uint32_t depotId, uint64_t& outGid) {
        std::string depotKey = "\"" + std::to_string(depotId) + "\"";
        size_t depotsPos = json.find("\"depots\"");
        if (depotsPos == std::string_view::npos) return false;

        size_t depotPos = json.find(depotKey, depotsPos);
        if (depotPos == std::string_view::npos) return false;

        size_t publicPos = json.find("\"public\"", depotPos);
        if (publicPos == std::string_view::npos) return false;

        size_t gidPos = json.find("\"gid\"", publicPos);
        if (gidPos == std::string_view::npos) return false;

        size_t colon = json.find(':', gidPos);
        if (colon == std::string_view::npos) return false;
        size_t q1 = json.find('"', colon + 1);
        if (q1 == std::string_view::npos) return false;
        size_t q2 = json.find('"', q1 + 1);
        if (q2 == std::string_view::npos) return false;

        return ParseUint64Dec(json.substr(q1 + 1, q2 - q1 - 1), outGid) && outGid != 0;
    }

    // Extracts the public gid for `depotId` out of Hubcap /api/v1/manifest/{appId}/contents JSON response.
    // Layout in manifests array:
    // { "depot_id": "228981", "manifest_id": "7613356809904826842", "filename": "..." }
    // Handles both string and integer representations of depot_id and manifest_id.
    bool ExtractGidFromHubcapContents(std::string_view json, uint32_t depotId, uint64_t& outGid) {
        std::string depotStr = std::to_string(depotId);
        size_t manifestsPos = json.find("\"manifests\"");
        if (manifestsPos == std::string_view::npos) return false;

        size_t pos = manifestsPos;
        while (pos < json.size()) {
            size_t dKey = json.find("\"depot_id\"", pos);
            if (dKey == std::string_view::npos) break;

            size_t objStart = json.rfind('{', dKey);
            size_t objEnd = json.find('}', dKey);
            if (objStart == std::string_view::npos || objEnd == std::string_view::npos) {
                pos = dKey + 10;
                continue;
            }

            std::string_view chunk = json.substr(objStart, objEnd - objStart + 1);
            size_t colon = chunk.find(':', chunk.find("\"depot_id\""));
            if (colon != std::string_view::npos) {
                std::string_view val = chunk.substr(colon + 1);
                while (!val.empty() && (val.front() == ' ' || val.front() == '\t' || val.front() == '\"'))
                    val.remove_prefix(1);
                size_t valEnd = 0;
                while (valEnd < val.size() && val[valEnd] >= '0' && val[valEnd] <= '9')
                    ++valEnd;
                std::string_view parsedDepot = val.substr(0, valEnd);
                if (parsedDepot == depotStr) {
                    size_t mKey = chunk.find("\"manifest_id\"");
                    if (mKey != std::string_view::npos) {
                        size_t mColon = chunk.find(':', mKey);
                        if (mColon != std::string_view::npos) {
                            std::string_view mVal = chunk.substr(mColon + 1);
                            while (!mVal.empty() && (mVal.front() == ' ' || mVal.front() == '\t' || mVal.front() == '\"'))
                                mVal.remove_prefix(1);
                            size_t mValEnd = 0;
                            while (mValEnd < mVal.size() && mVal[mValEnd] >= '0' && mVal[mValEnd] <= '9')
                                ++mValEnd;
                            if (mValEnd > 0 && ParseUint64Dec(mVal.substr(0, mValEnd), outGid) && outGid != 0) {
                                return true;
                            }
                        }
                    }
                }
            }
            pos = objEnd + 1;
        }
        return false;
    }

    // Layout in manifest.steam.run /api/depot/{appid} response:
    // { "appid": 945360, "depots": [ { "depotid": 945361, "manifestid": "1397756378225229500", ... } ] }
    bool ExtractGidFromSteamRun(std::string_view json, uint32_t depotId, uint64_t& outGid) {
        std::string depotStr = std::to_string(depotId);
        size_t depotsPos = json.find("\"depots\"");
        if (depotsPos == std::string_view::npos) return false;

        size_t pos = depotsPos;
        while (pos < json.size()) {
            size_t dKey = json.find("\"depotid\"", pos);
            if (dKey == std::string_view::npos) break;

            size_t objStart = json.rfind('{', dKey);
            size_t objEnd = json.find('}', dKey);
            if (objStart == std::string_view::npos || objEnd == std::string_view::npos) {
                pos = dKey + 9;
                continue;
            }

            std::string_view chunk = json.substr(objStart, objEnd - objStart + 1);
            size_t colon = chunk.find(':', chunk.find("\"depotid\""));
            if (colon != std::string_view::npos) {
                std::string_view val = chunk.substr(colon + 1);
                while (!val.empty() && (val.front() == ' ' || val.front() == '\t' || val.front() == '\"'))
                    val.remove_prefix(1);
                size_t valEnd = 0;
                while (valEnd < val.size() && val[valEnd] >= '0' && val[valEnd] <= '9')
                    ++valEnd;
                std::string_view parsedDepot = val.substr(0, valEnd);
                if (parsedDepot == depotStr) {
                    size_t mKey = chunk.find("\"manifestid\"");
                    if (mKey != std::string_view::npos) {
                        size_t mColon = chunk.find(':', mKey);
                        if (mColon != std::string_view::npos) {
                            std::string_view mVal = chunk.substr(mColon + 1);
                            while (!mVal.empty() && (mVal.front() == ' ' || mVal.front() == '\t' || mVal.front() == '\"'))
                                mVal.remove_prefix(1);
                            size_t mValEnd = 0;
                            while (mValEnd < mVal.size() && mVal[mValEnd] >= '0' && mVal[mValEnd] <= '9')
                                ++mValEnd;
                            if (mValEnd > 0 && ParseUint64Dec(mVal.substr(0, mValEnd), outGid) && outGid != 0) {
                                return true;
                            }
                        }
                    }
                }
            }
            pos = objEnd + 1;
        }
        return false;
    }

    // Fetches the public gid for a single depot from the metadata mirrors,
    // stopping at the first mirror that returns a usable document.
    bool FetchPublicGidFromMetadataInternal(uint32_t appId, uint32_t depotId, uint64_t& outGid) {
        if (appId == 0 || depotId == 0) return false;

        int lastStatus = 0;
        std::string lastDiagnostic;
        for (const char *base : kSteamMetadataBases) {
            char url[192];
            snprintf(url, sizeof(url), "%s/%03u/%u.json", base,
                     static_cast<unsigned>(appId % 1000), static_cast<unsigned>(appId));

            auto resp = RuntimeHttp::GetLimited(url, {}, L"_0xoLemonCore-HubcapSync/1.0", 20000, 8 * 1024 * 1024);
            if (resp.networkError || resp.status != 200 || resp.body.empty()) {
                lastStatus = resp.status;
                lastDiagnostic = resp.diagnostic;
                continue;
            }
            if (ExtractPublicGidFromMetadata(resp.body, depotId, outGid)) {
                return true;
            }
            // The mirror answered but this depot is absent. A different mirror
            // cannot invent it, so stop instead of hammering every host.
            return false;
        }

        LOG_WARN("HubcapManifestSync: metadata fetch failed app={} depot={} HTTP={} err={}",
                 appId, depotId, lastStatus, lastDiagnostic);
        return false;
    }

    // Case-insensitive check that a line begins with the given lowercase token.
    bool LineStartsWithToken(std::string_view line, std::string_view tokenLower) {
        if (line.size() < tokenLower.size()) return false;
        for (size_t i = 0; i < tokenLower.size(); ++i)
            if (static_cast<char>(tolower(line[i])) != tokenLower[i]) return false;
        return true;
    }

    // Parses the leading integer argument of `call(depotId ...`.
    bool ParseLeadingDepotArg(std::string_view afterParen, uint32_t& depotId) {
        while (!afterParen.empty() && (afterParen.front() == ' ' || afterParen.front() == '\t'))
            afterParen.remove_prefix(1);
        size_t end = 0;
        while (end < afterParen.size() && afterParen[end] >= '0' && afterParen[end] <= '9') ++end;
        if (end == 0) return false;
        return ParseUint32Dec(afterParen.substr(0, end), depotId) && depotId != 0;
    }

    // Scans a Lua script content for manifest bindings:
    //   setManifestid(depotId, "gid" [, size])  -> depot with a pinned gid
    //   addappid(depotId [, ...])               -> depot only, gid=0 (live)
    // Live depots get their public gid resolved later from the metadata mirror.
    void ExtractManifestsFromLua(std::string_view content, uint32_t fallbackAppId,
                                 std::map<uint32_t, DepotTarget>& out) {
        static constexpr std::string_view kAddAppId = "addappid";
        size_t pos = 0;
        const size_t len = content.size();
        while (pos < len) {
            size_t nextNl = content.find('\n', pos);
            if (nextNl == std::string_view::npos) nextNl = len;
            std::string_view line = content.substr(pos, nextNl - pos);
            pos = nextNl + 1;

            // Trim leading whitespace
            while (!line.empty() && (line.front() == ' ' || line.front() == '\t' || line.front() == '\r'))
                line.remove_prefix(1);

            // Skip comments
            if (line.size() >= 2 && line[0] == '-' && line[1] == '-')
                continue;

            // addappid(depotId [, type, key]) -> depot only, gid resolved later.
            if (LineStartsWithToken(line, kAddAppId)) {
                if (line.size() > kAddAppId.size() &&
                    (line[kAddAppId.size()] == '(' || line[kAddAppId.size()] == ' ' || line[kAddAppId.size()] == '\t')) {
                    size_t addParen = line.find('(', kAddAppId.size());
                    if (addParen != std::string_view::npos) {
                        uint32_t addDepotId = 0;
                        if (ParseLeadingDepotArg(line.substr(addParen + 1), addDepotId)) {
                            if (out.find(addDepotId) == out.end())
                                out[addDepotId] = DepotTarget{ fallbackAppId, addDepotId, 0, "addappid" };
                        }
                    }
                }
                continue;
            }

            // Look for setManifestid (case-insensitive prefix)
            static constexpr std::string_view kPattern = "setmanifestid";
            if (line.size() < kPattern.size()) continue;

            // Case-insensitive match for "setmanifestid"
            bool match = true;
            for (size_t i = 0; i < kPattern.size(); ++i) {
                if (static_cast<char>(tolower(line[i])) != kPattern[i]) {
                    match = false;
                    break;
                }
            }
            if (!match) continue;

            size_t openParen = line.find('(', kPattern.size());
            if (openParen == std::string_view::npos) continue;

            size_t comma = line.find(',', openParen + 1);
            if (comma == std::string_view::npos) continue;

            std::string_view depotStr = line.substr(openParen + 1, comma - openParen - 1);
            while (!depotStr.empty() && (depotStr.front() == ' ' || depotStr.front() == '\t')) depotStr.remove_prefix(1);
            while (!depotStr.empty() && (depotStr.back() == ' ' || depotStr.back() == '\t')) depotStr.remove_suffix(1);

            uint32_t depotId = 0;
            if (!ParseUint32Dec(depotStr, depotId) || depotId == 0) continue;

            // Next is gid, which might be quoted with " or ' or plain digits
            std::string_view rest = line.substr(comma + 1);
            while (!rest.empty() && (rest.front() == ' ' || rest.front() == '\t')) rest.remove_prefix(1);

            std::string_view gidStr;
            if (!rest.empty() && (rest.front() == '"' || rest.front() == '\'')) {
                char quote = rest.front();
                rest.remove_prefix(1);
                size_t endQuote = rest.find(quote);
                if (endQuote == std::string_view::npos) continue;
                gidStr = rest.substr(0, endQuote);
            } else {
                size_t endDigit = rest.find_first_of(",) \t\r\n");
                if (endDigit == std::string_view::npos) endDigit = rest.size();
                gidStr = rest.substr(0, endDigit);
            }

            uint64_t gid = 0;
            if (!ParseUint64Dec(gidStr, gid) || gid == 0) continue;

            out[depotId] = DepotTarget{ fallbackAppId, depotId, gid, "setManifestid" };
        }
    }

    // Checks Steam depotcache for an existing valid manifest
    bool IsManifestPresentInSteam(uint32_t depotId, uint64_t gid) {
        if (SteamInstallPath[0] == '\0' || depotId == 0 || gid == 0) return false;
        fs::path p = fs::path(SteamInstallPath) / "depotcache" / MakeManifestFileName(depotId, gid);
        return IsValidManifestFile(p);
    }


    // Inspects depotcache for an older manifest for this depot
    std::optional<uint64_t> FindOldManifestInDepotcache(uint32_t depotId, uint64_t newGid) {
        if (SteamInstallPath[0] == '\0' || depotId == 0) return std::nullopt;
        fs::path cache = fs::path(SteamInstallPath) / "depotcache";
        std::error_code ec;
        if (!fs::is_directory(cache, ec) || ec) return std::nullopt;

        std::string prefix = std::to_string(depotId) + "_";
        for (const auto& entry : fs::directory_iterator(cache, ec)) {
            if (ec || !entry.is_regular_file(ec) || ec) continue;
            std::string name = entry.path().filename().string();
            if (name.rfind(prefix, 0) == 0 && name.size() > prefix.size() + 9) {
                if (name.substr(name.size() - 9) == ".manifest") {
                    std::string gidStr = name.substr(prefix.size(), name.size() - prefix.size() - 9);
                    uint64_t oldGid = 0;
                    if (ParseUint64Dec(gidStr, oldGid) && oldGid != 0 && oldGid != newGid) {
                        return oldGid;
                    }
                }
            }
        }
        return std::nullopt;
    }

    // Persists binary manifest to Steam depotcache and all Launcher Vault directories
    bool SaveManifestDual(uint32_t depotId, uint64_t gid, const std::string& bytes) {
        if (SteamInstallPath[0] == '\0' || bytes.size() < 64 || !IsValidManifestBuffer(bytes.data(), bytes.size())) return false;

        char fname[64];
        snprintf(fname, sizeof(fname), "%u_%llu.manifest",
                 static_cast<unsigned>(depotId), static_cast<unsigned long long>(gid));

        fs::path dest = fs::path(SteamInstallPath) / "depotcache" / fname;
        fs::path tmp = dest;
        tmp += ".tmp";

        std::error_code ec;
        fs::create_directories(dest.parent_path(), ec);

        std::ofstream out(tmp, std::ios::binary | std::ios::trunc);
        if (!out) {
            LOG_ERROR("HubcapManifestSync: Cannot create temp file for {}", fname);
            return false;
        }
        out.write(bytes.data(), bytes.size());
        out.close();
        if (!out) {
            fs::remove(tmp, ec);
            return false;
        }

        fs::rename(tmp, dest, ec);
        if (ec) {
            fs::remove(dest, ec);
            ec.clear();
            fs::rename(tmp, dest, ec);
            if (ec) {
                LOG_ERROR("HubcapManifestSync: Failed to rename to {}: {}", fname, ec.message());
                fs::remove(tmp, ec);
                return false;
            }
        }

        // Also duplicate to Launcher Vault dirs
        for (const auto& vaultDir : GetLauncherVaultDirs()) {
            ec.clear();
            fs::create_directories(vaultDir, ec);
            fs::path vaultDest = vaultDir / fname;
            fs::copy_file(dest, vaultDest, fs::copy_options::overwrite_existing, ec);
        }

        LOG_INFO("HubcapManifestSync: Persisted {} (sz={}) to depotcache & vault", fname, bytes.size());
        return true;
    }

    // Fetches single manifest from Hubcap Manifest API:
    // https://hubcapmanifest.com/api/v1/generate/manifest?depot_id={}&manifest_id={}
    enum class FetchResult {
        Success,
        RateLimited,
        Unauthorized,
        Failed
    };

    FetchResult FetchHubcapManifest(const std::string& key, uint32_t depotId, uint64_t gid, std::string& outBytes) {
        if (key.empty() || depotId == 0 || gid == 0) return FetchResult::Failed;

        char url[256];
        snprintf(url, sizeof(url),
                 "https://hubcapmanifest.com/api/v1/generate/manifest?depot_id=%u&manifest_id=%llu",
                 static_cast<unsigned>(depotId), static_cast<unsigned long long>(gid));

        std::vector<std::string> headers = {
            "Authorization: Bearer " + key,
            "Accept: application/octet-stream"
        };

        LOG_INFO("HubcapManifestSync: Requesting Hubcap manifest for depot={} gid={}", depotId, gid);
        auto resp = RuntimeHttp::GetLimited(url, headers, L"_0xoLemonCore-HubcapSync/1.0", 45000, 128 * 1024 * 1024);

        if (resp.status == 429) {
            LOG_WARN("HubcapManifestSync: Hubcap rate limit reached (HTTP 429) for depot={}", depotId);
            return FetchResult::RateLimited;
        }
        if (resp.status == 401 || resp.status == 403) {
            LOG_ERROR("HubcapManifestSync: Hubcap API key invalid or unauthorized (HTTP {})", resp.status);
            return FetchResult::Unauthorized;
        }
        if (resp.networkError || resp.status != 200 || resp.body.size() < 64 || !IsValidManifestBuffer(resp.body.data(), resp.body.size())) {
            LOG_WARN("HubcapManifestSync: Hubcap fetch failed for depot={} gid={} HTTP={} sz={} err={}",
                     depotId, gid, resp.status, resp.body.size(), resp.diagnostic);
            return FetchResult::Failed;
        }

        outBytes = std::move(resp.body);
        return FetchResult::Success;
    }

    // Primary free manifest source: manifest.steam.run (no key, no quota consumption)
    // Priority: manifest.steam.run (free) -> Hubcap (key) -> ManifestHub (fallback key)
    bool FetchSteamRunManifest(uint32_t depotId, uint64_t gid, std::string& outBytes) {
        if (depotId == 0 || gid == 0) return false;

        char url[256];
        snprintf(url, sizeof(url),
                 "https://manifest.steam.run/api/download_manifest?depot_id=%u&manifest_id=%llu",
                 static_cast<unsigned>(depotId), static_cast<unsigned long long>(gid));

        std::vector<std::string> headers = {
            "User-Agent: 0xoLemon-Launcher/2.0",
            "Accept: application/octet-stream"
        };

        LOG_INFO("HubcapManifestSync: Requesting free manifest.steam.run for depot={} gid={}", depotId, gid);
        auto resp = RuntimeHttp::GetLimited(url, headers, L"0xoLemon-Launcher/2.0", 35000, 32 * 1024 * 1024);

        if (!resp.networkError && resp.status == 200 && resp.body.size() >= 64 && IsValidManifestBuffer(resp.body.data(), resp.body.size())) {
            LOG_INFO("HubcapManifestSync: Successfully fetched free manifest from manifest.steam.run for depot={} gid={} (size={})",
                     depotId, gid, resp.body.size());
            outBytes = std::move(resp.body);
            return true;
        }
        LOG_INFO("HubcapManifestSync: manifest.steam.run missed/failed for depot={} gid={} (status={} net_err={})",
                 depotId, gid, resp.status, resp.diagnostic);
        return false;
    }

    // Secondary fallback: ManifestHub API
    FetchExOutcome FetchManifestHubManifestEx(const std::string& key, uint32_t depotId, uint64_t gid, std::string& outBytes);

    bool FetchManifestHubManifest(const std::string& key, uint32_t depotId, uint64_t gid, std::string& outBytes) {
        return FetchManifestHubManifestEx(key, depotId, gid, outBytes).state == FetchState::Success;
    }

    // Same call, but with the reason retained so EnsureManifest can pick the right
    // back-off: a 429 or an invalid key must NOT be retried on the next Steam
    // attempt, while a generic failure may be retried sooner.
    FetchExOutcome FetchManifestHubManifestEx(const std::string& key, uint32_t depotId, uint64_t gid, std::string& outBytes) {
        if (key.empty() || depotId == 0 || gid == 0) return {FetchState::Failed, 0};

        char url[256];
        snprintf(url, sizeof(url),
                 "https://api.manifesthub2.filegear-sg.me/manifest?apikey=%s&depotid=%u&manifestid=%llu",
                 key.c_str(), static_cast<unsigned>(depotId), static_cast<unsigned long long>(gid));

        LOG_INFO("HubcapManifestSync: Requesting ManifestHub fallback for depot={} gid={}", depotId, gid);
        auto resp = RuntimeHttp::GetLimited(url, {}, L"_0xoLemonCore-HubcapSync/1.0", 25000, 32 * 1024 * 1024);

        if (resp.status == 429) {
            LOG_WARN("HubcapManifestSync: ManifestHub rate limit reached (HTTP 429) for depot={}", depotId);
            return {FetchState::RateLimited, 429};
        }
        if (resp.status == 401 || resp.status == 403) {
            LOG_ERROR("HubcapManifestSync: ManifestHub API key invalid or unauthorized (HTTP {})", resp.status);
            return {FetchState::Unauthorized, resp.status};
        }
        if (!resp.networkError && resp.status == 200 && IsValidManifestBuffer(resp.body.data(), resp.body.size())) {
            outBytes = std::move(resp.body);
            return {FetchState::Success, 200};
        }
        LOG_WARN("HubcapManifestSync: ManifestHub fetch failed for depot={} gid={} HTTP={} sz={} err={}",
                 depotId, gid, resp.status, resp.body.size(), resp.diagnostic);
        return {FetchState::Failed, resp.status};
    }

} // anonymous namespace

    bool IsValidManifestBuffer(const void* data, size_t size) {
        // Thin delegate: the rule lives in core/entry.h so ManifestBind and
        // ManifestFetch cannot drift away from it again.
        return ::IsValidManifestBuffer(data, size);
    }

    bool IsValidManifestFile(const std::filesystem::path& path) {
        return ::IsValidManifestOnDisk(path);
    }

    bool IsManifestOnDisk(uint32_t depotId, uint64_t gid) {
        if (depotId == 0 || gid == 0 || SteamInstallPath[0] == '\0') return false;
        return IsManifestPresentInSteam(depotId, gid);
    }

    void ArchiveManifestToVault(uint32_t depotId, uint64_t gid) {
        if (depotId == 0 || gid == 0 || SteamInstallPath[0] == '\0') return;
        const std::string fname = MakeManifestFileName(depotId, gid);
        fs::path source = fs::path(SteamInstallPath) / "depotcache" / fname;
        if (!IsValidManifestFile(source)) return;
        std::error_code ec;
        for (const auto& vaultDir : GetLauncherVaultDirs()) {
            fs::create_directories(vaultDir, ec);
            fs::copy_file(source, vaultDir / fname, fs::copy_options::overwrite_existing, ec);
        }
        LOG_INFO("HubcapManifestSync: Archived {} into Launcher Vault", fname);
    }

    bool TryAutoHealFromVault(uint32_t depotId, uint64_t gid) {
        if (SteamInstallPath[0] == '\0' || depotId == 0 || gid == 0) return false;
        const std::string fname = MakeManifestFileName(depotId, gid);
        fs::path steamDest = fs::path(SteamInstallPath) / "depotcache" / fname;
        std::error_code ec;

        // Check the single official Launcher Vault directory
        for (const auto& vaultDir : GetLauncherVaultDirs()) {
            fs::path vaultFile = vaultDir / fname;
            if (IsValidManifestFile(vaultFile)) {
                fs::create_directories(steamDest.parent_path(), ec);
                fs::copy_file(vaultFile, steamDest, fs::copy_options::overwrite_existing, ec);
                if (!ec) {
                    LOG_INFO("HubcapManifestSync: Auto-healed {} from vault into depotcache", fname);
                    return true;
                }
            }
        }

        return false;
    }

    std::string GetHubcapApiKey() {
        std::lock_guard<std::mutex> lk(g_keyMutex);
        if (g_cachedHubcapKey.empty()) {
            g_cachedHubcapKey = ResolveHubcapApiKeyInternal();
        }
        return g_cachedHubcapKey;
    }

    std::string GetManifestHubApiKey() {
        std::lock_guard<std::mutex> lk(g_keyMutex);
        if (g_cachedManifestHubKey.empty()) {
            g_cachedManifestHubKey = ResolveManifestHubApiKeyInternal();
        }
        return g_cachedManifestHubKey;
    }

    bool FetchGidFromHubcapContents(uint32_t appId, uint32_t depotId, uint64_t& outGid) {
        if (appId == 0 || depotId == 0) return false;
        std::string key = GetHubcapApiKey();
        if (key.empty()) return false;

        char url[128];
        snprintf(url, sizeof(url), "https://hubcapmanifest.com/api/v1/manifest/%u/contents", static_cast<unsigned>(appId));

        std::vector<std::string> headers;
        headers.push_back("Authorization: Bearer " + key);

        auto resp = RuntimeHttp::GetLimited(url, headers, L"_0xoLemonCore-HubcapSync/1.0", 15000, 4 * 1024 * 1024);
        if (resp.networkError || resp.status != 200 || resp.body.empty()) {
            LOG_WARN("HubcapManifestSync: Hubcap contents fetch failed app={} depot={} HTTP={} err={}",
                     appId, depotId, resp.status, resp.diagnostic);
            return false;
        }

        if (ExtractGidFromHubcapContents(resp.body, depotId, outGid)) {
            LOG_INFO("HubcapManifestSync: resolved GID={} for app={} depot={} from Hubcap contents",
                     outGid, appId, depotId);
            return true;
        }
        return false;
    }

    bool FetchGidFromSteamRun(uint32_t appId, uint32_t depotId, uint64_t& outGid) {
        if (appId == 0 || depotId == 0) return false;

        char url[192];
        snprintf(url, sizeof(url), "https://manifest.steam.run/api/depot/%u", static_cast<unsigned>(appId));

        std::vector<std::string> headers = {
            "User-Agent: 0xoLemon-Launcher/2.0",
            "Accept: application/json"
        };
        auto resp = RuntimeHttp::GetLimited(url, headers, L"0xoLemon-Launcher/2.0", 15000, 4 * 1024 * 1024);
        if (resp.networkError || resp.status != 200 || resp.body.empty()) {
            return false;
        }

        if (ExtractGidFromSteamRun(resp.body, depotId, outGid)) {
            LOG_INFO("HubcapManifestSync: resolved GID={} for app={} depot={} from manifest.steam.run",
                     outGid, appId, depotId);
            return true;
        }
        return false;
    }

    bool FetchPublicGidFromMetadata(uint32_t appId, uint32_t depotId, uint64_t& outGid) {
        // 1. Primary: Steam metadata mirror (GitHub raw CDN)
        if (FetchPublicGidFromMetadataInternal(appId, depotId, outGid) && outGid != 0) {
            return true;
        }
        // 2. Secondary Free Source: manifest.steam.run (free, 0 key required)
        if (FetchGidFromSteamRun(appId, depotId, outGid) && outGid != 0) {
            return true;
        }
        // 3. Additive Fallback: Hubcap /contents endpoint (free, 0 quota)
        if (FetchGidFromHubcapContents(appId, depotId, outGid) && outGid != 0) {
            return true;
        }
        return false;
    }

    static std::mutex g_failureCooldownMutex;
    static std::map<std::pair<uint32_t, uint64_t>, std::chrono::steady_clock::time_point> g_failureCooldown;

    bool IsManifestFetchCoolingDown(uint32_t depotId, uint64_t gid) {
        if (depotId == 0 || gid == 0) return false;
        std::lock_guard<std::mutex> lk(g_failureCooldownMutex);
        auto it = g_failureCooldown.find({depotId, gid});
        if (it == g_failureCooldown.end()) return false;
        return std::chrono::steady_clock::now() - it->second < std::chrono::seconds(kFailureCooldownSec);
    }

    // Remembers a *successful* fetch for the same window as a failure. Without
    // this, a manifest that is successfully downloaded but then rejected by
    // Steam (or a depot whose manifest we must not serve) produced an unbounded
    // download/failure loop: Steam retried, we re-fetched, Steam failed again.
    static void NoteManifestFetchCooldown(uint32_t depotId, uint64_t gid) {
        std::lock_guard<std::mutex> lk(g_failureCooldownMutex);
        g_failureCooldown[{depotId, gid}] = std::chrono::steady_clock::now();
    }

    bool EnsureManifest(uint32_t depotId, uint64_t gid) {
        if (depotId == 0 || gid == 0) return false;

        // 1. Check Steam depotcache
        if (IsManifestPresentInSteam(depotId, gid))
            return true;

        // 2. Auto-heal from Launcher Vault
        if (TryAutoHealFromVault(depotId, gid)) {
            AutoRetry::OnManifestReady(depotId, gid);
            return true;
        }

        // 3. Anti-spam cooldown. This guards BOTH directions: a recent failure and
        // a recent success. Steam re-asks for the same manifest on every retry, so
        // without a success guard a game that cannot accept the downloaded manifest
        // burns quota forever.
        auto depotKey = std::make_pair(depotId, gid);
        {
            std::lock_guard<std::mutex> lk(g_failureCooldownMutex);
            auto it = g_failureCooldown.find(depotKey);
            if (it != g_failureCooldown.end()) {
                auto elapsedSec = std::chrono::duration_cast<std::chrono::seconds>(
                    std::chrono::steady_clock::now() - it->second).count();
                if (elapsedSec < kFailureCooldownSec) {
                    LOG_INFO("HubcapManifestSync: depot={} gid={} already attempted {}s ago, "
                             "cooling down {}s (quota guard)",
                             depotId, gid, elapsedSec, kFailureCooldownSec - elapsedSec);
                    return false;
                }
            }
        }

        // 3b. Single-flight: parallel Steam workers asking for the same depot must
        // not each fire a paid request. Only one thread performs the download; the
        // others fall through to the depotcache check in their caller.
        {
            std::lock_guard<std::mutex> lk(g_singleflightMutex);
            if (!g_inflightFetches.insert(depotKey).second) {
                LOG_INFO("HubcapManifestSync: depot={} gid={} fetch already in flight, not duplicating",
                         depotId, gid);
                return false;
            }
        }

        bool saved = false;
        FetchState worst = FetchState::Failed;
        int worstStatus = 0;

        // 4. Primary Free Source: manifest.steam.run (prioritized before paid Hubcap quota)
        {
            std::string bytes;
            if (FetchSteamRunManifest(depotId, gid, bytes) && !bytes.empty()) {
                saved = SaveManifestDual(depotId, gid, bytes);
                if (saved) {
                    LOG_INFO("HubcapManifestSync: Successfully acquired manifest for depot={} gid={} from free steam.run source",
                             depotId, gid);
                }
            }
        }

        // 5. Download from Hubcap (paid quota key — fallback when steam.run misses)
        if (!saved) {
            std::string hubcapKey = GetHubcapApiKey();
            if (!hubcapKey.empty()) {
                std::string bytes;
                auto res = FetchHubcapManifest(hubcapKey, depotId, gid, bytes);
                if (res == FetchResult::Success && !bytes.empty()) {
                    saved = SaveManifestDual(depotId, gid, bytes);
                } else {
                    worst = res == FetchResult::RateLimited   ? FetchState::RateLimited
                          : res == FetchResult::Unauthorized  ? FetchState::Unauthorized
                                                              : FetchState::Failed;
                }
            } else {
                worst = FetchState::NoProvider;
            }
        }

        // 6. Download from ManifestHub fallback (skipped when steam.run or Hubcap already succeeded)
        if (!saved) {
            std::string mhKey = GetManifestHubApiKey();
            if (!mhKey.empty()) {
                std::string bytes;
                auto res = FetchManifestHubManifestEx(mhKey, depotId, gid, bytes);
                if (res.state == FetchState::Success && !bytes.empty()) {
                    saved = SaveManifestDual(depotId, gid, bytes);
                } else if (res.state == FetchState::RateLimited) {
                    worst = FetchState::RateLimited;
                    worstStatus = res.status;
                } else if (res.state == FetchState::Unauthorized && worst != FetchState::RateLimited) {
                    worst = FetchState::Unauthorized;
                    worstStatus = res.status;
                } else if (res.state == FetchState::Failed &&
                           worst != FetchState::RateLimited &&
                           worst != FetchState::Unauthorized) {
                    // Keep the status so a definitive 404 can be persisted as
                    // not_found rather than being lumped in with transport noise.
                    worst = FetchState::Failed;
                    worstStatus = res.status;
                }
            }
        }

        {
            std::lock_guard<std::mutex> lk(g_singleflightMutex);
            g_inflightFetches.erase(depotKey);
        }

        if (saved) {
            AutoRetry::OnManifestReady(depotId, gid);
            NoteManifestFetchCooldown(depotId, gid);
            // A depot that just produced a manifest is by definition servable
            // again; clear any unservable tally so it is not stripped from
            // Steam's dependency vector.
            ManifestStateCache::ClearUnservable(depotId);
            return true;
        }

        // Mirror the provider's verdict into the persisted store so later
        // sessions skip a lookup that cannot succeed.
        if (worst == FetchState::Unauthorized) {
            ManifestStateCache::MarkUnauthorized(depotId, gid);
        } else if (worst == FetchState::RateLimited) {
            // Transient - deliberately not persisted.
        } else if (worst == FetchState::NoProvider || worst == FetchState::Failed) {
            // Only *definitive* absence is worth remembering; a generic Failed
            // can be a transport hiccup that must be retried.
            if (worstStatus == 404) ManifestStateCache::MarkNotFound(depotId, gid);
        }

        // Record the attempt so Steam's next retry inside the window is answered
        // from the cache instead of hammering the network.
        // NoProvider means no key is configured at all — that can change at any
        // moment (user adds a key, steam.run becomes available), so we deliberately
        // skip the cooldown so the next Steam retry can try immediately.
        AutoRetry::OnManifestFailed(depotId, gid);
        if (worst != FetchState::NoProvider) {
            NoteManifestFetchCooldown(depotId, gid);
            LOG_WARN("HubcapManifestSync: depot={} gid={} could not be sourced (state={}, http={}); "
                     "backing off {}s",
                     depotId, gid, static_cast<int>(worst), worstStatus, kFailureCooldownSec);
        } else {
            LOG_WARN("HubcapManifestSync: depot={} gid={} could not be sourced (state=NoProvider, http={}); "
                     "no cooldown — will retry on next Steam request",
                     depotId, gid, worstStatus);
        }

        return false;
    }

    size_t CheckAndSyncAll() {
        std::unique_lock<std::mutex> execLock(g_syncExecutionMutex, std::try_to_lock);
        if (!execLock.owns_lock()) {
            LOG_INFO("HubcapManifestSync: Sync already in progress, skipping concurrent run");
            return 0;
        }

        std::string hubcapKey = GetHubcapApiKey();
        std::string mhKey = GetManifestHubApiKey();

        if (hubcapKey.empty() && mhKey.empty()) {
            LOG_INFO("HubcapManifestSync: No Hubcap or ManifestHub API key configured; performing vault auto-heal only");
        }

        std::map<uint32_t, DepotTarget> targets;

        // 1. Collect targets from LuaLoader's parsed overrides
        const auto& overrides = LuaLoader::GetManifestOverrides();
        for (const auto& [depotId, overrideEntry] : overrides) {
            if (overrideEntry.gid != 0) {
                targets[static_cast<uint32_t>(depotId)] = DepotTarget{
                    0, static_cast<uint32_t>(depotId), overrideEntry.gid, "LuaLoader::GetManifestOverrides"
                };
            }
        }

        // 2. Collect targets directly from Lua files in stplug-in
        std::vector<std::string> searchDirs;
        if (LuaDir[0] != '\0') searchDirs.push_back(LuaDir);
        for (const auto& p : Settings::luaPaths) searchDirs.push_back(p);

        for (const auto& dir : searchDirs) {
            std::error_code ec;
            if (!fs::is_directory(dir, ec) || ec) continue;
            for (const auto& entry : fs::directory_iterator(dir, ec)) {
                if (ec || !entry.is_regular_file(ec) || ec) continue;
                auto path = entry.path();
                if (path.extension() == ".lua") {
                    uint32_t fileAppId = 0;
                    std::string stem = path.stem().string();
                    ParseUint32Dec(stem, fileAppId);

                    std::ifstream f(path, std::ios::binary);
                    if (f) {
                        std::string content((std::istreambuf_iterator<char>(f)), std::istreambuf_iterator<char>());
                        ExtractManifestsFromLua(content, fileAppId, targets);
                    }
                }
            }
        }

        LOG_INFO("HubcapManifestSync: Checking {} depot targets for Vault auto-heal", targets.size());

        size_t healedCount = 0;

        for (const auto& [depotId, storedTarget] : targets) {
            DepotTarget target = storedTarget;

            // Step 0: Resolve public gid for live depots if needed
            if (target.gid == 0 && target.appId != 0) {
                uint64_t resolved = 0;
                if (!FetchPublicGidFromMetadata(target.appId, target.depotId, resolved)) {
                    continue;
                }
                target.gid = resolved;
            }

            if (target.gid == 0) continue;

            // Step 1: Check if already present in Steam's depotcache
            if (IsManifestPresentInSteam(target.depotId, target.gid)) {
                continue;
            }

            // Step 2: Auto-heal ONLY from Launcher Vault — NEVER use network quota in background!
            // Hubcap API downloads are strictly ON-DEMAND when the user installs or plays a game.
            if (TryAutoHealFromVault(target.depotId, target.gid)) {
                healedCount++;
            }
        }

        if (healedCount > 0) {
            LOG_INFO("HubcapManifestSync: Vault auto-healed {} manifest(s) into depotcache", healedCount);
        }
        return healedCount;
    }

    void StartBackgroundWorker() {
        if (g_workerRunning.exchange(true)) return;

        g_workerThread = std::thread([]() {
            LOG_INFO("HubcapManifestSync: Background worker started");

            // Initial delay so Steam startup and initial login complete unhindered
            {
                std::unique_lock<std::mutex> lk(g_workerMutex);
                g_workerCv.wait_for(lk, std::chrono::seconds(5), [] {
                    return !g_workerRunning || g_syncRequested;
                });
            }

            while (g_workerRunning) {
                g_syncRequested = false;

                if (Settings::hubcapAutoSyncEnabled) {
                    CheckAndSyncAll();
                }

                int intervalMinutes = Settings::hubcapSyncIntervalMinutes > 0
                    ? Settings::hubcapSyncIntervalMinutes
                    : 30;

                std::unique_lock<std::mutex> lk(g_workerMutex);
                g_workerCv.wait_for(lk, std::chrono::minutes(intervalMinutes), [] {
                    return !g_workerRunning || g_syncRequested;
                });
            }

            LOG_INFO("HubcapManifestSync: Background worker stopped");
        });
    }

    void StopBackgroundWorker() {
        if (!g_workerRunning.exchange(false)) return;
        {
            std::lock_guard<std::mutex> lk(g_workerMutex);
            g_syncRequested = true;
        }
        g_workerCv.notify_all();
        if (g_workerThread.joinable()) {
            g_workerThread.join();
        }
    }

    void TriggerSync() {
        {
            std::lock_guard<std::mutex> lk(g_workerMutex);
            g_syncRequested = true;
        }
        g_workerCv.notify_all();
    }

    void StartAsyncWorker() {
        if (g_asyncRunning.exchange(true)) return;

        g_asyncThread = std::thread([]() {
            LOG_INFO("HubcapManifestSync: Async fetch worker started");
            while (true) {
                std::pair<uint32_t, uint64_t> job{0, 0};
                {
                    std::unique_lock<std::mutex> lk(g_asyncMutex);
                    g_asyncCv.wait(lk, [] {
                        return !g_asyncRunning || !g_asyncQueue.empty();
                    });
                    if (!g_asyncRunning && g_asyncQueue.empty()) break;
                    if (g_asyncQueue.empty()) continue;
                    job = g_asyncQueue.front();
                    g_asyncQueue.pop_front();
                    // Stays in g_asyncQueued while running: that is what makes a
                    // second request for the same pair a no-op instead of a
                    // duplicate fetch.
                }

                // EnsureManifest is the blocking fetch. Running it here, off the
                // UI thread, is the whole point of this worker. It is safe to
                // call from a non-hook thread: it only touches depotcache, the
                // vault and the HTTP client, and all three are internally locked.
                bool ok = false;
                if (g_asyncRunning) {
                    ok = EnsureManifest(job.first, job.second);
                    LOG_INFO("HubcapManifestSync: Async fetch depot={} gid={} -> {}",
                             job.first, job.second, ok ? "ready" : "failed");
                }

                {
                    std::lock_guard<std::mutex> lk(g_asyncMutex);
                    g_asyncQueued.erase(job);
                }
            }
            LOG_INFO("HubcapManifestSync: Async fetch worker stopped");
        });
    }

    void StopAsyncWorker() {
        if (!g_asyncRunning.exchange(false)) return;
        {
            std::lock_guard<std::mutex> lk(g_asyncMutex);
            g_asyncQueue.clear();
            g_asyncQueued.clear();
        }
        g_asyncCv.notify_all();
        if (g_asyncThread.joinable()) {
            g_asyncThread.join();
        }
    }

    bool EnsureManifestAsync(uint32_t depotId, uint64_t gid) {
        if (depotId == 0 || gid == 0) return false;

        // Fast path: manifest already present (depotcache or vault). This is a
        // pure local read, so it is cheap enough to run on the calling thread
        // and it is what lets the caller bind the gid immediately without any
        // waiting at all - the common case once Steam has retried a few times.
        if (IsManifestPresentInSteam(depotId, gid) || TryAutoHealFromVault(depotId, gid)) {
            return true;
        }

        const auto key = std::make_pair(depotId, gid);
        {
            std::lock_guard<std::mutex> lk(g_asyncMutex);

            // Already queued or being fetched: nothing to do. Steam calls
            // BuildDepotDependency dozens of times per session, so this dedupe
            // is what keeps the cost at one request per depot.
            if (!g_asyncQueued.insert(key).second) {
                LOG_INFO("HubcapManifestSync: depot={} gid={} already queued/in-flight, not duplicating",
                         depotId, gid);
                return false;
            }

            // Bounded queue: drop the oldest pending entry rather than grow.
            if (g_asyncQueue.size() >= kAsyncQueueMax) {
                const auto dropped = g_asyncQueue.front();
                g_asyncQueue.pop_front();
                g_asyncQueued.erase(dropped);
                LOG_WARN("HubcapManifestSync: async queue full, dropped depot={} gid={}",
                         dropped.first, dropped.second);
            }

            g_asyncQueue.push_back(key);
        }
        g_asyncCv.notify_one();

        LOG_INFO("HubcapManifestSync: depot={} gid={} queued for async fetch (depth={})",
                 depotId, gid, AsyncQueueDepth());
        return false;
    }

    size_t AsyncQueueDepth() {
        std::lock_guard<std::mutex> lk(g_asyncMutex);
        // g_asyncQueued holds both waiting and in-flight entries; that total is
        // the useful depth ("how much async work is outstanding right now").
        return g_asyncQueued.size();
    }

} // namespace HubcapManifestSync
