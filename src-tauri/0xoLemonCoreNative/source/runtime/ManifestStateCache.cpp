// _0xoLemonCore - Steam client hook layer for SteaMidra.
// Copyright (c) 2025-2026 Midrag (https://github.com/Midrags).
// Distributed under the GNU General Public License v3 or later.
// See <https://www.gnu.org/licenses/> for the full license text.
//
// See ManifestStateCache.h for the contract. The on-disk format is a small
// flat JSON object written with a hand-rolled serialiser: the core already
// parses tiny scalar JSON by hand (ManifestFetch.cpp) and pulling in a full
// parser for four maps would be out of proportion.
//
// Layout:
//   {
//     "version": 1,
//     "codes":  { "241100_7613356809904826842": 1234567890, ... },
//     "unauth": ["241100_7613356809904826842", ...],
//     "notfound": ["241100_7613356809904826842", ...],
//     "unservable": { "241100": 3, ... }
//   }
//
// All maps are bounded (kMaxEntries) so a long-lived install can't grow the
// store without limit; the oldest-inserted entries are dropped first.

#include "ManifestStateCache.h"
#include "Logger.h"
#include "core/entry.h"

#include <algorithm>
#include <cctype>
#include <charconv>
#include <chrono>
#include <filesystem>
#include <fstream>
#include <map>
#include <mutex>
#include <sstream>
#include <string>
#include <unordered_map>
#include <unordered_set>
#include <vector>

#include <windows.h>

namespace fs = std::filesystem;

namespace ManifestStateCache {

namespace {

    // ---- bounds ------------------------------------------------------------

    // Upper bound on each persisted map/set. A launcher install with ~1000
    // depots and a handful of builds each lands well under this; the cap only
    // exists so the file cannot grow unbounded across years of use.
    constexpr size_t kMaxEntries = 20000;

    // A depot that has failed to yield a request code this many times is
    // treated as permanently unservable. Matches the "no request_code %dx"
    // convention HubcapTools uses before stripping a depot.
    constexpr int kUnservableThreshold = 3;

    std::mutex g_mutex;
    bool       g_loaded = false;

    // (depotId, gid) packed into one uint64-friendly key for map lookups.
    uint64_t Key(uint32_t depotId, uint64_t gid) {
        return (static_cast<uint64_t>(depotId) << 40) ^ (gid & 0xFFFFFFFFFFULL);
    }

    // Stable textual key used in the JSON file: "<depotId>_<gid>".
    std::string KeyText(uint32_t depotId, uint64_t gid) {
        return std::to_string(depotId) + "_" + std::to_string(gid);
    }

    bool ParseKeyText(std::string_view text, uint32_t& depotId, uint64_t& gid) {
        size_t sep = text.find('_');
        if (sep == std::string_view::npos || sep == 0) return false;
        uint32_t d = 0;
        uint64_t g = 0;
        auto [p1, e1] = std::from_chars(text.data(), text.data() + sep, d);
        if (e1 != std::errc{} || p1 != text.data() + sep) return false;
        auto [p2, e2] = std::from_chars(text.data() + sep + 1,
                                        text.data() + text.size(), g);
        if (e2 != std::errc{} || p2 != text.data() + text.size()) return false;
        if (d == 0 || g == 0) return false;
        depotId = d;
        gid = g;
        return true;
    }

    std::unordered_map<uint64_t, uint64_t> g_codes;
    std::unordered_set<uint64_t>           g_unauthorized;
    std::unordered_set<uint64_t>           g_notFound;
    std::map<uint32_t, int>                g_unservable;

    // depotId -> gid the provider currently serves. Keyed on the depot alone:
    // a depot belongs to exactly one app, and the point of the entry is "Lua's
    // gid for this depot is not the served one".
    std::map<uint32_t, uint64_t>           g_liveGids;

    // Insertion order, so the oldest entries can be evicted when a store hits
    // kMaxEntries. Only the code map and the two sets need this.
    std::vector<uint64_t> g_codeOrder;
    std::vector<uint64_t> g_unauthOrder;
    std::vector<uint64_t> g_notFoundOrder;

    // Separates the on-disk schema from the earlier four-store layout. A store
    // written by an older build does not carry live gids; bumping the marker
    // makes that read as "no live gids yet" instead of a parse error, and the
    // next successful resolve repopulates it.
    constexpr int kStoreVersion = 2;

    // ---- store location ----------------------------------------------------

    std::string StoreDir() {
        const wchar_t* appdata = _wgetenv(L"APPDATA");
        if (!appdata || appdata[0] == L'\0') return {};
        fs::path dir = fs::path(appdata) / L"com.0xolemon.launcher" / L"manifest-state";
        return dir.string();
    }

    std::string StorePath() {
        std::string dir = StoreDir();
        if (dir.empty()) return {};
        return (fs::path(dir) / L"manifest_state.json").string();
    }

    // ---- JSON serialise / parse -------------------------------------------

    std::string SerializeLocked() {
        std::ostringstream out;
        out << "{\n  \"version\": " << kStoreVersion << ",\n";

        out << "  \"codes\": {";
        bool first = true;
        for (const auto& [key, code] : g_codes) {
            uint32_t depotId = static_cast<uint32_t>(key >> 40);
            uint64_t gid = key & 0xFFFFFFFFFFULL;
            if (!first) out << ',';
            first = false;
            out << "\n    '" << KeyText(depotId, gid) << "': " << code;
        }
        out << (first ? "" : "\n  ") << "},\n";

        const auto writeSet = [&](const char* name,
                                  const std::unordered_set<uint64_t>& set,
                                  bool last) {
            out << "  '" << name << "': [";
            bool f = true;
            for (uint64_t key : set) {
                uint32_t depotId = static_cast<uint32_t>(key >> 40);
                uint64_t gid = key & 0xFFFFFFFFFFULL;
                if (!f) out << ',';
                f = false;
                out << "\n    '" << KeyText(depotId, gid) << "'";
            }
            out << (f ? "" : "\n  ") << "]" << (last ? "\n" : ",\n");
        };
        writeSet("unauth", g_unauthorized, false);
        writeSet("notfound", g_notFound, false);

        out << "  \"unservable\": {";
        bool uf = true;
        for (const auto& [depotId, count] : g_unservable) {
            if (!uf) out << ',';
            uf = false;
            out << "\n    '" << depotId << "': " << count;
        }
        out << (uf ? "" : "\n  ") << "},\n";

        out << "  \"livegid\": {";
        bool lf = true;
        for (const auto& [depotId, gid] : g_liveGids) {
            if (!lf) out << ',';
            lf = false;
            out << "\n    '" << depotId << "': " << gid;
        }
        out << (lf ? "" : "\n  ") << "}\n}\n";
        return out.str();
    }

    // Pulls the contents of "<key>": { ... } / [ ... ] / "..." out of the
    // flat document. Returns the inner text without the delimiters. This is
    // deliberately the same tag-scanning approach ManifestFetch uses for the
    // provider responses: the schema is ours, tiny and stable.
    bool ExtractBlock(std::string_view json, std::string_view key,
                      char open, char close, std::string_view& out) {
        std::string pat = "'" + std::string(key) + "'";
        size_t pos = json.find(pat);
        if (pos == std::string_view::npos) return false;
        size_t start = json.find(open, pos + pat.size());
        if (start == std::string_view::npos) return false;
        int depth = 0;
        bool inStr = false;
        for (size_t i = start; i < json.size(); ++i) {
            char c = json[i];
            if (inStr) {
                if (c == '\\') { ++i; continue; }
                if (c == '"') inStr = false;
                continue;
            }
            if (c == '"') { inStr = true; continue; }
            if (c == open)  ++depth;
            else if (c == close) {
                if (--depth == 0) {
                    out = json.substr(start + 1, i - start - 1);
                    return true;
                }
            }
        }
        return false;
    }

    // Splits "a","b","c" style list bodies into the individual quoted items.
    std::vector<std::string> SplitQuoted(std::string_view body) {
        std::vector<std::string> items;
        size_t i = 0;
        while (i < body.size()) {
            size_t q1 = body.find('"', i);
            if (q1 == std::string_view::npos) break;
            size_t q2 = body.find('"', q1 + 1);
            if (q2 == std::string_view::npos) break;
            items.emplace_back(body.substr(q1 + 1, q2 - q1 - 1));
            i = q2 + 1;
        }
        return items;
    }

    void TrimToCap() {
        while (g_codes.size() > kMaxEntries && !g_codeOrder.empty()) {
            g_codes.erase(g_codeOrder.front());
            g_codeOrder.erase(g_codeOrder.begin());
        }
        while (g_unauthorized.size() > kMaxEntries && !g_unauthOrder.empty()) {
            g_unauthorized.erase(g_unauthOrder.front());
            g_unauthOrder.erase(g_unauthOrder.begin());
        }
        while (g_notFound.size() > kMaxEntries && !g_notFoundOrder.empty()) {
            g_notFound.erase(g_notFoundOrder.front());
            g_notFoundOrder.erase(g_notFoundOrder.begin());
        }
    }

    void SaveLocked() {
        std::string path = StorePath();
        if (path.empty()) return;

        std::error_code ec;
        fs::create_directories(fs::path(path).parent_path(), ec);

        const std::string body = SerializeLocked();
        fs::path tmp = fs::path(path);
        tmp += ".tmp";

        {
            std::ofstream out(tmp, std::ios::binary | std::ios::trunc);
            if (!out) {
                LOG_WARN("ManifestStateCache: cannot open {} for write", tmp.string());
                return;
            }
            out.write(body.data(), static_cast<std::streamsize>(body.size()));
            out.close();
            if (!out) return;
        }

        fs::rename(tmp, fs::path(path), ec);
        if (ec) {
            fs::remove(fs::path(path), ec);
            ec.clear();
            fs::rename(tmp, fs::path(path), ec);
            if (ec) {
                LOG_WARN("ManifestStateCache: rename failed for {}: {}", path, ec.message());
                fs::remove(tmp, ec);
            }
        }
    }

    void LoadLocked() {
        std::string path = StorePath();
        if (path.empty()) return;

        std::error_code ec;
        if (!fs::is_regular_file(path, ec) || ec) return;

        std::ifstream in(path, std::ios::binary);
        if (!in) return;
        std::string json((std::istreambuf_iterator<char>(in)),
                          std::istreambuf_iterator<char>());
        if (json.empty()) return;

        // version gate: unknown schema is discarded rather than misread. A
        // store from an older build has different store names AND a different
        // version marker; both are caught here.
        if (json.find("\"version\"") == std::string::npos ||
            json.find("\"version\": " + std::to_string(kStoreVersion)) == std::string::npos) {
            LOG_WARN("ManifestStateCache: unrecognised store version, starting empty");
            return;
        }

        std::string_view block;

        // codes: { "depot_gid": code, ... }
        if (ExtractBlock(json, "codes", '{', '}', block)) {
            size_t i = 0;
            while (i < block.size()) {
                size_t q1 = block.find('"', i);
                if (q1 == std::string_view::npos) break;
                size_t q2 = block.find('"', q1 + 1);
                if (q2 == std::string_view::npos) break;
                std::string_view keyText = block.substr(q1 + 1, q2 - q1 - 1);

                size_t colon = block.find(':', q2 + 1);
                if (colon == std::string_view::npos) break;
                size_t valEnd = block.find_first_of(",}", colon + 1);
                if (valEnd == std::string_view::npos) valEnd = block.size();

                uint32_t depotId = 0;
                uint64_t gid = 0, code = 0;
                if (ParseKeyText(keyText, depotId, gid)) {
                    std::string_view val = block.substr(colon + 1, valEnd - colon - 1);
                    while (!val.empty() && std::isspace(static_cast<unsigned char>(val.front())))
                        val.remove_prefix(1);
                    auto [p, e] = std::from_chars(val.data(), val.data() + val.size(), code);
                    if (e == std::errc{} && code != 0) {
                        g_codes[Key(depotId, gid)] = code;
                        g_codeOrder.push_back(Key(depotId, gid));
                    }
                }
                i = valEnd;
            }
        }

        const auto loadSet = [&](const char* name, std::unordered_set<uint64_t>& set,
                                 std::vector<uint64_t>& order) {
            std::string_view list;
            if (!ExtractBlock(json, name, '[', ']', list)) return;
            for (const auto& item : SplitQuoted(list)) {
                uint32_t depotId = 0;
                uint64_t gid = 0;
                if (!ParseKeyText(item, depotId, gid)) continue;
                uint64_t key = Key(depotId, gid);
                if (set.insert(key).second) order.push_back(key);
            }
        };
        loadSet("unauth", g_unauthorized, g_unauthOrder);
        loadSet("notfound", g_notFound, g_notFoundOrder);

        // unservable: { "depotId": count, ... }
        if (ExtractBlock(json, "unservable", '{', '}', block)) {
            size_t i = 0;
            while (i < block.size()) {
                size_t q1 = block.find('"', i);
                if (q1 == std::string_view::npos) break;
                size_t q2 = block.find('"', q1 + 1);
                if (q2 == std::string_view::npos) break;
                uint32_t depotId = 0;
                auto [p, e] = std::from_chars(block.data() + q1 + 1, block.data() + q2, depotId);
                if (e == std::errc{} && depotId != 0) {
                    size_t colon = block.find(':', q2 + 1);
                    if (colon != std::string_view::npos) {
                        int count = 0;
                        std::string_view val = block.substr(colon + 1);
                        auto [p2, e2] = std::from_chars(val.data(), val.data() + val.size(), count);
                        if (e2 == std::errc{} && count > 0) g_unservable[depotId] = count;
                    }
                }
                i = q2 + 1;
            }
        }

        // livegid: { "depotId": gid, ... }
        // Absent in a store written before this field existed; that is not an
        // error, it just means nothing has been resolved yet.
        if (ExtractBlock(json, "livegid", '{', '}', block)) {
            size_t i = 0;
            while (i < block.size()) {
                size_t q1 = block.find('\'', i);
                if (q1 == std::string_view::npos) break;
                size_t q2 = block.find('\'', q1 + 1);
                if (q2 == std::string_view::npos) break;
                uint32_t depotId = 0;
                auto [p, e] = std::from_chars(block.data() + q1 + 1, block.data() + q2, depotId);
                if (e == std::errc{} && depotId != 0) {
                    size_t colon = block.find(':', q2 + 1);
                    if (colon != std::string_view::npos) {
                        uint64_t gid = 0;
                        std::string_view val = block.substr(colon + 1);
                        auto [p2, e2] = std::from_chars(val.data(), val.data() + val.size(), gid);
                        if (e2 == std::errc{} && gid != 0) g_liveGids[depotId] = gid;
                    }
                }
                i = q2 + 1;
            }
        }

        TrimToCap();
        LOG_INFO("ManifestStateCache: loaded {} code(s), {} unauthorized, {} notfound, {} unservable, {} live gid(s) from {}",
                 g_codes.size(), g_unauthorized.size(), g_notFound.size(),
                 g_unservable.size(), g_liveGids.size(), path);
    }

    void EnsureLoadedLocked() {
        if (g_loaded) return;
        g_loaded = true;
        LoadLocked();
    }

} // anonymous namespace
void LoadOnce() {
    std::lock_guard<std::mutex> lk(g_mutex);
    EnsureLoadedLocked();
}

std::optional<uint64_t> GetLiveGid(uint32_t depotId) {
    if (depotId == 0) return std::nullopt;
    std::lock_guard<std::mutex> lk(g_mutex);
    EnsureLoadedLocked();
    auto it = g_liveGids.find(depotId);
    if (it == g_liveGids.end()) return std::nullopt;
    return it->second;
}

void PutLiveGid(uint32_t depotId, uint64_t gid) {
    if (depotId == 0 || gid == 0) return;
    std::lock_guard<std::mutex> lk(g_mutex);
    EnsureLoadedLocked();
    auto [it, inserted] = g_liveGids.emplace(depotId, gid);
    if (!inserted) {
        if (it->second == gid) return;   // unchanged, skip the disk write
        it->second = gid;
    }
    TrimToCap();
    SaveLocked();
}

std::optional<uint64_t> GetRequestCode(uint32_t depotId, uint64_t gid) {
    if (depotId == 0 || gid == 0) return std::nullopt;
    std::lock_guard<std::mutex> lk(g_mutex);
    EnsureLoadedLocked();
    auto it = g_codes.find(Key(depotId, gid));
    if (it == g_codes.end()) return std::nullopt;
    return it->second;
}

void PutRequestCode(uint32_t depotId, uint64_t gid, uint64_t code) {
    if (depotId == 0 || gid == 0 || code == 0) return;
    std::lock_guard<std::mutex> lk(g_mutex);
    EnsureLoadedLocked();
    uint64_t key = Key(depotId, gid);
    auto [it, inserted] = g_codes.emplace(key, code);
    if (!inserted) {
        if (it->second == code) return;   // unchanged, skip the disk write
        it->second = code;
    } else {
        g_codeOrder.push_back(key);
    }
    TrimToCap();
    SaveLocked();
}

bool IsUnauthorized(uint32_t depotId, uint64_t gid) {
    if (depotId == 0 || gid == 0) return false;
    std::lock_guard<std::mutex> lk(g_mutex);
    EnsureLoadedLocked();
    return g_unauthorized.count(Key(depotId, gid)) != 0;
}

void MarkUnauthorized(uint32_t depotId, uint64_t gid) {
    if (depotId == 0 || gid == 0) return;
    std::lock_guard<std::mutex> lk(g_mutex);
    EnsureLoadedLocked();
    uint64_t key = Key(depotId, gid);
    if (g_unauthorized.insert(key).second) {
        g_unauthOrder.push_back(key);
        // An unauthorized gid is by definition not present for us, so it can
        // never also be a definitive not_found; keep the two sets disjoint.
        g_notFound.erase(key);
        TrimToCap();
        SaveLocked();
        LOG_WARN("ManifestStateCache: depot={} gid={} marked unauthorized (persisted)",
                 depotId, gid);
    }
}

bool IsKnownNotFound(uint32_t depotId, uint64_t gid) {
    if (depotId == 0 || gid == 0) return false;
    std::lock_guard<std::mutex> lk(g_mutex);
    EnsureLoadedLocked();
    return g_notFound.count(Key(depotId, gid)) != 0;
}

void MarkNotFound(uint32_t depotId, uint64_t gid) {
    if (depotId == 0 || gid == 0) return;
    std::lock_guard<std::mutex> lk(g_mutex);
    EnsureLoadedLocked();
    uint64_t key = Key(depotId, gid);
    if (g_notFound.insert(key).second) {
        g_notFoundOrder.push_back(key);
        TrimToCap();
        SaveLocked();
        LOG_INFO("ManifestStateCache: depot={} gid={} remembered as definitively absent",
                 depotId, gid);
    }
}

int NoteUnservableAttempt(uint32_t depotId) {
    if (depotId == 0) return 0;
    std::lock_guard<std::mutex> lk(g_mutex);
    EnsureLoadedLocked();
    int& count = g_unservable[depotId];
    ++count;
    SaveLocked();
    LOG_WARN("ManifestStateCache: depot={} failed to yield a request code {} time(s){}",
             depotId, count, count >= kUnservableThreshold ? " - marking unservable" : "");
    return count;
}

bool IsUnservable(uint32_t depotId) {
    if (depotId == 0) return false;
    std::lock_guard<std::mutex> lk(g_mutex);
    EnsureLoadedLocked();
    auto it = g_unservable.find(depotId);
    return it != g_unservable.end() && it->second >= kUnservableThreshold;
}

void ClearUnservable(uint32_t depotId) {
    if (depotId == 0) return;
    std::lock_guard<std::mutex> lk(g_mutex);
    if (g_unservable.empty()) return;
    if (!g_loaded) return;   // nothing in memory to clear, skip the disk touch
    if (g_unservable.erase(depotId) > 0) SaveLocked();
}

void ClearAll() {
    std::lock_guard<std::mutex> lk(g_mutex);
    g_loaded = true;         // a following Get must not re-read the old file
    g_codes.clear();
    g_unauthorized.clear();
    g_notFound.clear();
    g_unservable.clear();
    g_codeOrder.clear();
    g_unauthOrder.clear();
    g_notFoundOrder.clear();
    std::error_code ec;
    std::string path = StorePath();
    if (!path.empty()) fs::remove(fs::path(path), ec);
    LOG_INFO("ManifestStateCache: state cleared (persisted store removed)");
}

std::string StorePathForLog() {
    return StorePath();
}

} // namespace ManifestStateCache
