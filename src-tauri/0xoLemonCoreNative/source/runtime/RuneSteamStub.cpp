#include "runtime/RuneSteamStub.h"
#include "runtime/Logger.h"
#include "runtime/SteamlessApply.h"

#include <windows.h>
#include <cstdint>
#include <filesystem>
#include <fstream>
#include <string>

namespace RuneSteamStub {
namespace {
    namespace fs = std::filesystem;

    fs::path ComponentRoot() {
        char module[MAX_PATH] = {};
        HMODULE self = GetModuleHandleA("0xoCore.dll");
        if (!self) self = GetModuleHandleA(nullptr);
        if (!self || !GetModuleFileNameA(self, module, MAX_PATH)) return {};
        const fs::path base(module);
        const fs::path candidates[] = {
            base.parent_path() / "rune_steamstub",
            base.parent_path() / "embedded" / "rune_steamstub",
            base.parent_path() / "gse-uc" / "embedded" / "rune_steamstub",
            fs::current_path() / "src-tauri" / "resources" / "gse-uc" / "embedded" / "rune_steamstub",
            fs::path("E:/007Launcher/src-tauri/resources/gse-uc/embedded/rune_steamstub"),
        };
        std::error_code ec;
        for (const auto& candidate : candidates) {
            if (fs::is_regular_file(candidate / "steamstub_x64.dll", ec)
                && fs::is_regular_file(candidate / "steamstub_x32.dll", ec))
                return candidate;
        }
        return {};
    }

    bool IsPe64(const fs::path& exe) {
        std::ifstream in(exe, std::ios::binary);
        if (!in) return false;
        std::uint8_t dos[64] = {};
        in.read(reinterpret_cast<char*>(dos), sizeof(dos));
        if (in.gcount() != sizeof(dos) || dos[0] != 'M' || dos[1] != 'Z') return false;
        const std::uint32_t pe = static_cast<std::uint32_t>(dos[0x3C])
            | (static_cast<std::uint32_t>(dos[0x3D]) << 8)
            | (static_cast<std::uint32_t>(dos[0x3E]) << 16)
            | (static_cast<std::uint32_t>(dos[0x3F]) << 24);
        in.seekg(pe + 4, std::ios::beg);
        std::uint16_t machine = 0;
        in.read(reinterpret_cast<char*>(&machine), sizeof(machine));
        return machine == IMAGE_FILE_MACHINE_AMD64 || machine == IMAGE_FILE_MACHINE_ARM64;
    }
}

bool Deploy(const fs::path& requestedExe) {
    std::error_code ec;
    if (!fs::is_regular_file(requestedExe, ec)) return false;

    // Steam can report a launcher/shim. Never drop the proxy beside that
    // file when another root executable is the actual SteamStub image.
    fs::path exePath = requestedExe;
    if (!SteamlessApply::DetectProtected(exePath)) {
        for (fs::directory_iterator it(requestedExe.parent_path(),
                                        fs::directory_options::skip_permission_denied, ec);
             !ec && it != fs::directory_iterator(); it.increment(ec)) {
            if (!it->is_regular_file(ec) || it->path().extension() != ".exe") continue;
            if (SteamlessApply::DetectProtected(it->path())) {
                exePath = it->path();
                break;
            }
        }
    }
    if (!SteamlessApply::DetectProtected(exePath)) {
        LOG_MISC_WARN("RuneSteamStub: no SteamStub-protected executable beside \"{}\"",
                      requestedExe.string());
        return false;
    }
    const fs::path root = ComponentRoot();
    if (root.empty()) {
        LOG_MISC_WARN("RuneSteamStub: component directory not found");
        return false;
    }

    const fs::path destination = exePath.parent_path() / "winmm.dll";
    const fs::path marker = exePath.parent_path() / ".0xo_rune_steamstub";
    const fs::path source = root / (IsPe64(exePath) ? "steamstub_x64.dll" : "steamstub_x32.dll");

    if (fs::exists(destination, ec)) {
        if (!fs::is_regular_file(marker, ec)) {
            LOG_MISC_WARN("RuneSteamStub: refusing unrelated winmm.dll beside \"{}\"", exePath.string());
            return false;
        }
        LOG_MISC_INFO("RuneSteamStub: existing managed proxy retained for \"{}\"", exePath.string());
        return true;
    }

    fs::copy_file(source, destination, fs::copy_options::none, ec);
    if (ec) {
        LOG_MISC_WARN("RuneSteamStub: copy failed source=\"{}\" destination=\"{}\" error={}",
                      source.string(), destination.string(), ec.message());
        return false;
    }
    std::ofstream out(marker, std::ios::binary | std::ios::trunc);
    out << "source=Mush-iii/rune-emu\narch=" << (IsPe64(exePath) ? "x64" : "x32") << "\n";
    out.close();
    if (!out) {
        fs::remove(destination, ec);
        return false;
    }
    LOG_MISC_INFO("RuneSteamStub: deployed {} -> winmm.dll beside \"{}\"",
                  source.filename().string(), exePath.string());
    return true;
}
} // namespace RuneSteamStub
