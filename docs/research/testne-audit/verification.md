# Verification record — 2026-09-04

Verified on the dirty `E:\007Launcher` working tree based on HEAD
`8d3a25b52103b2485b97af333b447fdc992680e9`. No commit, reset, stage, deployment or
sample execution was performed. HEAD alone is **not** the identity of the dirty
build; artifact and source receipts below provide the narrower evidence.

## Final checks

| Check | Fresh result | What it establishes |
| --- | --- | --- |
| `cargo test --lib -- --test-threads=1` | **282 passed, 0 failed, 2 ignored**, 74.09 s test time | Integrated Rust contracts/fixtures, including the final cloud fixes and 17 audit/reducer tests |
| Audit Python unit tests | **29 passed** | Bounded parsing, pinned inputs, exclusive writes and synthetic malformed-input rejection |
| Windows session helper, Release fixture build | **8/8 passed**, build 0 warnings/errors | Own-process Job/pipe/PID/path/session checks and bounded shutdown |
| Read-only PowerShell lab safety tests | **6/6 passed** | Reparse ancestor/descendant rejection and normal lab acceptance |
| Frontend production outcome function | **6/6 passed** | Failure/unknown sync cannot produce verified-save success notification |
| CloudRedirect bilingual contract | **PASS**, 171 keys | Existing command/i18n source contracts, not UI execution |
| `npm run build` | **PASS** | ACL preflight 263 commands, web-security 5/5, TypeScript, Vite/PWA |
| Scoped `rustfmt --check` | **PASS** | Formatting of changed cloud and new audit modules |
| `git diff --check` | **PASS** | No whitespace errors; Git still reports existing LF/CRLF normalization warnings |
| Static exact-owned output receipt | **6/6 hashes and sizes verified by coordinator** | Extracted bytes match recorded artifacts |
| Session source/artifact receipt | **All recorded hashes verified by coordinator** | Own helper build inputs/output match the final run |

The two ignored Rust tests are the disposable-NTFS-VHDX helper and the transaction
crash child entrypoint. The parent process-crash test and the existing exclusive
file-lock test passed in the suite; this is not a new VHDX full-disk or hard
power-loss run. `powerLossTested` remains **false / not tested**.

The first CLI regression run intentionally demonstrated two failures before the
fix. An intermediate compile also caught two operation-result constructors missing
the new optional field; both were corrected before the final 282-test pass.
Final Rust compilation still emits pre-existing warnings; no unrelated cargo-fix
or global formatting was applied. Web build retains the >500 kB chunk warning.

Toolchain: rustc 1.94.0 (`4a4ef493e`), Cargo 1.94.0 (`85eff7c80`), Node 24.14.0,
.NET SDK 10.0.300 targeting the helper's .NET 8 project.

## Artifact evidence

Rust test artifact (not a distributable launcher release):

`E:\007Launcher\src-tauri\target\debug\deps\first_light_launcher-9930d928ae5882ec.exe`

SHA-256 `dd9e33a49cf43d5a71be1397305befdc387bd20ae9cae03d8ea94ec73acdd7ca`,
35,137,024 bytes.

Static extraction:

`C:\Users\conte\CodexLabs\testne-audit\20260904T052016Z-f2e92782633b\receipt.json`

Receipt SHA-256
`9664f2044a7c990e79fff4a1cd4357f1a5567f5b15a6346e16f903487cdd1109`.
Six planned exact-owned artifacts all exist with the expected hashes and sizes.
`compare-claims` was rerun independently against the three allowed sample hashes.

Final coordinator-run Windows fixture:

`C:\Users\conte\CodexLabs\testne-audit\session-20260904-123327-ab9bd878\evidence.json`

Evidence SHA-256
`e4c4cd8b1bfe978eb5a9afab845946720e6de290fe658501f11d5b2b30d4ddce`.
Accepted root PID **26704**, child PID **17568**, exact Job membership and direct
ancestry. Received `unlock → flush → runtimeStopped`; active Job process count
after exit **0**. Cases completed in 107–250 ms. A final process-list check found
no `SessionHarness` or `UnapprovedFixture` remnants. No pipe secret is recorded.

## Explicitly not established

- The affected machine/game's Steam Cloud error is fixed. Its log is still needed.
- A Tauri UI session or production social/backend deployment passed.
- Any original sample can safely run, be redistributed or be loaded into Steam.
- Hubcap installer payload/script capability: remains unassessed.
- Real game/GSE/native Shift+Tab/achievement/save restore acceptance.
- Production metadata/session integration from the test-only PoCs.
- New release installer, clean-checkout packaging, signature/license provenance,
  4-hour × 3 soak, RAM plateau, full-disk VHDX or hard power-loss evidence.

Do not relabel synthetic/own-helper tests as game, native-overlay, provider or
Steam-runtime acceptance. The old engine source's empty-queue/attempted-app success
flag remains insufficient to verify cloud save bytes; the UI now says so.
