# CloudRedirect and Steam updates

## Current diagnosis

On 2026-09-11, the installed Steam client reported build `1788652215` from:

`<Steam>/package/steam_client_win64.manifest`

The bundled CloudRedirect runtime is version `2.6.5`. Its newest verified Steam build is `1788291500`.
Therefore the current Steam build is newer than the bundled native hook/signature set. The Steam Cloud warning is expected: the DLL may load, but the internal `steamclient64.dll` addresses and/or vtable layout are no longer verified.

Do not fix this by adding `1788652215` to a version list alone. That only changes the gate and can make an unverified binary patch appear supported.

## How upstream fixes a Steam update

CloudRedirect is a native hook against Steam's private implementation. A Steam client update can change:

- `steamclient64.dll` function layout and RVAs.
- RTTI names, vtables, call relationships, and protobuf helper functions.
- Instruction prologues used by signature scanning.
- SteamTools/Core DLL patch sites and payload patch bytes.
- Cloud RPC behavior and the session headers used by injected requests.

The upstream update cycle is therefore:

1. Record the new Steam build number from `steam_client_win64.manifest`.
2. Preserve the old DLL, SteamTools/Core files, payload cache, and save data.
3. Close Steam completely and collect the new `steamclient64.dll` plus relevant Core/SteamTools binaries.
4. Resolve changed functions with reverse engineering and update the native resolver/signatures in `src-tauri/vendor/cloudredirect/src/platform/win/`.
5. Update the STFixer signatures and validators in `src-tauri/vendor/cloudredirect/cli-rust/src/signatures.rs` and `patcher.rs` when Core/Payload patch sites changed.
6. Update the Windows hook logic in `cloud_intercept.cpp` when vtable slots, RPC wrappers, protobuf helpers, or session data changed.
7. Add the new Steam build to the verified list only after the new signatures and byte validators work against the exact binary.
8. Build the x64 CloudRedirect DLL, the x86 Cloud760 helper, and the CLI. Verify hashes and smoke-test install, launch, cloud read, cloud write, and Steam shutdown/restart.
9. Bump `Version.props`, update the source commit/release metadata, replace the bundled artifacts, and publish the matching runtime as one release.
10. Update the launcher vendor snapshot and run the CloudRedirect contract/regression tests before shipping.

## What the launcher currently does

- `src-tauri/src/cloud_redirect/steam_detector.rs` gates known Steam builds.
- `src-tauri/src/cloud_redirect/steam_specs_cloud.rs` can fetch a remote list of specs, but a version list is not a native hook update.
- `src-tauri/src/cloud_redirect/patcher.rs` registers a dynamically adapted build only after patch bytes resolve and verify successfully.
- `src-tauri/src/cloud_redirect_v2/engine.rs` verifies bundled runtime hashes and blocks installation for unknown Steam builds.
- `src-tauri/src/cloud_redirect_v2/integration.rs` exposes the compatibility state and diagnostics to the UI.
- `src/components/CloudRedirectSettings.tsx` polls Steam state and displays the unsupported-build warning.

## Safe update checklist

Before updating:

- Export or copy important saves.
- Keep the current `Steam/userdata` and `Steam/cloud_redirect` directories intact.
- Do not delete `remotecache.vdf` to silence the warning.
- Do not force an unknown Steam build into `SUPPORTED_STEAM_VERSIONS`.
- Do not run STFixer against a new Steam build until its patch signatures are verified.

After upstream publishes a compatible release:

- Update the vendored source snapshot, not only the DLL.
- Update `Version.props` and `ENGINE_SOURCE_COMMIT` together.
- Rebuild `0xoCloudRedirect.dll`, `cloud_redirect_cli.exe`, and `cloud760_tool.exe`.
- Confirm the resource hashes change as expected.
- Confirm diagnostics show the exact Steam build as supported before installing.
- Test one existing save and one new save with Steam Cloud enabled.

## Current action for build `1788652215`

The correct fix is to obtain an upstream CloudRedirect release/source update that explicitly supports `1788652215`, vendor it, rebuild the runtime, and only then install it. Until that exists, the launcher should keep the build blocked and preserve the saves rather than silently claiming that CloudRedirect is working.