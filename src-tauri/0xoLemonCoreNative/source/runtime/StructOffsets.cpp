// _0xoLemonCore - Steam client hook layer for SteaMidra.
// Copyright (c) 2025-2026 Midrag (https://github.com/Midrags).
// Distributed under the GNU General Public License v3 or later.
// See <https://www.gnu.org/licenses/> for the full license text.

#include "runtime/StructOffsets.h"

#include "core/entry.h"
#include "runtime/HookStatus.h"
#include "runtime/Logger.h"

#include <windows.h>

#include <toml++/toml.hpp>

#include <atomic>
#include <cstddef>
#include <filesystem>
#include <mutex>

namespace StructOffsets {

    namespace {
        std::once_flag g_once;
        std::atomic<size_t> g_controllerInTopManager{kDefaultControllerInTopManager};
        std::atomic<size_t> g_cSteamAppOwnedFlagOffset{kDefaultCSteamAppOwnedFlagOffset};
        std::atomic<size_t> g_remoteStorageAppIdOffset{kDefaultRemoteStorageAppIdOffset};
        std::atomic<bool>   g_configApplied{false};

        // Source label published to diagnostics. Writes happen only inside
        // ResolveAtStartup (single-flight) so a relaxed string store is enough;
        // readers see either the default or the final value.
        const char* g_source = "default";

        // Reads the [struct_offsets] table from _0xolemoncore.toml. Each key is
        // optional; an absent key keeps the built-in default. Values may be
        // decimal or (via toml++) integer literals; the controller offset is
        // commonly written as 0xAB8, which toml++ accepts as an int.
        void ApplyConfigOverrides() {
            if (ConfigPath[0] == '\0') return;
            std::error_code ec;
            if (!std::filesystem::exists(ConfigPath, ec)) return;

            toml::table tbl;
            try {
                tbl = toml::parse_file(ConfigPath);
            } catch (...) {
                // Settings::Load already logs a parse failure; a missing offset
                // table is not worth a second error line. Keep defaults.
                return;
            }

            auto offsetsTbl = tbl["struct_offsets"].as_table();
            if (!offsetsTbl) return;

            bool any = false;
            if (auto v = (*offsetsTbl)["controller_in_top_manager"].value<int64_t>()) {
                if (*v > 0) { g_controllerInTopManager.store(static_cast<size_t>(*v)); any = true; }
            }
            if (auto v = (*offsetsTbl)["csteam_app_owned_flag"].value<int64_t>()) {
                if (*v > 0) { g_cSteamAppOwnedFlagOffset.store(static_cast<size_t>(*v)); any = true; }
            }
            if (auto v = (*offsetsTbl)["remote_storage_app_id"].value<int64_t>()) {
                if (*v > 0) { g_remoteStorageAppIdOffset.store(static_cast<size_t>(*v)); any = true; }
            }

            if (any) {
                g_configApplied.store(true);
                g_source = "config";
            }
        }

        // Structural validation of the controller offset against the live
        // steamui module. The controller pointer lives inside the object
        // returned by GetTopManager(); we accept the configured value only when
        // the slot there actually resolves to a readable pointer. This is a
        // best-effort anchor: on failure we keep the configured/default value
        // and log, rather than guessing. Resolve is done elsewhere (SteamUI);
        // here we only re-read the pointer under SEH so a wrong offset cannot
        // take the core down.

        // POD-only probe result codes. Kept as plain enum ints so the
        // __try/__except body touches no C++ object with a destructor (MSVC
        // C2712 otherwise rejects __try in a function needing object unwinding).
        enum class ProbeCode : int {
            SelfModuleUnavailable = 0,
            AnchorUnavailable,
            ProbeFault,
            TopManagerNull,
            ControllerNull,
            ReadFault,
            Ok,
        };

        const char* ProbeCodeName(ProbeCode code) {
            switch (code) {
                case ProbeCode::SelfModuleUnavailable: return "self-module-unavailable";
                case ProbeCode::AnchorUnavailable:     return "anchor-unavailable";
                case ProbeCode::ProbeFault:            return "probe-fault";
                case ProbeCode::TopManagerNull:        return "top-manager-null";
                case ProbeCode::ControllerNull:        return "controller-null";
                case ProbeCode::ReadFault:             return "read-fault";
                case ProbeCode::Ok:                    return "ok";
            }
            return "unknown";
        }

        // The only function containing __try/__except. Reads the controller slot
        // out of the live top-manager object. POD-only so it stays SEH-clean.
        ProbeCode ProbeControllerSeh(size_t offset, void* (*probe)()) {
            void* topMgr = nullptr;
            __try {
                topMgr = probe();
            } __except (EXCEPTION_EXECUTE_HANDLER) {
                return ProbeCode::ProbeFault;
            }
            if (!topMgr) return ProbeCode::TopManagerNull;

            __try {
                void* controller = *reinterpret_cast<void**>(
                    static_cast<uint8_t*>(topMgr) + offset);
                if (!controller) return ProbeCode::ControllerNull;
            } __except (EXCEPTION_EXECUTE_HANDLER) {
                return ProbeCode::ReadFault;
            }
            return ProbeCode::Ok;
        }

        bool ValidateControllerOffset(size_t offset, std::string& reason) {
            // The live anchor requires the GetTopManager getter, which SteamUI
            // owns. We reach it through the exported probe so this module stays
            // free of a link-time dependency on the hook layer. On any failure
            // the validation is skipped (treated as inconclusive, not fatal).
            using ProbeTopManager_t = void* (*)();
            HMODULE self = nullptr;
            if (!GetModuleHandleExA(
                    GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS |
                    GET_MODULE_HANDLE_EX_FLAG_UNCHANGED_REFCOUNT,
                    reinterpret_cast<LPCSTR>(&ValidateControllerOffset), &self)) {
                reason = "self-module-unavailable";
                return false;
            }

            // Probe export is provided by the hook layer when it has resolved
            // GetTopManager. Absent => inconclusive, keep the value.
            auto probe = reinterpret_cast<ProbeTopManager_t>(
                GetProcAddress(self, "OxoProbeGetTopManager"));
            if (!probe) {
                reason = "anchor-unavailable";
                return false;
            }

            const ProbeCode code = ProbeControllerSeh(offset, probe);
            reason = ProbeCodeName(code);
            return code == ProbeCode::Ok;
        }
    }  // namespace

    void ResolveAtStartup() {
        std::call_once(g_once, [] {
            ApplyConfigOverrides();

            std::string reason;
            const size_t controller = g_controllerInTopManager.load();
            if (ValidateControllerOffset(controller, reason)) {
                g_source = g_configApplied.load() ? "config+validated" : "default+validated";
            } else {
                // Inconclusive or failed: keep the value, but make the reason
                // visible so a mis-anchored build is easy to spot in the log.
                LOG_COREIN_WARN(
                    "\"stage\" \"StructOffsets\" \"act\" \"controller-unvalidated\" "
                    "\"value\" \"0x{:X}\" \"reason\" \"{}\" \"source\" \"{}\"",
                    static_cast<unsigned long>(controller), reason, g_source);
            }

            HookStatus::SetStructOffsetState(
                g_controllerInTopManager.load(),
                g_cSteamAppOwnedFlagOffset.load(),
                g_remoteStorageAppIdOffset.load(),
                g_source, reason);

            LOG_COREIN_INFO(
                "\"stage\" \"StructOffsets\" \"act\" \"resolved\" "
                "\"controller\" \"0x{:X}\" \"ownedFlag\" {} \"remoteStorage\" \"0x{:X}\" "
                "\"source\" \"{}\"",
                static_cast<unsigned long>(g_controllerInTopManager.load()),
                static_cast<unsigned long>(g_cSteamAppOwnedFlagOffset.load()),
                static_cast<unsigned long>(g_remoteStorageAppIdOffset.load()),
                g_source);
        });
    }

    size_t ControllerInTopManager()    { return g_controllerInTopManager.load(); }
    size_t CSteamAppOwnedFlagOffset()  { return g_cSteamAppOwnedFlagOffset.load(); }
    size_t RemoteStorageAppIdOffset()  { return g_remoteStorageAppIdOffset.load(); }

    const char* ResolutionSource() { return g_source; }

    void Reset() {
        // Values intentionally persist across Reset: once resolved they are
        // valid for the process lifetime, and a late hook firing after Detach
        // must still read the resolved offset rather than a stale default.
        // The single-flight guard is left untouched (std::once_flag is not
        // resettable) so ResolveAtStartup stays idempotent for the process.
    }

}  // namespace StructOffsets
