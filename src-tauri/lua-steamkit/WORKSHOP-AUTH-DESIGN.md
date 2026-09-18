# Authenticated Workshop: direct-file implementation and remaining CDN design

The packaged sidecar now retains anonymous `appInfo` as schema v1 and implements separate schema-v2 QR login/authenticated item details. Rust owns cancellation, DPAPI persistence, account-revision binding, and the direct-file Lua download path. The following design remains the boundary for the unimplemented manifest/CDN route, not a claim of full Workshop support. A real Steam QR challenge/cancel smoke passed without account login; user-confirmed login and authenticated content acquisition remain unverified until exercised with the user's account.

## Concrete SDK route

1. Connect a dedicated SteamKit client and keep its callback pump alive.
2. Start `SteamClient.Authentication.BeginAuthSessionViaQRAsync(AuthSessionDetails)`. `QrAuthSession.ChallengeURL` and `ChallengeURLChanged` provide the current QR challenge. `PollingWaitForResultAsync(CancellationToken)` yields `AuthPollResult`; its `RefreshToken` is the value subsequently accepted by `SteamUser.LogOnDetails.AccessToken`, with `Username` and `ShouldRememberPassword` matching persistence policy. No Steam installation/token-cache reads or password/CLI transport are required.
3. After authenticated `LoggedOnCallback.Result == EResult.OK`, create `SteamUnifiedMessages.CreateService<PublishedFile>()` and call `GetDetails(CPublishedFile_GetDetails_Request)` with `appid`, exact `publishedfileids` and `includechildren`. Check both unified result and per-item result/AppID/item identity before use.
4. A nonempty `PublishedFileDetails.file_url` permits the existing bounded direct-download route, after validating the official host, expected size and item revision.
5. The actual legacy SDK method is `SteamCloud.RequestUGCDetails(UGCHandle)`, not `SteamRemoteStorage.GetUGCDetails`. Its `UGCDetailsCallback` can return `URL`, `FileName`, `FileSize`, `AppID` and `Result`. It resolves a UGC handle, not an arbitrary published-file ID.
6. Authentication does **not** guarantee a direct URL. Modern Workshop entries commonly expose `hcontent_file` as a content manifest. SteamRE's own DepotDownloader routes such entries through `depots.workshopdepot` and the normal authenticated CDN manifest/chunk pipeline. Required SDK operations include `SteamContent.GetManifestRequestCode`, `SteamContent.GetCDNAuthToken`, `SteamApps.GetDepotDecryptionKey` and `SteamKit2.CDN.Client` manifest/chunk downloads. Access denied must remain access denied; it is not a reason to change AppID/account or bypass ownership.

Primary source references:

- [Pinned SteamKit authentication source](https://github.com/SteamRE/SteamKit/blob/1c7bc9c41a529e8fbb1e6890f1e4dbcdc5200cb7/SteamKit2/SteamKit2/Steam/Authentication/SteamAuthentication.cs)
- [Pinned SteamKit SteamCloud UGC handler](https://github.com/SteamRE/SteamKit/blob/1c7bc9c41a529e8fbb1e6890f1e4dbcdc5200cb7/SteamKit2/SteamKit2/Steam/Handlers/SteamCloud/SteamCloud.cs)
- [SteamRE DepotDownloader session calls](https://github.com/SteamRE/DepotDownloader/blob/master/DepotDownloader/Steam3Session.cs)
- [SteamRE DepotDownloader direct versus manifest routing](https://github.com/SteamRE/DepotDownloader/blob/master/DepotDownloader/ContentDownloader.cs)

## Security and protocol separation

Keep schema-v1 `appInfo` unchanged. Authentication needs a separate interactive, framed broker protocol: one request identity, bounded QR-challenge events, final private credential result, cancellation and a bounded expiry. A 35-second one-response metadata process cannot display a QR code and wait for user confirmation without changing its contract.

The Rust broker alone launches the pinned child and consumes all private output. It forwards only the QR challenge and public status to React. The account-bound refresh token goes straight from the inherited private pipe into the existing Rust DPAPI/vault boundary. It must never enter Tauri event payloads, frontend state, task receipts, logs, environment variables, CLI arguments or plain files. A user-initiated disconnect clears the exact stored vault entry and terminates the exact owned broker process. A failed login must not overwrite a working vault entry. Account switches invalidate permission-sensitive observations.

An authenticated resolve/download request receives a decrypted token only over the inherited private pipe. Its public UI request contains only account-vault identity, AppID, item ID and approved operation. Keep CDN credentials and depot keys in sidecar memory; never return them in public metadata or progress. Log only fixed error codes and bounded numeric progress. Use a persistent opaque device identity owned by the auth vault, rather than scraping Steam or hardware identity, if Steam Guard needs continuity.

## Download implementation boundaries

Reuse Rust's Lua Workshop admission checks and exact-owned `downloading/lua-workshop/<task>` target. Do not call Steam client's `DownloadItem`, subscribe to an item, modify Steam's workshop manifests, grant licenses, or launch an external installer. The authenticated session should resolve a dry-run plan first, including item/AppID/revision, route, total size and manifest identity. Confirmation binds that plan to the account and output receipt.

The CDN route is a genuine new downloader, not a one-method URL lookup. It needs bounded concurrent servers/chunks, retry budgets, cancellation, expected compressed/uncompressed sizes, chunk hash/checksum verification, file final-hash verification, durable exact-owned partials, free-space preflight, and Windows path/reparse/hard-link protections. A manifest entry cannot choose a path outside the task root. Collections need explicit bounded child planning; no unbounded recursive collection expansion. Links and unsupported file types fail closed.

The fastest complete slice is QR auth + authenticated details + official direct-file downloads using the existing Rust writer. That slice must explicitly report manifest-backed items as requiring the CDN route until that implementation exists. Calling it full Workshop support would be incorrect. Completing both routes is feasible with the pinned SDK, but needs a separate reviewable session broker and CDN transaction change set; the anonymous PICS sidecar alone does not supply that work.

## Verification needed before enabling capability

- Protocol/parser tests for credential-field rejection at public commands, identity mismatch, expiry/cancellation and error redaction.
- Vault round trip, failed-login preservation, account switch and disconnect without plaintext credentials in disk/log/event artifacts.
- User-confirmed real QR login and owned-account permission checks; no credentials are inferred or harvested.
- Real direct-file item and real manifest-backed item downloads into the approved `downloading` fixture only, with receipt and complete file/chunk verification.
- Wrong account/AppID, private/unavailable item, truncated transfer, disk-full, locked partial, cancellation and restart tests.
- Explicit distinction between component availability, authenticated session state and successfully verified content acquisition.
