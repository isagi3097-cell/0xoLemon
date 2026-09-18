// _0xoLemonCore - Steam client hook layer for SteaMidra.
// Copyright (c) 2025-2026 Midrag (https://github.com/Midrags).
// Distributed under the GNU General Public License v3 or later.
// See <https://www.gnu.org/licenses/> for the full license text.

#pragma once

// Runtime struct-offset resolver.
//
// Historically the client-object field offsets the ticket / library / remote-
// storage paths relied on were compiled-in constants. When Valve shuffled the
// live Steam structs (e.g. the publicbeta client) every one of them had to be
// re-anchored by hand. This module resolves them ONCE at startup from data the
// core already ships (the signed pattern repo / _0xolemoncore.toml) and, where a
// live anchor exists, structurally validates the value against the running
// binary before use. Any value that cannot be confirmed falls back to the
// built-in default so an unknown build stays a safe pass-through instead of
// patching a random address.
//
// Consumers read the offsets through the getters below (never a constexpr), so a
// future Valve shift is absorbed by publishing a new offset value — no code
// change, no re-anchor.
//
// Offsets managed here:
//   ControllerInTopManager        steamui CSteamUIAppController* inside the top
//                                 manager object returned by GetTopManager().
//   CSteamAppOwnedFlagOffset      owned-flag dword inside a host-side CSteamApp.
//   RemoteStorageAppIdOffset      AppId dword inside the IClientRemoteStorage
//                                 object (`pThis + this`) used by the online-fix
//                                 route swap.

#include <cstddef>
#include <cstdint>
#include <string>

namespace StructOffsets
{

    // Built-in defaults. Kept in sync with the historical constants so a build
    // that resolves nothing still behaves exactly as before this module landed.
    constexpr size_t kDefaultControllerInTopManager = 0xAB8;
    constexpr size_t kDefaultCSteamAppOwnedFlagOffset = 28;
    constexpr size_t kDefaultRemoteStorageAppIdOffset = 0x38;

    // Loads any per-offset overrides from _0xolemoncore.toml, then (optionally)
    // structurally validates the controller offset against the live steamui
    // module. Safe to call more than once; only the first call does work.
    // Never throws. Records its result in status.json via HookStatus.
    void ResolveAtStartup();

    // Resolved values. Before ResolveAtStartup these return the defaults.
    size_t ControllerInTopManager();
    size_t CSteamAppOwnedFlagOffset();
    size_t RemoteStorageAppIdOffset();

    // "default" | "config" | "config+validated" — the source the active value
    // came from. Surfaced in diagnostics so a degraded offset set is visible.
    const char *ResolutionSource();

    // Drops resolved state. Called from _0xoLemonCore::Detach.
    void Reset();

} // namespace StructOffsets
