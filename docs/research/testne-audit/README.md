# testne: audit tái lập, ba PoC và sửa CloudRedirect

Ngày thực hiện: 2026-09-04. Workspace: `E:\007Launcher`.

## Phạm vi và kết quả

Đợt này thực thi **audit offline + ba PoC clean-room + sửa lỗi có bằng chứng trong
CloudRedirect**. Không phải nghiệm thu toàn bộ roadmap Managed GSE/native overlay.
EmpireTools và uninstaller của nó bị loại khỏi phạm vi: không đọc, hash, chạy,
load hay tích hợp. Không chạy bất kỳ executable/DLL gốc nào của ba mẫu còn lại.

| Hạng mục | Kết quả trong đợt này |
| --- | --- |
| Inventory/PE/.NET bundle/đối chiếu nhận định cũ | Có công cụ tái lập, hash pin, test và receipt |
| PoC A: fingerprint/capability/owned receipt/health | Rust `cfg(test)`, fixture thật trong lab, không nối production |
| PoC B: metadata/provider observation cache | Rust `cfg(test)`, bounded cache, persistence/single-flight/TTL |
| PoC C: Windows process/Job/pipe + reducer | Helper tự build chạy thật; adapter dedupe chỉ trong test |
| CloudRedirect | Sửa source Rust/React, có regression tests; chưa build/deploy bản cài launcher |
| Steam Cloud Error trong ảnh | **Chưa xác định nguyên nhân trên máy chụp ảnh, chưa nghiệm thu sync thật** |
| Game/GSE/native Shift+Tab/soak | Không chạy trong đợt audit này |
| Hard power-loss | **Not tested** |

Không thay đổi Steam, save, remotecache, provider account, OAuth token hay cấu hình
game để làm biến mất cảnh báo. Không ép đóng Steam, deploy backend, push hoặc commit.
Những thay đổi dirty có sẵn, bao gồm binary CloudRedirect/GSE, được giữ nguyên;
không được coi chúng là sản phẩm build của đợt audit này. Chunk/staging vẫn dưới
`downloading`. Không có cleanup thư mục đệ quy.

## Bằng chứng và mã nguồn

- [Audit PE/bundle, hash, giới hạn và lệnh tái lập](E:/007Launcher/docs/research/testne-audit/static-audit.md).
- [PoC A+B: hợp đồng, test và giới hạn](E:/007Launcher/docs/research/testne-audit/poc-runtime-metadata.md).
- [PoC C: Windows helper và reducer](E:/007Launcher/docs/research/testne-audit/poc-session.md).
- [CloudRedirect: lỗi xác nhận được, sửa đổi, giới hạn và cách nghiệm thu](E:/007Launcher/docs/research/testne-audit/cloud-sync-fix.md).
- [Kết quả kiểm thử cuối cùng và artifact receipts](E:/007Launcher/docs/research/testne-audit/verification.md).
- [Audit toolkit](E:/007Launcher/scripts/testne_audit/audit.py).
- [Windows helper runner](E:/007Launcher/scripts/testne_session/run.ps1).

Lab: `C:\Users\conte\CodexLabs\testne-audit`, tổng budget 5 GiB, chừa tối thiểu
10 GiB trên volume. Output nằm trong run directory riêng, không trong folder mẫu.
Receipt chỉ ghi exact-owned files. Hash không tự biến thành chứng nhận provenance,
license, signature trust hoặc tương thích runtime.

## Những nhận định đã được sửa sau khi mổ xẻ

### Squeegee

Mẫu có SHA-256
`e78e78452d70ab9fc98d51c5cb3f283fecd0174de2e51cec88dec191add51bb2`.
Outer host native **không** có nghĩa application là NativeAOT. Bundle format 6.0
có 311 entries; main assembly có CLR directory và IL có thể phân tích. Main DLL:
`0d4750bc9be1d198f05b36a5153a85be0912a71af93a583b70806684fe22483e`.

Các điểm dưới đây là static/decompile evidence của đúng hash, không phải lời
khẳng định hành vi đã được quan sát khi chạy mẫu:

| Vị trí | Quan sát | Quyết định tích hợp |
| --- | --- | --- |
| `OnStartup`, RVA `0x9130` | Có protocol registration, migration, update check, resume download và start dịch vụ upload config keys | Không chạy thử mẫu trên profile thật chỉ để xem UI |
| `ConfigKeysUploadService.Start`, `0x29554`; upload `0x295E4` | Gated bởi AutoUploadConfigKeys, đọc Steam config; settings constructor `0x4F458` có mặc định bật | Không port upload key tự động; không truy cập key/token để thử |
| `SteamKitAppInfoService.GetAppInfoAsync`, `0x33A18` | PICS app-info, có xử lý cloud roots/launch config | Có thể học hợp đồng metadata/provenance; PoC B không gọi provider thật |
| SQLite initialize `0x2E820` | Bảng LibraryItems; không phải bằng chứng một metadata store hợp nhất | Không mô tả SQLite hiện diện là đã có cache architecture hoàn chỉnh |
| Image cache `0x2E520` | Key `steam_` + AppID; max 200, evict 40 entries; không có revision trong key | PoC B tách provider/locale/revision, giữ richer schema khi lỗi |
| Update download `0x27CF4` / `0x27D64` | Có yêu cầu và so SHA-256 cho luồng app update | Học verify-before-publish, không coi mọi download đều được bảo vệ |
| CloudRedirect fetch/deploy `0x47DCC` | Luồng GitHub latest/temp/replace không có cùng hash gate | Không copy downloader này vào launcher |

### `E:\testne\dwmapi.dll`

Mẫu có SHA-256
`98e9620e9d6c317dd94e076e7c71c9d1189e0f87ccbf3304530dc54a1b5121a0`.
112 exports, hai embedded PE x86/x64. Đây **không** phải DLL đang nằm trong Steam
trên máy này; không suy luận hai file cùng tên là cùng runtime.

| Vị trí | Static evidence và giới hạn |
| --- | --- |
| Init `0x15420`, check `0x85390`, nhánh `0x15597` | Hash check có nhánh SafeMode; embedded defaults SafeMode=no và WarnHashMissmatch=no. Không phải fail-closed mặc định |
| `0x155C3` / `0x1560F` | Nhánh abort/continue khác nhau theo SafeMode. Chưa chứng minh thuật toán fingerprint module; không gán nhãn FNV/SHA-256 từ hash-map code |
| Adapter loader `0xE5270`; validation `0xE54FB–0xE5535` | Required exports: CR_InitCloudSave, CR_HandleCloudRpc, CR_AddApp, CR_RemoveApp, CR_IsApp, CR_Shutdown; thiếu required pointer thì unload |
| Optional call sites `0x8E6BB`, `0x8E6DD`, `0xE8BC2` | Có null guard/call cho GetAchievements và DrainPlaytimeUpdates; không đủ chứng minh ABI, ownership hay thread-safety |
| Remote API auth `0xBEEB0` | Có Bearer/query-token paths; empty token bị từ chối. Default disabled, bind 0.0.0.0:8765/TLS yes trong cấu hình; không có live listener evidence |
| Loader entry `0x15F30`; thread `0x160A1` | Resolve System DWM, loader callback, CreateThread: LoadLibrary không phải thao tác quan sát vô hại |
| Updater helper `0x87A00` | Có CreateProcessA để chạy installer khi điều kiện phù hợp; không chạy/update mẫu trong audit |

Port **ý tưởng capability gate, exact ownership, scoped event/session** thành mã
clean-room. Không mang proxy DLL, hook offsets hay undocumented ABI vào release.

### Hubcap installer

Hash `94118388dd4a0b9c90c05640863b3092aa10b17c5b880675108a65798588cff5`;
x86 Inno bootstrap với markers Setup Data 6.7.0. **Payload/script cài đặt bên trong
chưa được decode**, nên chưa kết luận capability của installed application.
Không chạy installer để lấp khoảng trống này. Báo cáo giữ `unassessed` thay vì
suy diễn từ strings/imports.

## Đường đưa PoC vào production: năm change set riêng, chưa triển khai

1. **Runtime evidence/gates:** thay inputs audit thủ công bằng nguồn provenance đã
   pin, signature/license review và capability scanner có test; migrate receipt
   idempotent, không tự sửa game. Chưa dùng một version number để bảo đảm native ABI.
2. **Metadata store:** tích hợp đúng provider đang production dùng; namespace
   game/provider/account/locale/revision; schema-quality gate, bounded scheduling,
   source age/error. Provider lỗi không được ghi đè metadata đầy đủ bằng fallback.
3. **Session protocol:** đưa semantic identity/sequence/checkpoint vào protocol
   version thật; xác định reset/clear/progress/eviction; Windows handle/Job binding,
   shutdown/reconnect ở production service. PoC direct child chưa đại diện elevation.
4. **Cloud typed outcomes:** sửa và rebuild engine từ source đã pin để phân biệt
   noChanges/verified/partial/failed cho mỗi app/file. Wrapper/UI không được dùng
   queue-empty hoặc CLI exit zero làm sync proof. Giữ conflict/pre-restore snapshots.
5. **Integration/E2E:** game được duyệt, clean original hashes, real achievement,
   save restore/cloud conflict, Steam rewrite, release package, screenshot/video,
   telemetry và các gate đã thống nhất. Không chuyển acceptance từ game khác sang
   Rogue: Genesia hoặc từ Shift+F1 sang native Shift+Tab.

Các failure modes đã được review chéo: hash==trust, same-size/mtime drift bị bỏ
qua, nguồn metadata lỗi làm mất richer schema, duplicate unlock qua hai transport,
empty queue==synced, status-read gây copy/spawn, force-close khi đang download,
log làm lộ token và path. PoC không được quảng bá như một transaction engine đã
chứng minh crash/power-loss-safe hoặc một hostile-user filesystem sandbox.

Skill `debugging` yêu cầu truy từ bằng chứng đến nguyên nhân; `code-work` và
`code-verification` giữ write set nhỏ, có review chéo và tách test/PoC khỏi runtime
acceptance. Vì thế ảnh cloud vẫn được ghi chưa nghiệm thu, dù source regressions
đã được sửa và kiểm thử.
