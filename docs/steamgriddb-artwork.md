# SteamGridDB artwork lookup

Revoke and rotate the previously exposed key. Set the **new** key only in the local process environment before launching or building:

```powershell
$env:STEAMGRIDDB_API_KEY = '<new-rotated-key>'
npm run tauri:dev
```

The local Tauri/Rust backend reads the key at runtime; it is never returned to the webview. Do not commit local `.env` files. Without the variable, existing Steam/native and local placeholder fallbacks remain active.
