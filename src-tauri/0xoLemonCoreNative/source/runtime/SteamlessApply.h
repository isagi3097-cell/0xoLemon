// _0xoLemonCore - Steam client hook layer for SteaMidra.
// Copyright (c) 2025-2026 Midrag (https://github.com/Midrags).
// Distributed under the GNU General Public License v3 or later.
// See <https://www.gnu.org/licenses/> for the full license text.
//
// SteamlessApply — native (C++) port of the SteamStub DRM remover that the
// launcher already ships as a Rust module (src-tauri/src/steamless.rs).
//
// Porting it here lets 0xoCore.dll strip SteamStub from a game executable
// *on disk* without spawning the .NET Steamless.CLI.exe, so there is no
// runtime dependency on the .NET framework. The byte layout, variant
// detection patterns, SteamXOR walk and AES-256-CBC code-section decrypt are
// kept byte-identical to the Rust implementation so a file fixed by either
// path produces the same output.
//
// Supported today: SteamStub Variant 3.0/3.1 x64 (the modern majority).
// x86 is detected but deliberately refused, matching the Rust module.
#pragma once

#include <filesystem>
#include <string>

namespace SteamlessApply
{

    // Absolute path to Steamless.CLI.exe. Set once at core bootstrap from the
    // launcher's embedded component directory
    // (<launcher>/src-tauri/resources/gse-uc/embedded/steamless). When empty,
    // Unpack()/Restore() report a clear "component missing" error instead of
    // silently doing nothing.
    void SetComponentDir(const std::string& steamlessDirUtf8);
    const std::string& ComponentDir();

    // Result mirrored after the Rust SteamlessResult so the launcher and the
    // native side can report the same shape to the user.
    struct Result {
        bool        success = false;
        std::string message;
        std::string outputPath;
        std::string variant;   // "3.1 x64", "3.0 x64", ...
        unsigned    appId = 0;
    };

    // True when the PE at `exePath` looks SteamStub-protected (has an
    // executable .bind section carrying the v3.x stub signature). Pure read,
    // never mutates the file. Used to decide whether a download needs fixing.
    bool IsProtected(const std::filesystem::path& exePath);

    // Same detection, but without the 96 MiB size ceiling that IsProtected
    // inherits from ProtectionProbe's scan helpers. Modern AAA executables
    // (e.g. re4.exe, ~233 MB) exceed that ceiling, so IsProtected() reports
    // "not protected" for exactly the games that need the fix the most.
    // DetectProtected reads only the MZ/PE headers plus the section table, so
    // its cost is constant regardless of file size. Pure read.
    bool DetectProtected(const std::filesystem::path& exePath);

    // Same streaming detection over a whole directory: returns the first
    // SteamStub-protected .exe found, skipping the "<name>.bak" backups.
    // Pure read. Used as the last-resort fallback when the exact launch path
    // could not be resolved or does not carry the stub itself.
    bool DetectProtectedInDirectory(const std::filesystem::path& dir,
                                    std::filesystem::path& outExe);

    // Unpack `exePath` in place: the original is backed up as
    // "<filename><backupSuffix>" and the patched image is written over the
    // original path. `backupSuffix` defaults to ".bak" when empty, so
    // re4.exe is preserved as re4.exe.bak.
    // Blocking (reads/writes the whole file) — never call from a Steam UI thread.
    Result Unpack(const std::filesystem::path& exePath,
                  const std::string& backupSuffix = ".bak");

    // True when a "<filename><backupSuffix>" file already sits next to the exe
    // AND the live exe no longer carries the stub — i.e. it really was fixed.
    bool IsPatched(const std::filesystem::path& exePath,
                   const std::string& backupSuffix = ".bak");

    // Restore the original from the backup and drop the patched image.
    // Blocking. Returns a user-facing status string on success, or an error.
    std::string Restore(const std::filesystem::path& exePath,
                        const std::string& backupSuffix = ".bak");

} // namespace SteamlessApply
