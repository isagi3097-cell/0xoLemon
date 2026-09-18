# PoC C: owned Windows session and reducer boundary

This is a clean-room research fixture, **not a launcher/runtime integration**. It does not execute `dwmapi.dll`, embedded stubs, Empire, Squeegee, Steam, or any game. No production reducer behavior is changed. The only existing-source change is a `cfg(test)` module in `game_session_state.rs`.

## Reproduce

From PowerShell on Windows with installed .NET 8 reference/runtime packs:

```powershell
& E:\007Launcher\scripts\testne_session\run.ps1
```

The runner compiles checked-in C# source with no external package dependencies. All intermediates, executables and evidence go to a unique `C:\Users\conte\CodexLabs\testne-audit\session-*` directory. Before traversing or building it checks every existing ancestor from the drive root and rejects reparse points; lab enumeration is one directory level at a time and rejects link entries before descending. These guards are repeated after build and before evidence creation. A concurrent malicious same-user path swap is outside this preflight/postflight check's protection; it is not a handle-relative filesystem sandbox.

The preflight requires the 10 GiB C: free-space floor **plus** a 100 MiB run reserve and reserves the same amount inside the shared lab's 5 GiB limit. Build intermediates/output must remain below 90 MiB at the post-build check; execution and receipt have 10 MiB and 1 MiB remaining reserves respectively. These are checks around this known, dependency-free build, not OS disk quotas. Evidence is written with `FileMode.CreateNew`, exclusive sharing and a durable flush, so an existing receipt is never overwritten. No file is deleted or moved. The receipt inventories only files created in that run and includes source/artifact SHA-256 hashes, but no session secret.

`scripts/testne_session/test-lab-safety.ps1` checks the normal lab and read-only rejection of the existing `C:\Users\All Users` symbolic link and `C:\Documents and Settings` junction, including descendant paths. It creates no links or test folders.

To run reducer tests, serialize this command with other Cargo work:

```powershell
cargo test --manifest-path E:\007Launcher\src-tauri\Cargo.toml --lib testne_session_poc
```

## What the Windows test really exercises

The broker creates a random named pipe with an explicit protected DACL for the current user and SYSTEM. It reads back the applied kernel DACL. A secret is transported only through an explicit child environment block, never the command line. The broker starts its own bootstrap executable suspended, assigns it to a kill-on-close Job Object, and resumes it; the bootstrap starts the runtime child, which inherits Job membership.

On connection, the broker reads the kernel-reported named-pipe client PID, opens and retains a process handle, reads the executable image path and creation time, checks membership in the exact Job, and confirms the direct parent PID from Toolhelp. Authentication also checks declared PID/root PID, session/AppID and secret. This is a local same-user boundary: environment secrecy does not defend against a fully compromised same-user process or administrator.

| Case | Real operation and required result |
|---|---|
| Accepted | Actual root → child with inherited Job; accept exact path, peer PID, session and secret |
| Wrong PID | Child sends false PID; kernel peer identity takes precedence and rejects it |
| Wrong path | Bootstrap launches an exact copy of the clean fixture under `UnapprovedFixture.exe`; actual kernel image path is rejected |
| Wrong Job | Broker launches its own peer outside the session Job; membership check rejects it |
| Stale session | Actual child sends an expired session identifier; reject |
| Wrong secret | Actual child sends a separate random secret; reject without logging either value |
| Creation-time mismatch | Compare actual kernel creation time to an intentionally incorrect stored pin; reject |
| Oversized frame | Actual child sends a frame larger than 16 KiB; reject with bounded memory |

Accepted child sends `unlock`, `flush`, then `runtimeStopped` with sequences 1–3 and waits for the broker's close acknowledgement. The broker waits for root and child exit and checks Job active-process accounting is zero. All waits have cancellation deadlines; startup assignment failures terminate only the retained, owned process. Job close terminates its owned descendants. No broad process-name termination is used.

The creation-time test verifies enforcement of the pin; **it does not reproduce Windows PID reuse**. The DACL test reads back the real descriptor but does not log into a second Windows account. The harness validates a direct root/child topology, not arbitrary ancestry, elevation/brokers, an anti-cheat process, or a production native overlay.

## Reducer result and deliberately unpatched gap

The current real `SessionRecord::accept_event` keys replay suppression with `sessionId + transport + sourceEventId`. A named-pipe unlock and the same logical unlock observed by scoped fallback therefore receive two event IDs and two sequences. `baseline_accepts_duplicate_unlock_across_transports` characterizes this existing behavior directly; it is not a test asserting that this behavior is desirable.

The test-only adapter adds bounded semantic state before invoking the same real reducer. Its tests prove:

- identical unlock across transports emits once;
- `clear` followed by a genuinely new unlock still emits both transitions;
- a previously consumed fallback event cannot replay after clear while in the replay window;
- unchanged progress suppresses, changed progress emits;
- stale identity rejects before semantic suppression and increments the real drop counter;
- semantic state, source history and the real reducer's history remain bounded.

This prototype stores at most 512 achievement states and 2,048 transport event IDs. Evicted entries are no longer replay-protected. It is **not** a production-ready reconnect/replay protocol: source checkpoints, schema/epoch reset semantics, validation of progress values, and persistence need a separately approved production design. There is no new Tauri command, DLL loader, achievement mutation UI or production fan-out path here.

## Verification record

Final Windows run on 2026-09-04, after lab-confinement hardening, passed 8/8 cases after a Release fixture build with zero warnings/errors. The accepted root PID was 14928 and child PID 27080; Job membership and direct ancestry were observed, three shutdown-order events were received, and active Job processes after exit were zero. All eight cases completed in 124–225 ms each. A separate process-list check found no remaining `SessionHarness` or `UnapprovedFixture` process. The read-only lab safety suite passed 6/6 checks.

Final evidence: `C:\Users\conte\CodexLabs\testne-audit\session-20260904-122803-22739ee9\evidence.json` (includes source/artifact hashes and exact-owned receipt).

The coordinator independently reran the final helper: 8/8 passed, root 26704 and
child 17568 in the accepted case, 107–250 ms per case, zero active Job processes
and no remaining helpers. The coordinator also verified its source/artifact hashes.
This newer receipt is `C:\Users\conte\CodexLabs\testne-audit\session-20260904-123327-ab9bd878\evidence.json`.

All four reducer Cargo tests passed in the final serialized full suite:
282 passed, 0 failed, 2 ignored. See [verification.md](E:/007Launcher/docs/research/testne-audit/verification.md).
These helper tests do not establish game PID binding, real GSE achievement transport,
Shift+Tab, Steam compatibility, or release acceptance.
