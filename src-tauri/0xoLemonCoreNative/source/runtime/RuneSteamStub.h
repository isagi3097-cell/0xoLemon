// _0xoLemonCore - optional RUNE SteamStub proxy fallback.
#pragma once
#include <filesystem>

namespace RuneSteamStub {
    // Deploy the architecture-matched RUNE proxy as winmm.dll beside the game
    // executable. Returns true only when the proxy is already ours or was
    // deployed successfully. Never overwrites an unrelated winmm.dll.
    bool Deploy(const std::filesystem::path& exePath);
}
