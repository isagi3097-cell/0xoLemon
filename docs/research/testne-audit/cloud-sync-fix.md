# CloudRedirect và Steam Cloud Error — 2026-09-04

## Kết luận có bằng chứng

Ảnh `E:\IMG_3131.webp` chỉ xác nhận Steam báo **Unable to sync**. Nó không xác định
CloudRedirect, STFixer, provider, mạng hay local save là nguyên nhân. Trên máy đang
phân tích chưa thấy bản cài/log liên quan Soulstone Survivors, Hades hay Split
Fiction trong các nguồn đã kiểm tra; đã hỏi người dùng ảnh có thuộc máy khác không.

Steam ở `C:\Program Files (x86)\Steam` có build **1788400362**, ngoài danh sách build
được engine bundle khai báo hỗ trợ. Có `0xoCloudRedirect.dll` và backup cạnh nó,
không tìm thấy `cloud_redirect.log` ở Steam root. DLL này và `dwmapi.dll` tại Steam
không bị load, thay thế hoặc xoá trong đợt này. Steam không chạy tại lúc kiểm tra.

Recent cloud log trên máy này có app khác, quota checks và pending evaluation;
không đủ chứng minh lỗi trong ảnh đã tái hiện hoặc đã hết. Historical
`login=false` là quan sát cũ, không được gán làm nguyên nhân hiện tại của ảnh.

## Source regressions đã sửa

| Vấn đề | Sửa trong launcher |
| --- | --- |
| Status/diagnostics gọi ensure_runtime và/hoặc CLI | Chuyển sang read-only hash inspection; đọc config không tự tạo folder; không auth mạng khi mở Settings |
| Kiểm tên `cloud_redirect.dll` trong khi install dùng `0xoCloudRedirect.dll` | Dùng tên canonical; cảnh báo legacy/both; không tự gỡ file không rõ ownership |
| So size/mtime có thể bỏ qua artifact bị đổi bytes | Explicit prepare so hash, verify bản copy và nguồn; fixture same-size/mtime tái hiện repair |
| CLI process lỗi nhưng stdout JSON có thể lọt thành Ok | Bắt buộc exit success và boolean success:true cho operation; auth-status có contract riêng |
| success:false, `{}`, null, error-only hoặc success kiểu string | Bị từ chối, không báo “sync thành công” |
| CLI sync success chỉ phản ánh queue/attempts | Response thêm `syncVerification: notConfirmed`; UI informational, không thông báo đã đồng bộ save |
| Credentials có mặt bị mô tả “verified” | Tách localReady/credentialsPresentNotVerified/notConfigured; nhãn chỉ xác nhận đã có cấu hình |
| Build Steam quan sát/adapted được coi như engine verified | Installation/patch gate dùng danh sách build bundle; unknown version fail closed trước write |
| Nút đóng Steam dùng helper force-kill fallback | Command chỉ kiểm tra đã đóng hay chưa; nếu đang chạy yêu cầu người dùng hoàn tất game/download rồi tự Exit |
| Log error chứa dữ liệu nhạy cảm và kết luận quá rộng | Bounded log tail, redaction, AppID/timestamp/reason; không dùng quota/empty cache làm thành công, không coi no-conflicts/errors=0 là lỗi |

Hai regression đầu của CLI từng **fail thật trước khi sửa**: non-zero exit với
success:true, và zero-exit với success:false. Đây là bằng chứng wrapper bug, không
phải bằng chứng nguyên nhân của ảnh.

### Giới hạn engine 2.6.5 cần giữ rõ

Source vendor `src-tauri/vendor/cloudredirect/src/common/cli.cpp`:
`CmdSyncRemoteApp` dùng drained làm success; `CmdSyncAllRemoteApps` xuất success:true.
`cloud_storage.cpp` có vòng gọi SyncFromCloudWithFlag rồi đưa AppID vào syncedApps
không dựa vào kết quả verified-per-file. Vì thế wrapper nghiêm ngặt vẫn chưa đủ
để nói “Steam Cloud đã hết lỗi”. Đợt này không thay/rebuild native engine; typed
sync result là change set production riêng, không tự chạy engine khác để thử.

`OperationResult.success` của hai lệnh sync hiện chỉ nghĩa CLI operation kết thúc
theo contract. `syncVerification: notConfirmed` là trường authoritative cho giới
hạn này. UI cũng giữ conservative nếu backend cũ chưa có trường mới.

## Không làm

- Không chạy STFixer/patch hoặc install DLL để che cảnh báo.
- Không reset `remotecache.vdf`, xoá cloud data, chọn Local/Cloud thay người dùng,
  upload/download save hoặc tự đăng nhập provider.
- Không gọi Steam shutdown, force kill, sample executable/DLL.
- Không nâng support list để hợp thức hóa build 1788400362.
- Không báo game sync/restore/real overlay đã pass từ unit tests.

Các entrypoint CloudRedirect legacy khác, native ABI/provenance, atomic-copy
multi-file crash recovery, CLI timeout/cancellation và native typed sync outcomes
chưa được retrofit đầy đủ trong change set nhỏ này. Không gọi đây là toàn bộ
CloudRedirect production hardening đã hoàn tất.

## Nghiệm thu lỗi trong ảnh còn thiếu gì

1. Xác định đúng máy và AppID bị lỗi; lấy `Steam/logs/cloud_log.txt` tại thời điểm
   bấm retry, lọc/redact trước chia sẻ. Không gửi OAuth/token/config secrets.
2. Thu thập read-only Steam build, provider type, DLL hashes/ownership và log engine
   nếu có. Không suy luận loader đang hoạt động chỉ vì file tồn tại.
3. Từ mã lỗi thực xác định auth/network/provider/compatibility/save conflict.
   Nếu cần thay save/config, preview exact diff và giữ snapshot trước mutation.
4. Retry có kiểm soát, xác nhận Steam/engine per-app outcome và file hashes; chỉ
   nghiệm thu khi game trên máy đó không còn sync error, local save còn nguyên,
   và không có conflict bị chọn ngầm.

Trong lúc còn lỗi, không dùng Play Anyway như phép kiểm tra vô hại: Steam cảnh
báo sync conflict có thể khiến dữ liệu khác nhau giữa máy.
[Steam Cloud troubleshooting](https://help.steampowered.com/en/faqs/view/68D2-35AB-09A9-7678).

## Reproduce checks

```powershell
cargo test --manifest-path E:\007Launcher\src-tauri\Cargo.toml --lib -- --test-threads=1
node --test E:\007Launcher\src\components\cloudRedirectOutcome.test.mjs
node E:\007Launcher\src\components\cloudRedirectV2.contract.test.mjs
npm run build
```

Chạy Cargo tuần tự. Frontend outcome test import đúng hàm production, không chỉ
grep source. Existing bilingual/ACL checks vẫn là contract checks, không phải
Tauri UI/Steam E2E. Kết quả cuối cùng và evidence paths được ghi ở
[verification.md](E:/007Launcher/docs/research/testne-audit/verification.md).
