# Lua Shop SteamKit metadata and Workshop sidecar

This is original launcher adapter code using the unmodified, signed NuGet **SteamKit2 3.4.0** package, not a recovered sample binary. The package pins upstream commit `1c7bc9c41a529e8fbb1e6890f1e4dbcdc5200cb7` from `https://github.com/SteamRE/SteamKit`. Public PICS appinfo is fetched through a genuine anonymous Steam CM WebSocket session. Steam's HTTP directory is used only for CM discovery, not as a metadata proxy.

## Wire contract

Launch `0xoLemon.LuaSteamKit.exe` with no arguments, redirected stdin/stdout/stderr and a hidden window. Send one UTF-8 JSON line, then close stdin:

```json
{"schemaVersion":1,"requestId":"request-uuid","operation":"appInfo","appid":2067920}
```

The process emits exactly one compact JSON line and exits:

```json
{"schemaVersion":1,"requestId":"request-uuid","success":true,"source":"steamKit","appId":2067920,"appInfo":{"appid":"2067920","common":{"name":"..."}},"changeNumber":123}
```

The nested appinfo contains recursive VDF properties, with scalar values retained as strings. Repeated sibling property names become arrays instead of losing data. No parent `appinfo` wrapper is added. `changeNumber` is the real Steam PICS revision, not a fabricated build number.

Errors use `success:false`, the fixed source, identity, and an `errorCode`; never stack traces or raw account/network details. Known errors include `CM_TIMEOUT`, `CM_DISCONNECTED`, `PICS_TIMEOUT`, `ANONYMOUS_LOGON_REJECTED`, `ANONYMOUS_LOGGED_OFF`, `APPINFO_UNAVAILABLE`, `APPINFO_REQUIRES_ACCESS_TOKEN`, `APPINFO_CM_BODY_UNAVAILABLE`, `APPINFO_EMPTY`, `APPINFO_ID_MISMATCH`, validation/size errors and `STEAMKIT_FAILURE`. Malformed requests with no validated identity return an empty requestId and appId 0. Exit 0 means a successful operation, 2 a reported operation/protocol failure, 3 output transport failure. Callers must validate the JSON envelope, identity and payload, not exit status alone.

Input is capped at 4 KiB with a five-second deadline. The callback loop remains active throughout connection, anonymous login and PICS, with a 35-second overall network deadline. Output is capped at 2 MiB. The parent must enforce a 45-second process limit and terminate its exact owned process if it stops responding. Cancellation/exit calls LogOff/Disconnect and disposes callback subscriptions. CM discovery is memory-only; the sidecar never opens Steam install files, account caches, tokens, local saves or games. Hardware identifiers are not provided. Unknown fields and operations, including authentication payloads, are rejected.

## Build and tests

### Separate Workshop protocol v2

Schema v1 remains anonymous metadata-only and rejects credential fields. Schema v2 accepts one private stdin request (16 KiB, five seconds) for `qrLogin` or `workshopDetails`. It emits bounded 16 KiB NDJSON frames with the same request ID and strictly increasing sequence. QR login emits at most 24 `challenge` frames, then one `credential` or fixed-code `error` frame. QR challenges must be HTTPS on `s.team/q/`, with no credentials, query or fragment. The native network deadline is 180 seconds for QR and 40 seconds for details; Rust adds a bounded parent deadline and a Windows kill-on-close Job Object before sending stdin. Cancel kills and reaps only this child.

Rust consumes the final account/token only after Steam has accepted a token login and the child has exited successfully. It writes encrypted DPAPI bytes to the Lua-only vault through the existing atomic file writer. React receives only the QR image, public phase, opaque account revision and SteamID. Failed/cancelled login preserves the previous vault; Forget removes only this launcher's exact encrypted entry and cancels active Workshop work. No password, client token-cache, command-line credential, environment credential, remote QR-image service or unreviewed helper is used.

Authenticated details use `PublishedFile.GetDetails` with the selected AppID and exact item ID, checking the logged-on SteamID and the returned item/AppID. Standard direct-file items reuse Rust's Lua Workshop bounded writer and receipts under `downloading`; approval binds account revision, item revision and expected bytes and is checked again on task start. Authenticated intents never fall back to an anonymous executable. Manifest/CDN items and collections are explicitly unsupported in this slice. This is not full authenticated Workshop acquisition evidence: actual user-confirmed login and account-permitted downloads still require E2E verification.

`scripts/build-lua-steamkit.ps1` builds a self-contained win-x64 distribution using SDK 8.0.420, .NET runtime 8.0.27 and `packages.lock.json`. It verifies signed NuGet packages and compares copied package DLLs against their signed archives. Assemblies are not single-file bundled, trimmed or rewritten, so SteamKit2 remains a separately replaceable assembly. The build emits a manifest listing every distribution file's path, SHA-256 and size, pinned source, toolchain, dependency and license evidence. No recursive cleanup is used. Unexpected existing output files block publication instead of being removed.

From this directory:

```text
dotnet run --project tests/LuaSteamKit.Tests.csproj --configuration Release
dotnet run --project tests/LuaSteamKit.Tests.csproj --configuration Release -- --live
```

The first command tests the real parser, JSON and VDF converters without networking. `--live` additionally performs an anonymous PICS query for AppID 2067920 and asserts real name metadata. It does not launch or modify the game. Authenticated/private appinfo, Workshop acquisition and achievements are not implemented by this protocol; they must not be advertised as supported.

## Third-party source and licenses

SteamKit2 package metadata declares LGPL-2.1-only; its upstream notice includes a later-version option. Both the package notice and complete LGPL-2.1 text are distributed. Source is pinned to the commit above; the release includes the exact corresponding upstream source archive as well as adapter source/build inputs. No SteamKit2 source modifications are applied. Source: `https://github.com/SteamRE/SteamKit/tree/1c7bc9c41a529e8fbb1e6890f1e4dbcdc5200cb7`.

Transitive dependencies are protobuf-net/protobuf-net.Core 3.2.56 (Apache-2.0), System.IO.Hashing 10.0.1 (.NET MIT and third-party notices), ZstdSharp.Port 0.8.7 (MIT), and the .NET 8.0.27 runtime (MIT and bundled third-party notices). The distributed notice files and manifest carry the actual package/source identifiers. This Lua-scoped sidecar does not authorize modified runtimes or game injection.
