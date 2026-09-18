# Runtime and metadata experiments — testne audit

These are original Rust laboratory experiments, compiled only through the
`#[cfg(test)] testne_audit` module. They do not copy decompiled implementation,
load a sample DLL, invoke an EXE, call a live provider, register a Tauri command,
or mutate Steam/game/save data. The production issues described in the audit
remain unchanged by these experiments.

## A. Runtime capability and exact-file ownership

`RuntimeAuditReport` records a SHA-256/size/PE-machine fingerprint, independent
provenance evidence, and a decision for each requested capability. Byte equality
does not imply source, toolchain, patch-set, license, or signature verification.
Unknown architecture, absent compatibility evidence, incomplete/ambiguous
required-pattern match counts and duplicate capability names fail closed. The
pattern counts are inputs from an auditor: this PoC is not an AOB scanner or
patch generator.

The fixture API creates a fresh UUID-named laboratory directory under the fixed
approved `C:\Users\conte\CodexLabs\testne-audit` root, with an identity marker.
It rejects caller-selected parents before creating anything, checks ancestor
reparse points, and enforces a 5 GiB total lab budget and 10 GiB free-space floor.
It accepts one exact filename, rejects traversal/reparse/device/trailing-dot paths, and
exposes dry-run plan, apply, read-only health and idempotent restore. Original
bytes are retained separately; apply rejects drift since plan, and restore
requires both current managed hash and retained-original hash. A created file
can be removed only through that receipt, with matching current content.

This intentionally narrow single-file experiment is **not** the production
managed transaction service. It does not claim atomic multi-file commit,
hostile concurrent-writer exclusion, hard-power-loss recovery, signature
verification by itself, or a real-game compatibility result. Runtime health
reads bytes only; it does not copy packages or run authentication CLIs.

## B. Persistent metadata/provider observations

`ObservationCache` uses a JSON index plus immutable SHA-256-named JSON blobs.
The exact key is AppID, locale, provider and schema revision. Successful
observations live for ten minutes; failures back off for two minutes. It
coalesces concurrent requests for one key and permits at most four provider
calls across keys. An injected clock makes expiry tests independent of wall
time. The directory lock excludes two cache writers. Provider panic releases
its single-flight slot.

Metadata is preserved as structured JSON with an adapter-assigned completeness
score. A poorer response cannot silently replace richer metadata; failure
retains exact good bytes and original observation time, returning explicit
stale/error state. Locale/provider/revision changes have separate entries.
Fresh blob reads verify size and hash, including equal-size/equal-mtime tampering.
Bounded stream reads prevent a growing file from exceeding its read allocation
budget. Persisted provider errors are bounded codes rather than raw URLs/bodies.

The index has at most 500 metadata entries and 500 provider observations;
individual blobs are limited to 512 KiB and referenced payload bytes to 32 MiB.
Normal eviction removes only obsolete exact blob paths recorded in the index
whose current bytes still match their recorded hashes. Unrelated files and
externally modified blobs are preserved. Malformed indexes fail explicitly
without being overwritten. This experiment does **not** claim a complete
crash-recovery protocol for a crash between blob/index persistence; interrupted
staging/orphan recovery must be designed before production adoption.

Provider quota observations are separate from credentials. Keys contain only
the provider and a caller-supplied opaque 64-hex credential identity. No raw API
key is accepted by the provider API. A successful observation persists used,
limit, optional validity/readiness, explicit expiry and observation time.
Reads are nonmutating and return unknown/fresh/stale; five-minute age, expiry
or a recorded provider failure makes an observation stale. Changing credential
identity returns unknown. Remaining quota is computed only when both limit and
usage were actually observed, never invented as zero usage/full allowance.

## Verification contract

The coordinator runs the serialized focused command after wiring the test-only
module:

```text
cargo test --lib testne_audit -- --test-threads=1
```

The tests exercise real local files and OS threads with synthetic PE/schema
fixtures. Assertions cover:

- Matching hash with unknown provenance; independent capabilities; PE machine,
  partial/ambiguous matches and equal-size tamper rejection.
- Nonmutating plan/health, replacement, retained byte-for-byte restore,
  idempotence, created-file restore, drift rejection and unrelated preservation.
- Locale/provider/revision isolation, persistent reopen, richer-schema
  retention, failure backoff, one request for twelve concurrent equal misses,
  and an observed four-call ceiling for distinct keys.
- 500-entry eviction with exact-owned blob removal, quota across restart,
  unknown credential identity, stale/expiry/429-style observations, malformed
  index preservation, same-size blob tampering, panic recovery and writer lock.

Final coordinator verification passed all 13 A+B tests after hardening as part of
the full **282 passed, 0 failed, 2 ignored** Rust suite. The four session/reducer
tests also passed in that run. See [verification.md](E:/007Launcher/docs/research/testne-audit/verification.md)
for the exact scope and artifact identity. Fixture directories are retained
under the approved lab root as `testne-audit-<UUID>`; no recursive cleanup
is performed. Retained originals are intentional audit evidence.
