# Hubcap integration review — hai tệp trong `testnehubcap/`, 2026-09-17

## Ranh giới thực thi

Đợt này **chỉ đọc tĩnh** đúng hai tệp mới trong `E:\007Launcher\testnehubcap`:

| Tệp | Bytes | SHA-256 | Kết quả tĩnh |
| --- | ---: | --- | --- |
| `SqueegeeManifestApp.exe` | 85,487,519 | `8e51d2ae089a3a4b82b7c9dce79b45a131e59d956ea90ad655b8adbb746ec5b0` | Không ký. File version `2026.9.17.2`, product `SqueegeeManifestApp`. Chuỗi `.NET` host (`hostfxr_main_startupinfo`, `SqueegeeManifestApp.dll`, `SqueegeeManifestApp.deps.json`) ⇒ **single-file .NET host**, không phải app native thuần |
| `dwrite.dll` | 4,781,568 | `d0477962b94017c420e77f3f9fd5e9a4735048cc342bdf49dd3d1b1a672d9910` | Không ký. Proxy `dwrite.dll`: có export `DWriteCreateFactory` **và** chuỗi `%s\dwrite.dll` + `WINDI R\system32\rundll32.exe` (chuyển tiếp sang DLL hệ thống rồi `rundll32`) |

Không hash nào ở trên khớp mẫu đã pin trong
[static-audit.md](E:/007Launcher/docs/research/testne-audit/static-audit.md)
(`SqueegeeManifestApp.exe` = `e78e78…1bb2`, `dwmapi.dll` = `98e962…21a0`).
Đây là **cặp tệp khác** so với đợt audit 2026-09-04, nên kết luận cũ không tự động
áp dụng: hai tệp này vẫn ở trạng thái `unassessed` về hành vi runtime.

Đã làm: đọc metadata PE, hash, chuỗi (ASCII + UTF-16) và trích các đoạn chuỗi liên
quan. Đã **không** làm: không `load` DLL, không `CreateProcess`, không chạy mẫu,
không gọi endpoint của mẫu, không đọc credential/token, không ghi vào Steam.

## Cơ chế tải của bản `dwrite.dll` mới

Chuỗi mang nghĩa quyết định: `%s\dwrite.dll` và `DWriteCreateFactory` nằm cạnh nhau,
kèm `WINDI R\system32\rundll32.exe` / `rundll32.exe "…",#1`.

Suy ra (đây là suy luận từ chuỗi, chưa phải hành vi đã quan sát):

1. DLL này **được đặt cạnh** (`park`) một `dwrite.dll` khác; đường dẫn `%s\dwrite.dll`
   là bản thân nó hoặc bản đích.
2. Nó export `DWriteCreateFactory` để tiến trình Steam nạp thay vì
   `C:\Windows\System32\dwrite.dll`, rồi chuyển tiếp sang DLL hệ thống.
3. Việc nạp hook được thực hiện qua `rundll32` (`… ,#1`) — tức **không** tự inject
   trực tiếp vào `steam.exe` bằng một entry `DllMain` duy nhất như cách của
   `0xoLemonCoreNative`.

Điểm (3) chính là "new, more reliable loading method" mà changelog HubcapTools mô tả:
thêm một proxy DLL thứ ba, tương tự cách `0xoLemonCoreNative` đã dùng `dwmapi.dll`
và `xinput1_4.dll`.

Chuỗi cấu hình còn chứng minh tool nguồn viết lại `stplug-in/` →
`config/hubcap-lua/` (`%s migrated legacy stplug-in/ -> hubcap-lua/`), khác hẳn
đường dẫn `config/stplug-in` mà launcher này dùng. Vì vậy **không được trộn hai
hook layer**.

## Bốn thay đổi trong changelog và cách launcher đang đối xử

| Thay đổi upstream | Trạng thái trong launcher | Hành động |
| --- | --- | --- |
| Added games cập nhật sai "last played" / playtime ghi đè last-played | Launcher **không** hook `CUser::SetAppLastPlayedTime`, **không** ghi `rtime_last_played` ở bất kỳ đâu (`grep` toàn cây = 0 hit). Giá trị này do Steam giữ | Không có gì để sửa, và **không port** logic "sentinel" của tool nguồn |
| Added games không tự cập nhật khi không pin branch | Launcher đã xử lý: `LuaBindings::Bind_skipManifestPin` / `ParseSession::recordManifestAutoUpdate` (depot không pin ⇒ theo manifest mới), và `ManifestStateCache` + `ManifestFetch` giữ request-code/negative/unauthorized cache qua các phiên | Đã có; chỉ thêm kiểm thử hồi quy |
| Đổi cách nạp sang `dwrite.dll` + "park the new DLL" | `STEAM_HOOK_DLLS` chỉ có `0xoCore.dll`, `0xoPayload.dll`, `dwmapi.dll`, `xinput1_4.dll` | **Đã tích hợp**: `dwrite.dll` trở thành proxy thứ ba do launcher cài |
| Chia sẻ manifest trong `depotcache` (opt-in) | Launcher đã có luồng hai chiều: vault `%APPDATA%\com.0xolemon.launcher\depotcache` (`steam_manifest_integrity.rs`) | **Đã tích hợp**: thêm chiều "gửi lên" có kiểm soát, đọc từ vault + `depotcache` của Steam |

## Phần đã tích hợp trong đợt này

1. **`dwrite.dll` như proxy thứ ba** — mirror đúng thiết kế sẵn có:
   `source/proxy/LcDwriteProxy.cpp`, export `DWriteCreateFactory` rồi `LoadLibrary`
   `C:\Windows\System32\dwrite.dll` và forward. Không đổi hành vi nào khác.
2. **Cài/gỡ/đối chiếu `dwrite.dll`** — `STEAM_HOOK_DLLS` (4 → 5 tên), gỡ hook cũng
   dọn cả tên `dwmapi.dll`/`xinput1_4.dll`/`dwrite.dll` còn sót từ build trước.
3. **`dwrite.dll` là tuỳ chọn** — `resolve_hook_resource_dir`, `hook_files_present`,
   `hook_files_match_sources` chỉ **bắt buộc** bốn DLL lõi, nên bản cài cũ vẫn cập
   nhật được và sẽ nhận `dwrite.dll` ngay khi resource có mặt.
4. **Chia sẻ manifest trong depotcache** — `steam_manifest_integrity.rs`:
   liệt kê vault + `depotcache` của Steam, kiểm tra magic/identity trước khi dùng,
   ghi vào `%APPDATA%\com.0xolemon.launcher\depotcache-upload\`, có giới hạn số tệp,
   giới hạn dung lượng, bỏ qua symlink/reparse point và không xoá gì.

## Việc bắt buộc trước khi phát hành

- **Build lại `0xoLemonCoreNative`**: `dwrite.dll` chỉ xuất hiện trong
  `src-tauri/resources/steam_hooks/` sau khi chạy `build.bat` trong
  `src-tauri/0xoLemonCoreNative`. Nếu chưa build, bước 3 khiến `dwrite.dll` đơn giản
  là không được cài (đúng như thiết kế "optional"), không gây lỗi.
- Việc build này cần MSVC + CMake; đợt review này không chạy build.
- Nếu người dùng từng bật "anticheat-safe mode" của HubcapTools bản cũ, phải tắt rồi
  bật lại sau khi cập nhật (theo changelog upstream), vì build mới đã đổi DLL nạp.
- Không trộn layer: nếu người dùng dùng HubcapTools bên ngoài, nó ghi
  `config/hubcap-lua/`, launcher ghi `config/stplug-in/`. Chọn một, không chạy song.
