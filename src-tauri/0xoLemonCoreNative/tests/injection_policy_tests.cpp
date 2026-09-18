#include "runtime/InjectionPolicy.h"

#include <cassert>
#include <filesystem>
#include <fstream>

int main() {
    using namespace InjectionPolicy;

    assert(NormalizeProcessName("C:\\Games\\GAME.EXE") == "game.exe");
    assert(IsSafeProcessPattern("game.exe"));
    assert(!IsSafeProcessPattern("*.exe"));

    Rule denied;
    denied.allowProcesses = {"game.exe"};
    denied.denyProcesses = {"GAME.EXE"};
    assert(!Matches(denied, "game.exe", 10));

    Rule unconstrained;
    assert(!Matches(unconstrained, "anything.exe", 10));

    Rule low;
    low.name = "low";
    low.appIds = {42};
    low.priority = 1;
    low.declarationOrder = 0;
    Rule high = low;
    high.name = "high";
    high.priority = 2;
    high.declarationOrder = 1;
    auto ordered = OrderedMatches({low, high}, "game.exe", 42);
    assert(ordered.size() == 2 && ordered[0]->name == "high" && ordered[1]->name == "low");

    const auto root = std::filesystem::temp_directory_path() / "oxo_injection_policy_test";
    std::filesystem::remove_all(root);
    std::filesystem::create_directories(root / "helpers");
    std::ofstream(root / "helpers" / "safe.dll") << "test";
    std::ofstream(root / "helpers" / "not-dll.txt") << "test";
    auto safe = CanonicalDllPath("helpers/safe.dll", root);
    assert(safe && safe->is_absolute());
    assert(!CanonicalDllPath("helpers/not-dll.txt", root));
    assert(!CanonicalDllPath(R"(\\server\share\unsafe.dll)", root));
    assert(!CanonicalDllPath("helpers/missing.dll", root));
    std::filesystem::remove_all(root);
    return 0;
}
