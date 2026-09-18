// _0xoLemonCore - Steam client hook layer for SteaMidra.
// Copyright (c) 2025-2026 Midrag (https://github.com/Midrags).
// Distributed under the GNU General Public License v3 or later.
// See <https://www.gnu.org/licenses/> for the full license text.
//
// Native (C++) port of Steamless (https://github.com/atom0s/Steamless),
// faithful to the Rust module in src-tauri/src/steamless.rs. See the header
// for why this exists (no .NET dependency at runtime).
//
// AES-256-CBC is provided by Windows CNG (bcrypt.lib, already linked).

#include "runtime/SteamlessApply.h"
#include "runtime/Logger.h"

#include <windows.h>
#include <bcrypt.h>

#include <algorithm>
#include <array>
#include <cstdint>
#include <cstring>
#include <fstream>
#include <optional>
#include <string>
#include <vector>

#pragma comment(lib, "bcrypt.lib")

namespace SteamlessApply {
namespace {

    // Steamless.CLI.exe resolved by SetComponentDir() during core bootstrap.
    // Empty until then; Unpack() reports a clear component-missing error rather
    // than silently doing nothing.
    std::filesystem::path g_cliPath;

    constexpr std::size_t kSectionHeaderSize = 40;
    constexpr std::size_t kStub31Size = 0xF0;      // Variant 3.1 x64 header
    constexpr std::array<std::uint32_t, 2> kStub30Sizes = {0xB0, 0xD0};
    constexpr std::uint32_t kStubSignature = 0xC0DEC0DFu;

    // ── Little-endian readers/writers (bounds-safe) ──────────────────────
    std::uint16_t ReadU16(const std::uint8_t* d, std::size_t n, std::size_t off) {
        if (off + 2 > n) return 0;
        return static_cast<std::uint16_t>(d[off] | (d[off + 1] << 8));
    }
    std::uint32_t ReadU32(const std::uint8_t* d, std::size_t n, std::size_t off) {
        if (off + 4 > n) return 0;
        return static_cast<std::uint32_t>(d[off]) |
               (static_cast<std::uint32_t>(d[off + 1]) << 8) |
               (static_cast<std::uint32_t>(d[off + 2]) << 16) |
               (static_cast<std::uint32_t>(d[off + 3]) << 24);
    }
    std::uint64_t ReadU64(const std::uint8_t* d, std::size_t n, std::size_t off) {
        if (off + 8 > n) return 0;
        std::uint64_t lo = ReadU32(d, n, off);
        std::uint64_t hi = ReadU32(d, n, off + 4);
        return lo | (hi << 32);
    }
    void WriteU16(std::vector<std::uint8_t>& d, std::size_t off, std::uint16_t v) {
        if (off + 2 > d.size()) return;
        d[off] = static_cast<std::uint8_t>(v & 0xFF);
        d[off + 1] = static_cast<std::uint8_t>((v >> 8) & 0xFF);
    }
    void WriteU32(std::vector<std::uint8_t>& d, std::size_t off, std::uint32_t v) {
        if (off + 4 > d.size()) return;
        d[off] = static_cast<std::uint8_t>(v & 0xFF);
        d[off + 1] = static_cast<std::uint8_t>((v >> 8) & 0xFF);
        d[off + 2] = static_cast<std::uint8_t>((v >> 16) & 0xFF);
        d[off + 3] = static_cast<std::uint8_t>((v >> 24) & 0xFF);
    }

    // ── Byte pattern search with "??" wildcards ──────────────────────────
    // pattern is a hex string like "E8 00 00 00 00 50 ...". Tokens are split
    // on spaces; "??" means any byte. Mirrors find_pattern() in steamless.rs.
    std::optional<std::size_t> FindPattern(const std::uint8_t* hay, std::size_t n,
                                           const char* pattern) {
        struct Token { bool wild; std::uint8_t value; };
        std::vector<Token> tokens;
        const char* p = pattern;
        while (*p) {
            while (*p == ' ') ++p;
            if (!*p) break;
            if (p[0] == '?' && p[1] == '?') {
                tokens.push_back({true, 0});
                p += 2;
            } else {
                auto hexVal = [](char c) -> int {
                    if (c >= '0' && c <= '9') return c - '0';
                    if (c >= 'a' && c <= 'f') return c - 'a' + 10;
                    if (c >= 'A' && c <= 'F') return c - 'A' + 10;
                    return -1;
                };
                int hi = hexVal(p[0]);
                int lo = (p[1] && p[1] != ' ') ? hexVal(p[1]) : -1;
                if (hi < 0) break;
                std::uint8_t b = static_cast<std::uint8_t>(hi << 4);
                if (lo >= 0) { b |= static_cast<std::uint8_t>(lo); p += 2; }
                else { p += 1; }
                tokens.push_back({false, b});
            }
        }
        if (tokens.empty() || n < tokens.size()) return std::nullopt;

        for (std::size_t i = 0; i + tokens.size() <= n; ++i) {
            bool match = true;
            for (std::size_t j = 0; j < tokens.size(); ++j) {
                if (!tokens[j].wild && hay[i + j] != tokens[j].value) {
                    match = false;
                    break;
                }
            }
            if (match) return i;
        }
        return std::nullopt;
    }

    // ── PE structures ────────────────────
    struct PeHeaders {
        bool          is64 = false;
        std::size_t   peOffset = 0;
        std::size_t   optOffset = 0;
        std::size_t   sectionsOffset = 0;
        std::uint16_t numSections = 0;
        std::uint32_t entryPointRva = 0;
        std::uint64_t imageBase = 0;
        std::uint32_t tlsDataDirRva = 0;
        std::uint32_t tlsDataDirSize = 0;
    };

    struct Section {
        char          name[9] = {0};
        std::uint32_t virtualSize = 0;
        std::uint32_t virtualAddress = 0;
        std::uint32_t sizeOfRawData = 0;
        std::uint32_t pointerToRawData = 0;
    };

    std::optional<PeHeaders> ParsePe(const std::vector<std::uint8_t>& d) {
        const std::uint8_t* p = d.data();
        const std::size_t   n = d.size();
        if (n < 0x40) return std::nullopt;
        if (p[0] != 'M' || p[1] != 'Z') return std::nullopt;

        std::size_t peOffset = ReadU32(p, n, 0x3C);
        if (peOffset + 4 > n) return std::nullopt;
        if (!(p[peOffset] == 'P' && p[peOffset + 1] == 'E' &&
              p[peOffset + 2] == 0 && p[peOffset + 3] == 0))
            return std::nullopt;

        std::size_t fileHeader = peOffset + 4;
        PeHeaders h;
        h.peOffset = peOffset;
        h.numSections = ReadU16(p, n, fileHeader + 2);
        std::size_t sizeOfOptional = ReadU16(p, n, fileHeader + 16);
        h.optOffset = fileHeader + 20;
        if (h.optOffset + 2 > n) return std::nullopt;

        std::uint16_t magic = ReadU16(p, n, h.optOffset);
        h.is64 = (magic == 0x20B);
        h.entryPointRva = ReadU32(p, n, h.optOffset + 16);
        h.imageBase = h.is64 ? ReadU64(p, n, h.optOffset + 24)
                             : static_cast<std::uint64_t>(ReadU32(p, n, h.optOffset + 28));

        std::size_t dataDirBase = h.is64 ? h.optOffset + 112 : h.optOffset + 96;
        std::size_t tlsDirOffset = dataDirBase + 9 * 8;
        if (tlsDirOffset + 8 <= n) {
            h.tlsDataDirRva = ReadU32(p, n, tlsDirOffset);
            h.tlsDataDirSize = ReadU32(p, n, tlsDirOffset + 4);
        }
        h.sectionsOffset = h.optOffset + sizeOfOptional;
        return h;
    }

    std::vector<Section> ReadSections(const std::vector<std::uint8_t>& d, const PeHeaders& h) {
        std::vector<Section> out;
        const std::uint8_t* p = d.data();
        const std::size_t   n = d.size();
        for (std::uint16_t i = 0; i < h.numSections; ++i) {
            std::size_t off = h.sectionsOffset + i * kSectionHeaderSize;
            if (off + kSectionHeaderSize > n) break;
            Section s;
            std::memcpy(s.name, p + off, 8);
            s.name[8] = '\0';
            s.virtualSize = ReadU32(p, n, off + 8);
            s.virtualAddress = ReadU32(p, n, off + 12);
            s.sizeOfRawData = ReadU32(p, n, off + 16);
            s.pointerToRawData = ReadU32(p, n, off + 20);
            out.push_back(s);
        }
        return out;
    }

    bool SectionIs(const Section& s, const char* name) {
        return std::strcmp(s.name, name) == 0;
    }

    std::optional<std::size_t> RvaToFileOffset(const std::vector<Section>& sections,
                                               std::uint32_t rva) {
        for (const auto& s : sections) {
            std::uint32_t upper = s.virtualAddress +
                (std::max)(s.sizeOfRawData, s.virtualSize);
            if (rva >= s.virtualAddress && rva < upper) {
                return static_cast<std::size_t>(s.pointerToRawData) +
                       (rva - s.virtualAddress);
            }
        }
        return std::nullopt;
    }

    std::optional<std::size_t> GetOwnerSection(const std::vector<Section>& sections,
                                               std::uint32_t rva) {
        for (std::size_t i = 0; i < sections.size(); ++i) {
            const auto& s = sections[i];
            std::uint32_t upper = s.virtualAddress +
                (std::max)(s.sizeOfRawData, s.virtualSize);
            if (rva >= s.virtualAddress && rva < upper) return i;
        }
        return std::nullopt;
    }

    // ── SteamXOR ─────────────────────────
    // Decodes a buffer in place walking 4-byte dwords. When `key` is 0 the
    // first dword of the buffer seeds the key and decoding starts at offset 4.
    std::uint32_t SteamXor(std::uint8_t* data, std::size_t n, std::uint32_t key) {
        std::size_t offset = 0;
        if (key == 0) {
            if (n < 4) return 0;
            key = static_cast<std::uint32_t>(data[0]) |
                  (static_cast<std::uint32_t>(data[1]) << 8) |
                  (static_cast<std::uint32_t>(data[2]) << 16) |
                  (static_cast<std::uint32_t>(data[3]) << 24);
            offset = 4;
        }
        std::size_t x = offset;
        while (x + 4 <= n) {
            std::uint32_t val = static_cast<std::uint32_t>(data[x]) |
                (static_cast<std::uint32_t>(data[x + 1]) << 8) |
                (static_cast<std::uint32_t>(data[x + 2]) << 16) |
                (static_cast<std::uint32_t>(data[x + 3]) << 24);
            std::uint32_t decoded = val ^ key;
            data[x]     = static_cast<std::uint8_t>(decoded & 0xFF);
            data[x + 1] = static_cast<std::uint8_t>((decoded >> 8) & 0xFF);
            data[x + 2] = static_cast<std::uint8_t>((decoded >> 16) & 0xFF);
            data[x + 3] = static_cast<std::uint8_t>((decoded >> 24) & 0xFF);
            key = val;
            x += 4;
        }
        return key;
    }

    // ── AES-256-CBC via Windows CNG (bcrypt) ─────────────────────────────
    // Returns std::nullopt on any failure so the caller can surface a clear
    // "decrypt failed" message (matching the Rust behaviour).
    std::optional<std::vector<std::uint8_t>> Aes256CbcDecrypt(
        const std::array<std::uint8_t, 32>& key,
        const std::array<std::uint8_t, 16>& iv,
        const std::vector<std::uint8_t>& data) {
        if (data.empty() || data.size() % 16 != 0) return std::nullopt;

        BCRYPT_ALG_HANDLE alg = nullptr;
        BCRYPT_KEY_HANDLE keyHandle = nullptr;
        std::vector<std::uint8_t> keyObject;
        std::optional<std::vector<std::uint8_t>> result;

        do {
            if (BCryptOpenAlgorithmProvider(&alg, BCRYPT_AES_ALGORITHM, nullptr, 0) < 0)
                break;
            {
                // BCRYPT_CHAIN_MODE_CBC is a const WCHAR[] literal; CNG wants a
                // mutable PUCHAR, so copy it into a local buffer first.
                std::vector<std::uint8_t> chainMode(sizeof(BCRYPT_CHAIN_MODE_CBC));
                std::memcpy(chainMode.data(), BCRYPT_CHAIN_MODE_CBC,
                            sizeof(BCRYPT_CHAIN_MODE_CBC));
                if (BCryptSetProperty(alg, BCRYPT_CHAINING_MODE, chainMode.data(),
                                      static_cast<ULONG>(chainMode.size()), 0) < 0)
                    break;
            }

            ULONG objSize = 0, cb = 0;
            if (BCryptGetProperty(alg, BCRYPT_OBJECT_LENGTH,
                                  reinterpret_cast<PUCHAR>(&objSize), sizeof(objSize), &cb, 0) < 0)
                break;
            keyObject.resize(objSize);

            if (BCryptGenerateSymmetricKey(alg, &keyHandle, keyObject.data(), objSize,
                                           const_cast<PUCHAR>(key.data()),
                                           static_cast<ULONG>(key.size()), 0) < 0)
                break;

            std::vector<std::uint8_t> ivCopy(iv.begin(), iv.end());
            std::vector<std::uint8_t> out(data.size());
            ULONG produced = 0;
            if (BCryptDecrypt(keyHandle, const_cast<PUCHAR>(data.data()),
                              static_cast<ULONG>(data.size()), nullptr,
                              ivCopy.data(), static_cast<ULONG>(ivCopy.size()),
                              out.data(), static_cast<ULONG>(out.size()),
                              &produced, 0) < 0)
                break;
            out.resize(produced);
            result = std::move(out);
        } while (false);

        if (keyHandle) BCryptDestroyKey(keyHandle);
        if (alg) BCryptCloseAlgorithmProvider(alg, 0);
        return result;
    }

    // ── SteamStub 3.x x64 header ─────────────────────────
    struct SteamStub64Var31 {
        std::uint32_t signature = 0;
        std::uint32_t bindSectionOffset = 0;
        std::uint64_t originalEntryPoint = 0;
        std::uint32_t payloadSize = 0;
        std::uint32_t steamAppId = 0;
        std::uint32_t flags = 0;
        std::uint64_t codeSectionVa = 0;
        std::array<std::uint8_t, 32> aesKey{};
        std::array<std::uint8_t, 16> aesIv{};
        std::array<std::uint8_t, 16> stolenData{};
    };

    std::optional<SteamStub64Var31> ParseStub31(const std::vector<std::uint8_t>& raw) {
        if (raw.size() < kStub31Size) return std::nullopt;
        const std::uint8_t* p = raw.data();
        const std::size_t   n = raw.size();
        SteamStub64Var31 s;
        s.signature = ReadU32(p, n, 0x04);
        s.bindSectionOffset = ReadU32(p, n, 0x18);
        s.originalEntryPoint = ReadU64(p, n, 0x20);
        s.payloadSize = ReadU32(p, n, 0x2C);
        s.steamAppId = ReadU32(p, n, 0x38);
        s.flags = ReadU32(p, n, 0x3C);
        s.codeSectionVa = ReadU64(p, n, 0x48);
        std::memcpy(s.aesKey.data(), p + 0x60, 32);
        std::memcpy(s.aesIv.data(), p + 0x80, 16);
        std::memcpy(s.stolenData.data(), p + 0x90, 16);
        return s;
    }

    enum class Variant { Var31x64, Var30x64, Var31x86, Var30x86, Unknown };

    const char* VariantName(Variant v) {
        switch (v) {
        case Variant::Var31x64: return "3.1 x64";
        case Variant::Var30x64: return "3.0 x64";
        case Variant::Var31x86: return "3.1 x86";
        case Variant::Var30x86: return "3.0 x86";
        default:                return "Unknown";
        }
    }

    std::optional<Variant> DetectVariant(const std::vector<std::uint8_t>& d,
                                         const PeHeaders& h,
                                         const std::vector<Section>& sections) {
        std::optional<std::size_t> bindIdx;
        for (std::size_t i = 0; i < sections.size(); ++i)
            if (SectionIs(sections[i], ".bind")) { bindIdx = i; break; }
        if (!bindIdx) return std::nullopt;
        const Section& bindSec = sections[*bindIdx];

        std::size_t bindStart = bindSec.pointerToRawData;
        std::size_t bindEnd = (std::min)(bindStart + static_cast<std::size_t>(bindSec.sizeOfRawData),
                                         d.size());
        if (bindStart >= bindEnd) return std::nullopt;

        std::size_t scanLen = (std::min)(bindEnd - bindStart, static_cast<std::size_t>(0x3000));
        const std::uint8_t* bindData = d.data() + bindStart;

        if (!FindPattern(bindData, scanLen,
                         "E8 00 00 00 00 50 53 51 52 56 57 55 41 50"))
            return std::nullopt;

        auto off30  = FindPattern(bindData, scanLen, "48 8D 91 ?? 48");       // 3.0
        auto off31a = FindPattern(bindData, scanLen, "48 8D 91 ?? 41");       // 3.1
        auto off312 = FindPattern(bindData, scanLen,
                                  "48 C7 84 24 ?? 48");          // 3.1.2

        std::size_t offset = 0;
        int extra = 0;
        if (off30) { offset = *off30; extra = 0; }
        else if (off31a) { offset = *off31a; extra = 0; }
        else if (off312) { offset = *off312; extra = 5; }
        else return std::nullopt;

        std::size_t hdrSizeOffset = offset + 3 + static_cast<std::size_t>(extra);
        if (hdrSizeOffset + 4 > scanLen) return std::nullopt;
        std::int32_t rawHeaderSize = static_cast<std::int32_t>(ReadU32(bindData, scanLen, hdrSizeOffset));
        std::uint32_t headerSize = static_cast<std::uint32_t>(rawHeaderSize < 0 ? -rawHeaderSize : rawHeaderSize);

        bool is30 = (headerSize == kStub30Sizes[0] || headerSize == kStub30Sizes[1]);
        if (h.is64) {
            if (headerSize == 0xF0) return Variant::Var31x64;
            if (is30) return Variant::Var30x64;
            return std::nullopt;
        }
        if (headerSize == 0xF0) return Variant::Var31x86;
        if (is30) return Variant::Var30x86;
        return std::nullopt;
    }

    // ── Read the DRM stub header at OEP / TLS callback ───────────────────
    struct StubRead {
        SteamStub64Var31 stub;
        std::uint32_t xorAfterPayload = 0;
        bool tlsUsed = false;
    };

    std::optional<StubRead> TryReadStubAtX64(const std::vector<std::uint8_t>& d,
                                             const std::vector<Section>& sections,
                                             std::uint32_t entryRva, bool isTls) {
        auto fileOffset = RvaToFileOffset(sections, entryRva);
        if (!fileOffset) return std::nullopt;
        if (*fileOffset < kStub31Size) return std::nullopt;
        std::size_t headerStart = *fileOffset - kStub31Size;
        if (headerStart + kStub31Size > d.size()) return std::nullopt;

        std::vector<std::uint8_t> hdrData(d.begin() + headerStart,
                                          d.begin() + headerStart + kStub31Size);
        std::uint32_t xorAfter = SteamXor(hdrData.data(), hdrData.size(), 0);
        auto stub = ParseStub31(hdrData);
        if (!stub) return std::nullopt;

        std::uint32_t xorFinal = xorAfter;
        if (stub->payloadSize > 0) {
            std::uint32_t payloadSize = (stub->payloadSize + 0x0F) & ~0x0Fu;
            std::uint32_t payloadRva = entryRva - stub->bindSectionOffset;
            auto payloadOff = RvaToFileOffset(sections, payloadRva);
            if (payloadOff && *payloadOff + payloadSize <= d.size()) {
                std::vector<std::uint8_t> payload(d.begin() + *payloadOff,
                                                  d.begin() + *payloadOff + payloadSize);
                xorFinal = SteamXor(payload.data(), payload.size(), xorAfter);
            }
        }

        StubRead r;
        r.stub = *stub;
        r.xorAfterPayload = xorFinal;
        r.tlsUsed = isTls;
        return r;
    }

    std::optional<StubRead> ReadStubX64(const std::vector<std::uint8_t>& d,
                                        const PeHeaders& h,
                                        const std::vector<Section>& sections) {
        if (auto r = TryReadStubAtX64(d, sections, h.entryPointRva, false)) {
            if (r->stub.signature == kStubSignature) return r;
        }

        if (h.tlsDataDirRva != 0 && h.tlsDataDirSize != 0) {
            auto tlsFileOff = RvaToFileOffset(sections, h.tlsDataDirRva);
            if (tlsFileOff) {
                std::size_t cbRvaOffset = h.is64 ? *tlsFileOff + 24 : *tlsFileOff + 12;
                if (cbRvaOffset + (h.is64 ? 8u : 4u) <= d.size()) {
                    std::uint64_t cbVa = h.is64 ? ReadU64(d.data(), d.size(), cbRvaOffset)
                                                : static_cast<std::uint64_t>(ReadU32(d.data(), d.size(), cbRvaOffset));
                    if (cbVa != 0) {
                        std::uint32_t cbRva = cbVa > h.imageBase
                            ? static_cast<std::uint32_t>(cbVa - h.imageBase) : 0;
                        auto cbTableOff = RvaToFileOffset(sections, cbRva);
                        if (cbTableOff) {
                            std::uint64_t firstCbVa = h.is64
                                ? ReadU64(d.data(), d.size(), *cbTableOff)
                                : static_cast<std::uint64_t>(ReadU32(d.data(), d.size(), *cbTableOff));
                            if (firstCbVa != 0) {
                                std::uint32_t firstCbRva = firstCbVa > h.imageBase
                                    ? static_cast<std::uint32_t>(firstCbVa - h.imageBase) : 0;
                                if (auto r = TryReadStubAtX64(d, sections, firstCbRva, true)) {
                                    if (r->stub.signature == kStubSignature) return r;
                                }
                            }
                        }
                    }
                }
            }
        }
        return std::nullopt;
    }

    // ── File helpers ─────────────────────
    bool ReadFileBytes(const std::filesystem::path& path, std::vector<std::uint8_t>& out) {
        std::ifstream in(path, std::ios::binary | std::ios::ate);
        if (!in) return false;
        std::streamoff size = in.tellg();
        if (size < 0) return false;
        in.seekg(0, std::ios::beg);
        out.resize(static_cast<std::size_t>(size));
        if (size > 0 && !in.read(reinterpret_cast<char*>(out.data()), size)) return false;
        return true;
    }

    bool WriteFileBytes(const std::filesystem::path& path,
                        const std::vector<std::uint8_t>& data) {
        std::ofstream out(path, std::ios::binary | std::ios::trunc);
        if (!out) return false;
        if (!data.empty())
            out.write(reinterpret_cast<const char*>(data.data()),
                      static_cast<std::streamsize>(data.size()));
        return out.good();
    }

    // Backup naming: the FULL original filename plus the suffix, so re4.exe
    // becomes re4.exe.bak. Using stem() would have produced re4.bak, dropping
    // the ".exe" from the name. The suffix always starts with a dot; the
    // default is applied by the public API, not here.
    std::filesystem::path BackupPath(const std::filesystem::path& exe,
                                     const std::string& suffix) {
        if (suffix.empty()) return {};
        return exe.parent_path() / (exe.filename().string() + suffix);
    }

    Result MakeError(const std::string& msg) {
        Result r;
        r.success = false;
        r.message = msg;
        return r;
    }

} // namespace

// ── Public API ───────────────────────────

bool IsProtected(const std::filesystem::path& exePath) {
    return DetectProtected(exePath);
}

bool IsPatched(const std::filesystem::path& exePath, const std::string& backupSuffix) {
    // A backup alone does NOT mean "already fixed": the user may have restored
    // the original exe themselves while leaving the ".bak" file on disk. Trust
    // the real signal instead — if the live exe no longer carries the stub it
    // has already been cleaned, otherwise it still needs the fix.
    std::error_code ec;
    if (!std::filesystem::exists(BackupPath(exePath, backupSuffix), ec))
        return false;
    return !DetectProtected(exePath);
}

bool DetectProtected(const std::filesystem::path& exePath) {
    // Header-only detection: MZ/PE offsets plus the section table. The full
    // file is never read, so multi-hundred-MB game executables are fine.
    std::ifstream in(exePath, std::ios::binary);
    if (!in) return false;

    std::uint8_t dos[64] = {};
    in.read(reinterpret_cast<char*>(dos), sizeof(dos));
    if (in.gcount() != static_cast<std::streamsize>(sizeof(dos))) return false;
    if (dos[0] != 'M' || dos[1] != 'Z') return false;

    auto rd32 = [](const std::uint8_t* p) {
        return static_cast<std::uint32_t>(p[0]) |
               (static_cast<std::uint32_t>(p[1]) << 8) |
               (static_cast<std::uint32_t>(p[2]) << 16) |
               (static_cast<std::uint32_t>(p[3]) << 24);
    };

    const std::uint32_t peOff = rd32(dos + 0x3C);
    if (peOff < 0x40 || peOff > 0x1000) return false;

    in.seekg(peOff, std::ios::beg);
    std::uint8_t coff[24] = {};
    in.read(reinterpret_cast<char*>(coff), sizeof(coff));
    if (in.gcount() != static_cast<std::streamsize>(sizeof(coff))) return false;
    if (coff[0] != 'P' || coff[1] != 'E' || coff[2] != 0 || coff[3] != 0) return false;

    const std::uint16_t sectionCount = static_cast<std::uint16_t>(coff[6]) |
                                       (static_cast<std::uint16_t>(coff[7]) << 8);
    const std::uint16_t optSize = static_cast<std::uint16_t>(coff[20]) |
                                  (static_cast<std::uint16_t>(coff[21]) << 8);
    if (sectionCount == 0 || sectionCount > 96) return false;

    const std::uint32_t sectionTable =
        peOff + 24u + static_cast<std::uint32_t>(optSize);
    for (std::uint16_t i = 0; i < sectionCount; ++i) {
        in.seekg(static_cast<std::streamoff>(sectionTable) +
                 static_cast<std::streamoff>(i) * kSectionHeaderSize, std::ios::beg);
        std::uint8_t hdr[40] = {};
        in.read(reinterpret_cast<char*>(hdr), sizeof(hdr));
        if (in.gcount() != static_cast<std::streamsize>(sizeof(hdr))) return false;

        char name[9] = {};
        std::memcpy(name, hdr, 8);
        const std::uint32_t characteristics = rd32(hdr + 36);
        const bool executable = (characteristics & 0x20000000u) != 0;
        if (executable && std::strncmp(name, ".bind", 5) == 0)
            return true;
    }
    return false;
}

bool DetectProtectedInDirectory(const std::filesystem::path& dir,
                                std::filesystem::path& outExe) {
    namespace fs = std::filesystem;
    std::error_code ec;
    if (!fs::is_directory(dir, ec)) return false;

    for (fs::recursive_directory_iterator it(
             dir, fs::directory_options::skip_permission_denied, ec), end;
         !ec && it != end; it.increment(ec)) {
        if (it.depth() > 4) {
            it.disable_recursion_pending();
            continue;
        }
        if (!it->is_regular_file(ec)) continue;
        const fs::path& p = it->path();
        if (p.extension() != ".exe") continue;
        // Never consider our own backups.
        if (p.extension() == ".bak") continue;
        if (DetectProtected(p)) {
            outExe = p;
            return true;
        }
    }
    return false;
}

// ── Steamless CLI process layer ─────────────────────────
// 0xoCore.dll does NOT re-implement SteamStub removal. It drives the upstream
// atom0s Steamless.CLI.exe that the launcher already ships under
//   <launcher>/src-tauri/resources/gse-uc/embedded/steamless/
// together with all seven unpacker plugins (Variant 1.0/2.0/2.1 x86,
// 3.0 x86 + x64, 3.1 x86 + 3.1.x x64). Re-implementing that coverage in C++
// was the bug: the hand-written variant detection only understood three narrow
// byte patterns, so a real shipping executable whose stub body differs (RE4)
// was reported as "not protected" even though .bind was present.
//
// The CLI writes "<exe>.unpacked.exe" next to the input and leaves the input
// untouched, so the is: back up the original, run the CLI, then move the
// unpacked file over the original.

namespace {

    bool RunCli(const std::filesystem::path& cliPath,
                const std::filesystem::path& exePath,
                std::string& outputExe,
                std::string& cliLog) {
        outputExe.clear();
        cliLog.clear();

        // CommandLineToArgvW-compatible quoting: wrap in quotes and escape every
        // embedded quote by doubling the backslash run before it.
        auto quote = [](const std::wstring& arg) {
            std::wstring out = L"\"";
            for (std::size_t i = 0; i < arg.size(); ++i) {
                std::size_t backslashes = 0;
                while (i < arg.size() && arg[i] == L'\\') { ++backslashes; ++i; }
                if (i == arg.size()) {
                    out.append(backslashes * 2, L'\\');
                    break;
                }
                if (arg[i] == L'"') {
                    out.append(backslashes * 2 + 1, L'\\');
                    out.push_back(L'"');
                } else {
                    out.append(backslashes, L'\\');
                    out.push_back(arg[i]);
                }
            }
            out.push_back(L'"');
            return out;
        };

        std::wstring cmd = quote(cliPath.wstring()) + L" --quiet " + quote(exePath.wstring());

        SECURITY_ATTRIBUTES sa{};
        sa.nLength = sizeof(sa);
        sa.bInheritHandle = TRUE;

        HANDLE readEnd = nullptr;
        HANDLE writeEnd = nullptr;
        if (!CreatePipe(&readEnd, &writeEnd, &sa, 0))
            return false;
        SetHandleInformation(readEnd, HANDLE_FLAG_INHERIT, 0);

        STARTUPINFOW si{};
        si.cb = sizeof(si);
        si.dwFlags = STARTF_USESTDHANDLES;
        si.hStdOutput = writeEnd;
        si.hStdError = writeEnd;
        si.hStdInput = GetStdHandle(STD_INPUT_HANDLE);

        PROCESS_INFORMATION pi{};
        std::vector<wchar_t> mutableCmd(cmd.begin(), cmd.end());
        mutableCmd.push_back(L'\0');

        const std::wstring workDir = cliPath.parent_path().wstring();
        const BOOL started = CreateProcessW(
            cliPath.wstring().c_str(),
            mutableCmd.data(),
            nullptr, nullptr, TRUE,
            CREATE_NO_WINDOW,
            nullptr,
            workDir.empty() ? nullptr : workDir.c_str(),
            &si, &pi);
        CloseHandle(writeEnd);

        if (!started) {
            CloseHandle(readEnd);
            cliLog = "Khong the chay Steamless.CLI.exe (err=" +
                     std::to_string(GetLastError()) + ").";
            return false;
        }

        std::string captured;
        char buf[4096];
        DWORD got = 0;
        while (ReadFile(readEnd, buf, sizeof(buf), &got, nullptr) && got > 0)
            captured.append(buf, got);
        CloseHandle(readEnd);

        WaitForSingleObject(pi.hProcess, 10 * 60 * 1000);
        DWORD exitCode = 1;
        GetExitCodeProcess(pi.hProcess, &exitCode);
        CloseHandle(pi.hThread);
        CloseHandle(pi.hProcess);

        // Pull the "File Saved As:" path out of the CLI log when present.
        const std::string marker = "File Saved As:";
        if (auto at = captured.rfind(marker); at != std::string::npos) {
            std::size_t b = at + marker.size();
            while (b < captured.size() && (captured[b] == ' ' || captured[b] == '\t')) ++b;
            std::size_t e = b;
            while (e < captured.size() && captured[e] != '\r' && captured[e] != '\n') ++e;
            outputExe = captured.substr(b, e - b);
        }
        cliLog = captured;
        return exitCode == 0;
    }

    // Last non-empty line of the CLI log, for a compact user-facing message.
    std::string LastLogLine(const std::string& log) {
        std::string best;
        std::size_t pos = 0;
        while (pos < log.size()) {
            std::size_t eol = log.find('\n', pos);
            if (eol == std::string::npos) eol = log.size();
            std::string line = log.substr(pos, eol - pos);
            while (!line.empty() && (line.back() == '\r' || line.back() == ' '))
                line.pop_back();
            if (!line.empty()) best = line;
            pos = eol + 1;
        }
        return best;
    }

} // namespace

void SetComponentDir(const std::string& steamlessDirUtf8) {
    std::filesystem::path dir = std::filesystem::u8path(steamlessDirUtf8);
    g_cliPath = dir / "Steamless.CLI.exe";
}

const std::string& ComponentDir() {
    static std::string cached;
    const std::u8string u8 = g_cliPath.parent_path().u8string();
    cached.assign(reinterpret_cast<const char*>(u8.data()), u8.size());
    return cached;
}

Result Unpack(const std::filesystem::path& exePath, const std::string& backupSuffix) {
    const std::string suffix = backupSuffix.empty() ? ".bak" : backupSuffix;

    std::error_code ec;
    if (!std::filesystem::is_regular_file(exePath, ec))
        return MakeError("Khong tim thay file game: " + exePath.string());

    if (g_cliPath.empty() || !std::filesystem::is_regular_file(g_cliPath, ec)) {
        LOG_MISC_ERROR("SteamlessApply: Steamless.CLI.exe not found at \"{}\"",
                       g_cliPath.string());
        return MakeError("Thieu Steamless (embedded/steamless/Steamless.CLI.exe). "
                         "Khong the go SteamStub.");
    }

    // Cheap pre-check purely for the log / early-out, using the header-only
    // detector. A false negative here must NOT block the CLI, because upstream
    // understands more variants than we can spot from the section table.
    const bool looksProtected = DetectProtected(exePath);

    std::string cliOut;
    std::string cliLog;
    const bool ok = RunCli(g_cliPath, exePath, cliOut, cliLog);
    if (!ok) {
        LOG_MISC_WARN("SteamlessApply: CLI failed path=\"{}\" last=\"{}\"",
                      exePath.string(), LastLogLine(cliLog));
        return MakeError("Steamless khong xu ly duoc file (khong phai SteamStub "
                         "hoac da duoc fix truoc do). " + LastLogLine(cliLog));
    }

    if (cliOut.empty()) {
        const std::u8string u8 =
            (exePath.parent_path() / (exePath.filename().string() + ".unpacked.exe")).u8string();
        cliOut.assign(reinterpret_cast<const char*>(u8.data()), u8.size());
    }

    const std::filesystem::path unpacked = std::filesystem::u8path(cliOut);
    if (!std::filesystem::is_regular_file(unpacked, ec)) {
        LOG_MISC_WARN("SteamlessApply: CLI reported success but \"{}\" is missing",
                      unpacked.string());
        return MakeError("Steamless bao thanh cong nhung khong tim thay file ket qua.");
    }

    const std::filesystem::path backupPath = BackupPath(exePath, suffix);
    if (!std::filesystem::exists(backupPath, ec)) {
        std::filesystem::copy_file(exePath, backupPath,
                                   std::filesystem::copy_options::overwrite_existing, ec);
        if (ec) {
            std::filesystem::remove(unpacked, ec);
            return MakeError("Khong the tao ban sao luu file goc: " + backupPath.string());
        }
    }

    std::filesystem::copy_file(unpacked, exePath,
                               std::filesystem::copy_options::overwrite_existing, ec);
    if (ec) {
        std::filesystem::copy_file(backupPath, exePath,
                                   std::filesystem::copy_options::overwrite_existing, ec);
        std::filesystem::remove(unpacked, ec);
        return MakeError("Khong the thay the file game (game dang chay?).");
    }
    std::filesystem::remove(unpacked, ec);

    LOG_MISC_INFO("SteamlessApply: unpacked exe=\"{}\" backup=\"{}\" via Steamless.CLI (prelook={})",
                  exePath.string(), backupPath.string(), looksProtected ? 1 : 0);

    Result r;
    r.success = true;
    r.variant = "steamless-cli";
    r.outputPath = exePath.string();
    r.message = "Da xu ly thanh cong! SteamStub da duoc go bang Steamless. "
                "Ban goc: " + backupPath.string();
    return r;
}

std::string Restore(const std::filesystem::path& exePath, const std::string& backupSuffix) {
    std::filesystem::path backupPath = BackupPath(exePath, backupSuffix);
    std::error_code ec;
    if (!std::filesystem::exists(backupPath, ec)) {
        return "Khong tim thay ban sao luu file goc.";
    }
    std::filesystem::copy_file(backupPath, exePath,
                               std::filesystem::copy_options::overwrite_existing, ec);
    if (ec) {
        return "Khong the khoi phuc file goc (game dang chay?).";
    }
    std::filesystem::remove(backupPath, ec);
    return "Da khoi phuc file game ve phien ban goc.";
}

} // namespace SteamlessApply
