# Reproducible offline binary audit — 2026-09-04

## Scope and execution boundary

This change audits exactly three approved samples by explicit name and pinned
SHA-256. It does not enumerate the source directory, execute an original sample,
load an original DLL, contact an embedded endpoint, install a package, inspect
credentials, or modify Steam/game/save files. No other application or uninstaller
is in this audit's input allowlist.

The implementation is [audit.py](E:/007Launcher/scripts/testne_audit/audit.py),
with synthetic regression fixtures in
[test_audit.py](E:/007Launcher/scripts/testne_audit/test_audit.py).
Python's standard library handles the bundle, hashing and basic PE metadata.
`--pe-details` explicitly requires `pefile`, already available in the launcher's
existing GSE-core build venv; the tool never installs dependencies.

## Freshly observed results

| Approved input | SHA-256 | Static result |
| --- | --- | --- |
| SqueegeeManifestApp.exe | `e78e78452d70ab9fc98d51c5cb3f283fecd0174de2e51cec88dec191add51bb2` | x64 host; .NET bundle 6.0; 311 entries; bundled main assembly has a CLR directory |
| dwmapi.dll | `98e9620e9d6c317dd94e076e7c71c9d1189e0f87ccbf3304530dc54a1b5121a0` | x64; 112 exports; two embedded PE resources, x64 and x86 |
| HubcapTools_Setup_2026-08-28_cabd63b.exe | `94118388dd4a0b9c90c05640863b3092aa10b17c5b880675108a65798588cff5` | x86 Inno bootstrap; Setup Data 6.7.0 markers; installed payload and script unassessed |

The Squeegee main DLL has SHA-256
`0d4750bc9be1d198f05b36a5153a85be0912a71af93a583b70806684fe22483e`.
Its managed PE contradicts the earlier claim that the main application is
NativeAOT and cannot be IL-decompiled. A native outer host alone does not settle
the execution model of an embedded application.

Nested resource identities are also reproducible, without executing them:

| Parent/resource | Bytes | Architecture | SHA-256 |
| --- | ---: | --- | --- |
| Squeegee / MINIDUMP_EMBEDDED_AUXILIARY_PROVIDER | 1,348,440 | x64 | `353bacdbab1a3624ab2d94a97815e2779db8f4df3c353987fc63392d9dfa5b74` |
| dwmapi / HUBCAP_STUB | 312,832 | x64 | `57d24dd98ffef54fd3d4df3ecfc904ba629edc67c615bee3770c9f133496d6e9` |
| dwmapi / HUBCAP_STUB32 | 259,584 | x86 | `6cb67ec721b39d9226ea977bd0bfd87e938803241d8ebe3d10d1ee9ea17ed8a0` |

All signatures are deliberately reported `notAssessed`, and provenance remains
false. Hash identity does not establish trust, license permission, runtime ABI
compatibility or safe execution. This audit is static evidence, not a runtime,
game, native overlay or achievement acceptance result.

## Commands and artifact ownership

Run from `E:\007Launcher`:

```powershell
& 'E:\007Launcher\src-tauri\.gse-core-venv\Scripts\python.exe' -B -X utf8 -m unittest discover -s scripts/testne_audit -v
& 'E:\007Launcher\src-tauri\.gse-core-venv\Scripts\python.exe' -B -X utf8 scripts/testne_audit/audit.py inventory --pe-details
& 'E:\007Launcher\src-tauri\.gse-core-venv\Scripts\python.exe' -B -X utf8 scripts/testne_audit/audit.py bundle
& 'E:\007Launcher\src-tauri\.gse-core-venv\Scripts\python.exe' -B -X utf8 scripts/testne_audit/audit.py compare-claims
& 'E:\007Launcher\src-tauri\.gse-core-venv\Scripts\python.exe' -B -X utf8 scripts/testne_audit/audit.py extract-static --pe-details --lab-dir 'C:\Users\conte\CodexLabs\testne-audit'
```

Without `--lab-dir`, inventory/bundle/compare-claims print JSON only. An explicit
`--sample squeegee`, `--sample dwmapi` or `--sample hubcap` narrows reads. No
unlisted filename can be selected. Any changed sample hash fails closed instead
of silently approving new bytes.

`extract-static` requires the exact approved lab root and creates a unique run
directory. It records a write-ahead `receipt.json`, then writes and hashes
`inventory.json`, `claims.json`, and four selected Squeegee bundle members:
main assembly, SteamKit2, runtimeconfig and deps. `--member` can explicitly select
another exact member of that same approved bundle. It does not extract or run an
Inno installer. Nested PE resources are inventoried, not executed.

The initial observed run is:

`C:\Users\conte\CodexLabs\testne-audit\20260904T052016Z-f2e92782633b`

Its receipt SHA-256 is
`9664f2044a7c990e79fff4a1cd4357f1a5567f5b15a6346e16f903487cdd1109`.
All six recorded artifacts independently passed a PowerShell SHA-256 and size
comparison against the receipt. The receipt denotes the **planned exact-owned
set**; an interrupted run can contain fewer files. A successful command response
is returned only after all planned artifact hashes verify. Raw files remain
private lab evidence and are not release inputs.

## Bounds, regression tests and known limits

- Input: at most 128 MiB per approved file. Bundle version must be 6.0; at most
  4096 entries, 128 MiB per member and 1 GiB aggregate declared expansion. Deflate
  decoding applies an output bound during decompression, verifies EOF and rejects
  extra compressed data. Suspicious ratios over 1000:1 fail closed.
- Names: invalid UTF-8, absolute/traversal paths, empty/dot components, Windows
  reserved names, alternate streams, case-folded duplicates and overlapping
  member ranges are rejected. Reparse points/symlinks are rejected in source and
  output ancestor chains.
- Resource inspection: at most 4096 resources, 1 GiB aggregate resource bytes,
  two PE levels. It emits imports/exports/resource metadata and hashes, not
  unrestricted strings or credential contents.
- Output: existing lab content plus new output must fit 5 GiB and leave at least
  10 GiB free on its volume. Writes use exclusive creation, flush and hash
  verification. Existing files are never overwritten. There is no delete or
  cleanup implementation; recovery operates by the exact receipt only.
- Fresh test result: **29 tests passed**. Tests cover compressed/uncompressed/Unicode fixtures; every truncation of a
  valid fixture; malformed headers/lengths/UTF-8; declared/actual expansion bombs;
  ratio/entry-count bounds; traversal/duplicate/overlap rejection; hash mismatch;
  wrong output root; no implicit extraction; free-space/budget gates; exact
  write-ahead ownership and exclusive writes. Tests use synthetic data and mock
  filesystem boundaries, never original execution.
- `compare-claims` checks a curated, explicit set of earlier assertions against
  fresh static evidence. It is not a natural-language proof engine and does not
  infer safety from imports. Inno 6.7.0 payload parsing and native decompilation
  remain separate, unassessed work; neither blocks independent clean-room PoCs.
- This is a single-writer audit utility, not a hostile multi-user sandbox. The
  normal filesystem checks do not promise protection against an administrator
  racing path replacement. Do not concurrently modify the lab/source paths.

The code-work skill shaped this change by keeping the write set limited to the
new audit tool/tests/document, preserving the dirty launcher baseline and
separating static evidence from real-runtime claims.
