#pragma once

#include <algorithm>
#include <cctype>
#include <cstdint>
#include <filesystem>
#include <optional>
#include <string>
#include <string_view>
#include <vector>
#include <cwctype>

namespace InjectionPolicy {

    enum class Architecture { Unknown, X86, X64 };

    struct Rule {
        std::string name;
        std::string libraryX86;
        std::string libraryX64;
        std::vector<std::string> allowProcesses;
        std::vector<std::string> denyProcesses;
        std::vector<uint32_t> appIds;
        int priority = 0;
        std::size_t declarationOrder = 0;
    };

    inline std::string NormalizeProcessName(std::string_view input) {
        while (!input.empty() && (input.front() == '"' || input.front() == '\'')) input.remove_prefix(1);
        while (!input.empty() && (input.back() == '"' || input.back() == '\'')) input.remove_suffix(1);
        const auto slash = input.find_last_of("\\/");
        if (slash != std::string_view::npos) input.remove_prefix(slash + 1);
        std::string out(input);
        std::transform(out.begin(), out.end(), out.begin(), [](unsigned char ch) {
            return static_cast<char>(std::tolower(ch));
        });
        return out;
    }

    inline bool IsSafeProcessPattern(std::string_view value) {
        const std::string normalized = NormalizeProcessName(value);
        return !normalized.empty() && normalized.size() <= 260 &&
               normalized.find_first_of("*?[]") == std::string::npos &&
               normalized.find('/') == std::string::npos && normalized.find('\\') == std::string::npos;
    }

    inline bool ContainsProcess(const std::vector<std::string>& values, std::string_view image) {
        const std::string normalized = NormalizeProcessName(image);
        for (const auto& value : values) {
            if (IsSafeProcessPattern(value) && NormalizeProcessName(value) == normalized) return true;
        }
        return false;
    }

    inline bool Matches(const Rule& rule, std::string_view image, uint32_t appId) {
        if (ContainsProcess(rule.denyProcesses, image)) return false;
        const bool constrained = !rule.allowProcesses.empty() || !rule.appIds.empty();
        if (!constrained) return false; // conditional rules are deny-by-default
        const bool processAllowed = !rule.allowProcesses.empty() && ContainsProcess(rule.allowProcesses, image);
        const bool appAllowed = !rule.appIds.empty() &&
            std::find(rule.appIds.begin(), rule.appIds.end(), appId) != rule.appIds.end();
        return processAllowed || appAllowed;
    }

    inline const std::string& LibraryFor(const Rule& rule, Architecture architecture) {
        static const std::string empty;
        if (architecture == Architecture::X86) return rule.libraryX86;
        if (architecture == Architecture::X64) return rule.libraryX64;
        return empty;
    }

    inline std::vector<const Rule*> OrderedMatches(const std::vector<Rule>& rules,
                                                   std::string_view image,
                                                   uint32_t appId) {
        std::vector<const Rule*> matches;
        for (const auto& rule : rules) if (Matches(rule, image, appId)) matches.push_back(&rule);
        std::stable_sort(matches.begin(), matches.end(), [](const Rule* lhs, const Rule* rhs) {
            if (lhs->priority != rhs->priority) return lhs->priority > rhs->priority;
            return lhs->declarationOrder < rhs->declarationOrder;
        });
        return matches;
    }

    inline std::optional<std::filesystem::path> CanonicalDllPath(const std::filesystem::path& configured,
                                                                 const std::filesystem::path& base) {
        if (configured.empty() || configured.native().size() > 32767) return std::nullopt;
        const auto text = configured.native();
        if (text.rfind(L"\\\\?\\", 0) == 0 || text.rfind(L"\\\\.\\", 0) == 0 ||
            text.rfind(L"\\\\", 0) == 0) return std::nullopt;
        std::error_code ec;
        auto candidate = configured.is_absolute() ? configured : base / configured;
        candidate = std::filesystem::weakly_canonical(candidate, ec);
        if (ec || !std::filesystem::is_regular_file(candidate, ec) || ec) return std::nullopt;
        std::wstring ext = candidate.extension().wstring();
        std::transform(ext.begin(), ext.end(), ext.begin(), [](wchar_t ch) { return std::towlower(ch); });
        if (ext != L".dll") return std::nullopt;
        return candidate;
    }

} // namespace InjectionPolicy
