// _0xoLemonCore - Steam client hook layer for SteaMidra.
// Copyright (c) 2025-2026 Midrag (https://github.com/Midrags).
// Distributed under the GNU General Public License v3 or later.
// See <https://www.gnu.org/licenses/> for the full license text.

#include "ManifestFetch.h"
#include "HubcapManifestSync.h"
#include "ManifestStateCache.h"
#include "Logger.h"
#include "RuntimeHttp.h"
#include "config/Settings.h"
#include "config/LuaLoader.h"

#include <atomic>
#include <charconv>
#include <cctype>
#include <chrono>
#include <condition_variable>
#include <filesystem>
#include <future>
#include <map>
#include <memory>
#include <mutex>
#include <optional>
#include <set>
#include <string>
#include <string_view>
#include <thread>

#include "core/entry.h"

// I keep the URL substitution dirt simple, three placeholders only.
// The two providers users actually point this thing at (wudrm, steam.run)
// give us either a plain decimal string or a JSON blob with one digit-string
// field. Any sane mirror copies one of those two formats so the parser
// here can stay inline.

namespace {

    // Returns true when depotcache/{depotId}_{gid}.manifest already
    // exists on disk or is auto-healed from local vault/backups (0 network, 0 quota).
    bool DepotcacheHasManifest(uint32_t depotId, uint64_t gid) {
        if (HubcapManifestSync::IsManifestOnDisk(depotId, gid)) {
            return true;
        }
        return HubcapManifestSync::TryAutoHealFromVault(depotId, gid);
    }

    /* Legacy implementation retained only in history; removed from active code.
        if (depotId == 0 || gid == 0) return false;
        if (SteamInstallPath[0] == '\0') return false;
        namespace fs = std::filesystem;
        char fname[64];
        snprintf(fname, sizeof(fname), "%u_%llu.manifest",
                 static_cast<unsigned>(depotId),
                 static_cast<unsigned long long>(gid));
        fs::path p = fs::path(SteamInstallPath) / "depotcache" / fname;

        // 1. Check if Steam's depotcache already has a valid manifest
        if (HubcapManifestSync::IsValidManifestFile(p)) {
            return true;
        }

        // 2. If missing or invalid, auto-heal from Launcher Vault or backups in %APPDATA%
        if (HubcapManifestSync::TryAutoHealFromVault(depotId, gid)) {
            return true;
        }

        return false;
    }
    */

    // The request-code path and the blob path have very different budgets: a
    // provider GET is bounded by RuntimeHttp's own timeout, while a Hubcap
    // generate+download can legitimately take up to ~45s on a slow link. The
    // wait here must cover the LONGEST of those, otherwise the first install
    // attempt times out while the fetch is still running and Steam reports
    // "no manifest" even though the manifest lands a few seconds later. That
    // was the first-install failure users had to work around with a retry.
    //
    // Keep this above HubcapManifestSync's 45s HTTP budget plus a small margin.
    constexpr int kManifestResolveBudgetSec = 55;

    std::mutex g_lock;
    std::map<uint64_t, std::shared_future<std::optional<uint64_t>>> g_pending;

    // Jobs whose future was not ready inside the wait budget. Steam rebuilds an
    // app's depot dependency list several times during a single install, so a
    // later 151/147 pair for the same jobId (or a later Resolve) must be able to
    // pick the answer up instead of being told "terminal failure".
    //
    // Steam normally issues a fresh jobId per attempt, so these entries are
    // short-lived; the state is also capped below so a stream of timed-out
    // jobs can never grow it without bound.
    std::set<uint64_t> g_timedOut;
    constexpr size_t   kTimedOutMax = 256;

    // Trims g_pending/g_timedOut when Steam stops asking about old jobIds.
    // Called with g_lock held. Pending entries whose future has already
    // completed are safe to drop: nothing will ever read them again.
    void PruneLocked() {
        if (g_timedOut.size() > kTimedOutMax) {
            g_timedOut.erase(g_timedOut.begin());
        }
        for (auto it = g_pending.begin(); it != g_pending.end(); ) {
            if (it->second.wait_for(std::chrono::seconds(0)) == std::future_status::ready) {
                it = g_pending.erase(it);
            } else {
                ++it;
            }
        }
    }

    struct LookupKey {
        uint64_t gid = 0;
        uint32_t appId = 0;
        uint32_t depotId = 0;

        bool operator<(const LookupKey& other) const {
            if (gid != other.gid) return gid < other.gid;
            if (appId != other.appId) return appId < other.appId;
            return depotId < other.depotId;
        }
    };

    std::map<LookupKey, std::shared_future<std::optional<uint64_t>>> g_inflight;
    std::map<LookupKey, uint64_t> g_cache;

    // In-flight fetch thread accounting. Detached fetch threads outlive the
    // callers, so on DLL_PROCESS_DETACH we must wait for them to finish before
    // the anonymous-namespace globals above (g_lock, g_cache, g_inflight) are
    // destroyed — otherwise a fetch still inside RunOnce writes freed memory
    // and Steam crashes on exit. Shutdown() drains this to zero with a bound.
    std::atomic<int> g_activeFetches{0};
    std::condition_variable g_fetchDrained;
    bool g_shuttingDown = false;

    std::shared_future<std::optional<uint64_t>> ReadyFuture(std::optional<uint64_t> value) {
        std::promise<std::optional<uint64_t>> p;
        p.set_value(value);
        return p.get_future().share();
    }

    bool ParseDigitsOnly(std::string_view body, uint64_t* out) {
        if (body.empty()) return false;
        // skip CR/LF and stray spaces some endpoints add
        size_t b = 0, e = body.size();
        while (b < e && (body[b] == ' ' || body[b] == '\r' || body[b] == '\n' || body[b] == '\t')) ++b;
        while (e > b && (body[e-1] == ' ' || body[e-1] == '\r' || body[e-1] == '\n' || body[e-1] == '\t')) --e;
        if (b == e) return false;
        for (size_t i = b; i < e; ++i)
            if (body[i] < '0' || body[i] > '9') return false;
        uint64_t v = 0;
        auto [_, ec] = std::from_chars(body.data() + b, body.data() + e, v);
        if (ec != std::errc{}) return false;
        *out = v;
        return true;
    }

    // Pulls the first digit-string out of a "content":"...." or
    // "code":"..." or "manifest_request_code":"..." JSON field. Order
    // is "longest tag first" so a body that has both content and code
    // takes content. No real JSON parser needed; the responses we care
    // about are always tiny scalars.
    bool ParseJsonDigitField(std::string_view body, uint64_t* out) {
        static constexpr std::string_view kKeys[] = {
            "\"manifest_request_code\"", "\"content\"", "\"code\"",
        };
        for (auto key : kKeys) {
            size_t k = body.find(key);
            if (k == std::string_view::npos) continue;
            size_t q1 = body.find('"', k + key.size());
            if (q1 == std::string_view::npos) continue;
            size_t q2 = body.find('"', q1 + 1);
            if (q2 == std::string_view::npos) continue;
            if (ParseDigitsOnly(body.substr(q1 + 1, q2 - q1 - 1), out))
                return true;
        }
        return false;
    }

    // Substitute {gid}/{appid}/{depotid} into the configured template.
    // Anything else is left as is so a future {branch} placeholder won't
    // explode the existing config.
    std::string ExpandTemplate(std::string_view tmpl,
                               uint64_t gid, uint32_t appId, uint32_t depotId) {
        std::string out;
        out.reserve(tmpl.size() + 32);
        for (size_t i = 0; i < tmpl.size(); ) {
            if (tmpl[i] != '{') { out.push_back(tmpl[i++]); continue; }
            size_t end = tmpl.find('}', i + 1);
            if (end == std::string_view::npos) { out.push_back(tmpl[i++]); continue; }
            std::string_view tag = tmpl.substr(i + 1, end - i - 1);
            if (tag == "gid")          out += std::to_string(gid);
            else if (tag == "appid")   out += std::to_string(appId);
            else if (tag == "depotid") out += std::to_string(depotId);
            else { out.append(tmpl.substr(i, end - i + 1)); }
            i = end + 1;
        }
        return out;
    }

    bool EqualsIgnoreCase(std::string_view a, std::string_view b) {
        if (a.size() != b.size()) return false;
        for (size_t i = 0; i < a.size(); ++i) {
            unsigned char ac = static_cast<unsigned char>(a[i]);
            unsigned char bc = static_cast<unsigned char>(b[i]);
            if (std::tolower(ac) != std::tolower(bc)) return false;
        }
        return true;
    }

    std::string_view ExtractHost(std::string_view url) {
        size_t begin = 0;
        size_t scheme = url.find("://");
        if (scheme != std::string_view::npos) begin = scheme + 3;
        size_t end = url.find_first_of("/?#", begin);
        std::string_view host = end == std::string_view::npos
            ? url.substr(begin)
            : url.substr(begin, end - begin);
        size_t at = host.rfind('@');
        if (at != std::string_view::npos) host.remove_prefix(at + 1);
        size_t port = host.find(':');
        if (port != std::string_view::npos) host = host.substr(0, port);
        return host;
    }

    bool UsesProviderCompatAgent(std::string_view url) {
        return EqualsIgnoreCase(ExtractHost(url), "manifest.opensteamtool.com");
    }

    std::optional<uint64_t> RunOnce(uint64_t gid, uint32_t appId, uint32_t depotId) {
        // ── HubcapTools: persisted request-code cache ─────────────────────────
        // A code Hubcap already resolved for this exact depot+gid is valid for
        // the life of the build, so answer from disk before touching the
        // network. This is the store that survives a Steam restart; the old
        // behaviour only had the in-memory g_cache and re-asked every boot.
        if (auto persisted = ManifestStateCache::GetRequestCode(depotId, gid)) {
            LOG_MANIFESTCH_INFO("ManifestFetch: gid={} resolved code={} from persisted cache",
                                gid, *persisted);
            return persisted;
        }

        // ── HubcapTools: gid flagged unauthorized ─────────────────────────────
        // The provider already answered 401/403 for this exact depot+gid. The
        // key/ownership is what was wrong, so re-asking cannot succeed - skip
        // the lookup entirely and let Steam fail clean instead of burning a
        // request on every retry.
        if (ManifestStateCache::IsUnauthorized(depotId, gid)) {
            LOG_MANIFESTCH_WARN("ManifestFetch: gid={} depot={} flagged unauthorized, skipping lookup",
                                gid, depotId);
            return std::nullopt;
        }

        // ── HubcapTools: definitive not_found ─────────────────
        // Providers said this depot+gid does not exist (a real 404, not a
        // transport error). Remembering it stops the next install attempt from
        // spending another request on an answer we already have.
        if (ManifestStateCache::IsKnownNotFound(depotId, gid)) {
            LOG_MANIFESTCH_WARN("ManifestFetch: gid={} depot={} remembered as definitively absent",
                                gid, depotId);
            return std::nullopt;
        }

        // try the Lua fetch_manifest_code functions first since they
        // let the plugin serve codes without any network at all
        if (LuaLoader::HasManifestCodeFuncEx()) {
            uint64_t code = LuaLoader::CallManifestFetchCodeEx(appId, depotId, gid);
            if (code != 0) {
                LOG_MANIFESTCH_INFO("ManifestFetch: gid={} resolved via Lua fetch_manifest_code_ex code={}", gid, code);
                return code;
            }
            LOG_MANIFESTCH_DEBUG("ManifestFetch: gid={} fetch_manifest_code_ex returned 0, falling through", gid);
        } else if (LuaLoader::HasManifestCodeFunc()) {
            uint64_t code = LuaLoader::CallManifestFetchCode(gid);
            if (code != 0) {
                LOG_MANIFESTCH_INFO("ManifestFetch: gid={} resolved via Lua fetch_manifest_code code={}", gid, code);
                return code;
            }
            LOG_MANIFESTCH_DEBUG("ManifestFetch: gid={} fetch_manifest_code returned 0, falling through", gid);
        }

        // ── HubcapTools: depotcache-first ────────────────────────────────────────
        // If a .manifest file already exists locally (placed manually or cached
        // from a previous download), Steam can use it directly — no request code
        // needed. If absent, ensure single manifest is downloaded from Hubcap.
        // The file is NEVER deleted or moved by this code path.
        if (!DepotcacheHasManifest(depotId, gid)) {
            if (HubcapManifestSync::IsManifestFetchCoolingDown(depotId, gid)) {
                LOG_MANIFESTCH_WARN("ManifestFetch: app={} depot={} gid={} inside anti-spam window, failing fast",
                                    appId, depotId, gid);
                return std::nullopt;
            }
            HubcapManifestSync::EnsureManifest(depotId, gid);
        }
        if (DepotcacheHasManifest(depotId, gid)) {
            LOG_MANIFESTCH_INFO("ManifestFetch: app={} depot={} gid={} manifest is on disk; no API call",
                                appId, depotId, gid);
            // The blob is what Steam needs; no request code is required when the
            // manifest is already in depotcache. Record the vault archive so a
            // later session still short-circuits to disk (matches HubcapTools'
            // "already-cached games are served straight from disk").
            HubcapManifestSync::ArchiveManifestToVault(depotId, gid);
            return std::nullopt;
        }
        // ─────────────────────────────────────────────────────────────────────────

        const auto& chain = Settings::manifestFetchUrls;
        if (chain.empty()) {
            LOG_MANIFESTCH_DEBUG("ManifestFetch: gid={} skipped, no providers configured", gid);
            return std::nullopt;
        }

        // Fall through the chain in order. First provider that returns a
        // 200 with a parseable code wins. Network failures, non-200, or
        // unparseable bodies just demote that provider for this lookup
        // and let the next one try. The per-provider attempt is bounded
        // by RuntimeHttp's own kTimeoutMs, so a slow first host doesn't
        // strand the depot indefinitely.
        for (size_t i = 0; i < chain.size(); ++i) {
            const std::string& tmpl = chain[i];
            if (tmpl.empty()) continue;
            std::string url = ExpandTemplate(tmpl, gid, appId, depotId);
            LOG_MANIFESTCH_INFO("ManifestFetch: gid={} provider {}/{} GET {}",
                                gid, i + 1, chain.size(), url);

            RuntimeHttp::Response resp{};
            for (int attempt = 0; attempt < 2; ++attempt) {
                resp = UsesProviderCompatAgent(url)
                    ? RuntimeHttp::Get(url, {}, L"OpenSteamTool/1.0")
                    : RuntimeHttp::Get(url);
                if (!resp.networkError && resp.status == 429 && attempt == 0) {
                    LOG_MANIFESTCH_WARN("ManifestFetch: gid={} provider {} HTTP=429 "
                                        "body_bytes={}, retrying once",
                                        gid, i + 1, resp.body.size());
                    std::this_thread::sleep_for(std::chrono::milliseconds(750));
                    continue;
                }
                break;
            }
            if (resp.networkError) {
                LOG_MANIFESTCH_WARN("ManifestFetch: gid={} provider {} net err '{}', "
                                    "trying next", gid, i + 1, resp.diagnostic);
                continue;
            }
            if (resp.status == 401 || resp.status == 403) {
                // Definitive: the credential/ownership is wrong for this gid.
                // But if the response is an HTML block / Cloudflare challenge, treat as provider transport error,
                // NOT definitive app unauthorized so other providers can still fulfill the manifest!
                bool isHtmlWaf = resp.body.find("<html") != std::string::npos ||
                                 resp.body.find("<!DOCTYPE") != std::string::npos ||
                                 resp.body.find("cloudflare") != std::string::npos ||
                                 resp.body.find("Cloudflare") != std::string::npos;
                if (!isHtmlWaf) {
                    ManifestStateCache::MarkUnauthorized(depotId, gid);
                }
                LOG_MANIFESTCH_WARN("ManifestFetch: gid={} provider {} HTTP={} unauthorized (waf_detected={})",
                                    gid, i + 1, resp.status, isHtmlWaf);
                continue;
            }
            if (resp.status == 404) {
                // Definitive not_found, as opposed to a transport hiccup.
                ManifestStateCache::MarkNotFound(depotId, gid);
                LOG_MANIFESTCH_WARN("ManifestFetch: gid={} provider {} HTTP=404 definitive not_found",
                                    gid, i + 1);
                continue;
            }
            if (resp.status != 200) {
                LOG_MANIFESTCH_WARN("ManifestFetch: gid={} provider {} HTTP={} "
                                    "body_bytes={}, trying next",
                                    gid, i + 1, resp.status, resp.body.size());
                continue;
            }
            uint64_t code = 0;
            if (ParseDigitsOnly(resp.body, &code)
             || ParseJsonDigitField(resp.body, &code))
            {
                LOG_MANIFESTCH_INFO("ManifestFetch: gid={} resolved code={} via provider {}",
                                    gid, code, i + 1);
                // Persist so the next Steam boot answers this from disk.
                ManifestStateCache::PutRequestCode(depotId, gid, code);
                ManifestStateCache::ClearUnservable(depotId);
                return code;
            }
            LOG_MANIFESTCH_WARN("ManifestFetch: gid={} provider {} body unparseable "
                                "(first 64: '{}'), trying next",
                                gid, i + 1,
                                std::string_view(resp.body).substr(0, 64));
        }

        // ── HubcapTools: service down, check depotcache as last resort ────────────
        // All online providers failed. Check once more whether the manifest arrived
        // in depotcache in the meantime (race window) and, if so, archive it to the
        // launcher vault. Either way nothing is removed; if it is still absent we
        // return nullopt cleanly so Steam shows a real error instead of a hang.
        if (!DepotcacheHasManifest(depotId, gid)) {
            HubcapManifestSync::EnsureManifest(depotId, gid);
        }
        if (DepotcacheHasManifest(depotId, gid)) {
            HubcapManifestSync::ArchiveManifestToVault(depotId, gid);
            LOG_MANIFESTCH_WARN("ManifestFetch: app={} depot={} gid={} providers down; manifest is on disk",
                                appId, depotId, gid);
            return std::nullopt;
        }
        // ─────────────────────────────────────────────────────────────────────────

        // Everything failed. Count it against the depot: once a depot has
        // failed to yield a code kUnservableThreshold times, ManifestBind drops
        // it from Steam's dependency vector so Steam stops retrying forever.
        if (depotId != 0) {
            ManifestStateCache::NoteUnservableAttempt(depotId);
        }

        LOG_MANIFESTCH_WARN("ManifestFetch: gid={} all {} providers exhausted",
                            gid, chain.size());
        return std::nullopt;
    }
}

namespace ManifestFetch {

    void Submit(uint64_t jobId, uint64_t manifestGid,
                uint32_t appId, uint32_t depotId)
    {
        LookupKey key{manifestGid, appId, depotId};
        std::shared_future<std::optional<uint64_t>> fut;
        std::lock_guard<std::mutex> lock(g_lock);
        if (g_pending.count(jobId)) {
            LOG_MANIFESTCH_DEBUG("ManifestFetch: duplicate Submit for jobId={}", jobId);
            return;
        }
        PruneLocked();
        // A previous Resolve for this jobId ran out of budget while the fetch is
        // still in flight. Re-submitting would start a second, quota-burning
        // lookup for the same depot+gid; the async worker already owns it.
        if (g_timedOut.count(jobId)) {
            LOG_MANIFESTCH_INFO("ManifestFetch: jobId={} still pending from an earlier "
                                "pass, not resubmitting", jobId);
            return;
        }

        if (auto cached = g_cache.find(key); cached != g_cache.end()) {
            LOG_MANIFESTCH_INFO("ManifestFetch: jobId={} gid={} using cached code={}",
                                jobId, manifestGid, cached->second);
            g_pending.emplace(jobId, ReadyFuture(cached->second));
            return;
        }

        if (auto inflight = g_inflight.find(key); inflight != g_inflight.end()) {
            LOG_MANIFESTCH_INFO("ManifestFetch: jobId={} gid={} joined in-flight lookup",
                                jobId, manifestGid);
            g_pending.emplace(jobId, inflight->second);
            return;
        }

        auto promise = std::make_shared<std::promise<std::optional<uint64_t>>>();
        fut = promise->get_future().share();

        // Reject new fetches once shutdown began: a thread spawned after this
        // point could outlive the process teardown that Shutdown() is waiting on.
        if (g_shuttingDown) {
            promise->set_value(std::nullopt);
            return;
        }

        g_inflight.emplace(key, fut);
        g_pending.emplace(jobId, fut);

        g_activeFetches.fetch_add(1);
        std::thread([key, promise]() {
            std::optional<uint64_t> result = RunOnce(key.gid, key.appId, key.depotId);
            {
                std::lock_guard<std::mutex> lock(g_lock);
                if (result.has_value()) {
                    g_cache[key] = *result;
                }
                g_inflight.erase(key);
            }
            promise->set_value(result);
            if (g_activeFetches.fetch_sub(1) == 1) {
                // Last fetch done; wake Shutdown() if it is draining.
                std::lock_guard<std::mutex> lock(g_lock);
                g_fetchDrained.notify_all();
            }
        }).detach();
    }

    std::optional<uint64_t> Resolve(uint64_t jobId) {
        std::shared_future<std::optional<uint64_t>> fut;
        {
            std::lock_guard<std::mutex> lock(g_lock);
            auto it = g_pending.find(jobId);
            if (it == g_pending.end()) return std::nullopt;
            fut = it->second;
            // Deliberately kept in g_pending: if this Resolve has to give up on
            // the timeout the entry stays resolvable, so the next 147 for the
            // same jobId answers from the fetch that is already running. Only a
            // completed future is consumed here.
        }

        // Wait for the real fetch, not a shorter placeholder. The configured
        // value is a floor, not a cap: a Hubcap single-manifest generate can
        // take up to 45s and cutting it short is exactly what forced the
        // user-visible "failed, press retry" loop.
        int budget = Settings::manifestFetchTimeoutSec > 0
                   ? Settings::manifestFetchTimeoutSec : 12;
        if (budget < kManifestResolveBudgetSec) budget = kManifestResolveBudgetSec;

        if (fut.wait_for(std::chrono::seconds(budget)) != std::future_status::ready) {
            LOG_MANIFESTCH_WARN("ManifestFetch: jobId={} not ready after {}s; "
                                "keeping the job pending so a later dependency pass can use it",
                                jobId, budget);
            std::lock_guard<std::mutex> lock(g_lock);
            g_timedOut.insert(jobId);
            return std::nullopt;
        }

        auto result = fut.get();
        {
            std::lock_guard<std::mutex> lock(g_lock);
            g_pending.erase(jobId);
            g_timedOut.erase(jobId);
        }
        return result;
    }

    // Stops accepting new fetches and waits (bounded) for the in-flight ones to
    // finish. Called from DLL_PROCESS_DETACH after the async worker stops, so no
    // new Submit can arrive behind it. Safe to call before any fetch started.
    void Shutdown() {
        {
            std::lock_guard<std::mutex> lock(g_lock);
            g_shuttingDown = true;
        }
        // Bound the wait: a fetch stuck on a slow endpoint must not hang the
        // detach forever. 6s comfortably covers the 5s HTTP timeout in RunOnce.
        std::unique_lock<std::mutex> lock(g_lock);
        g_fetchDrained.wait_for(lock, std::chrono::seconds(6),
                                [] { return g_activeFetches.load() == 0; });
    }

    void Discard(uint64_t jobId) {
        std::lock_guard<std::mutex> lock(g_lock);
        g_pending.erase(jobId);
        g_timedOut.erase(jobId);
    }

    void ClearCache() {
        std::lock_guard<std::mutex> lock(g_lock);
        g_cache.clear();
        g_timedOut.clear();
        // Lua hot-reload may pin a different build, so codes/unauthorized/
        // not_found keyed on the old gids no longer describe the live config.
        ManifestStateCache::ClearAll();
    }
}
