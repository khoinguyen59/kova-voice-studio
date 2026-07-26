# KOVA Voice Studio 1.0.1.4 — báo cáo audit kỹ thuật, logic và UX

Ngày rà soát: 26-07-2026  
Phạm vi: mã nguồn hiện có trong worktree (bao gồm thay đổi chưa commit), không sửa đổi logic sản phẩm.

## Tóm tắt điều hành

Ứng dụng có nền tảng tốt cho một desktop client riêng tư: token Colab không được đưa vào `studio-state.json`, dữ liệu cục bộ được ghi với quyền riêng tư, giới hạn kích thước được áp dụng ở nhiều đường nhập và frontend hiện typecheck/build được. Tuy vậy, phiên bản hiện tại chưa nên phát hành như một bản có **pairing tự động**: toàn bộ đường đi từ UI đến relay đã bị ngắt. Hai lỗi chức năng đã thấy rõ là nút mở audio lịch sử trên Windows tạo `file:` URL sai và bộ lọc model miễn phí không phân tích giá trị số một cách đáng tin cậy.

Ưu tiên đề xuất:

1. Quyết định rõ: hoặc hoàn tất pairing relay và nối nó vào UI, hoặc bỏ toàn bộ mã pairing không dùng; không để trạng thái nửa triển khai.
2. Sửa ba lỗi tác động trực tiếp: URL audio lịch sử, phân tích giá model, và cấm gửi API key Gateway qua HTTP.
3. Tách worker client/lưu trữ/pairing khỏi `App`, thêm CI và test cho các đường lỗi quan trọng trước khi mở rộng tính năng.

## Cách kiểm tra và giới hạn

- Đã đọc các luồng Go, relay, Wails binding, UI React, cấu hình build, README và test hiện có.
- `npm run typecheck` và `npm run build` trong `frontend/` đều **thành công**. Vite 8.1.5 tạo bundle production thành công.
- `go` không có trong `PATH` của máy kiểm tra hiện tại, nên không thể xác nhận lại `go test`/`go vet` trong lần audit này. Không coi chúng là pass chỉ vì lệnh trả về trước đó trong log cũ.
- Không chạy worker Colab, không gửi token/API key thật và không thử gọi dịch vụ bên ngoài.

## Các phát hiện

| Mức | Phát hiện | Tác động chính |
|---|---|---|
| P0 | Pairing tự động đã bị ngắt hoàn toàn | Tính năng không thể dùng từ UI |
| P1 | Mở audio lịch sử tạo URL Windows sai | Nút **Mở** hỏng |
| P1 | Bộ lọc giá Gateway sai | Hiển thị/lọc model miễn phí sai |
| P1 | Gateway cho phép HTTP cùng API key | Rủi ro lộ khóa trên mạng |
| P1 | Timeout HTTP 90 giây dùng cho tác vụ GPU | Clone/generate dài dễ thất bại |
| P1 | Relay tự tải executable không kiểm tra toàn vẹn | Rủi ro chuỗi cung ứng khi bật lại |
| P2 | Quick Tunnel không có TTL sau khi mở | Endpoint công khai sống vô hạn trong phiên app |
| P2 | Lịch sử giới hạn metadata nhưng để lại audio mồ côi | Rò rỉ dung lượng/dữ liệu riêng tư |
| P2 | Tạo profile remote trước khi lưu backup cục bộ | Có thể tạo profile remote mồ côi/nhân đôi |
| P2 | Kéo-thả audio chuyển cả file thành base64 qua bridge | Tốn bộ nhớ, dễ treo WebView |
| P2 | Bridge TypeScript được khai báo lại thủ công | Dễ lệch hợp đồng Go–UI |
| P2 | Version, CI và kiểm thử chưa đủ cho release | Khó tái lập và khó chặn hồi quy |
| P2 | `App`/`App.tsx` quá nhiều trách nhiệm | Khó sửa an toàn, khó test protocol |

### P0 — Pairing tự động không có đường đi từ người dùng đến relay

`App.Startup` luôn gọi `unregisterPairingProtocol()` (`app.go:270-278`), còn `OpenColabNotebook` ghi rõ callback/custom URI đang tạm dừng và chỉ mở notebook thủ công (`app.go:336-344`). Trong UI, `beginColabPairing` cũng hướng người dùng sao chép URL/token từ Colab (`frontend/src/App.tsx:291-305`).

Trong khi đó, `startColabPairingRelay` chỉ được định nghĩa trong `pairing_relay.go:68-118`; tìm kiếm toàn repo không thấy nơi nào gọi nó. `registerPairingProtocol` cũng chỉ được định nghĩa ở `app.go:1142-1164`, trong khi helper `--pair` ở `main.go:18-25` chỉ có ý nghĩa nếu Windows protocol đã đăng ký. `ConsumeIncomingColabPairing` có binding nhưng wrapper ở `frontend/src/api.ts:175-176` không được import hay gọi từ `App.tsx`.

**Kết quả:** relay mới, protocol cũ, inbox và các test pairing đang tồn tại nhưng người dùng bản phát hành chỉ có manual pairing. Đây không phải lỗi UI nhỏ mà là một feature branch bị treo.

**Sửa đề xuất:** chọn một trong hai hướng trước khi release.

- **Hướng A — hoàn tất tự động:** thêm method Wails public `BeginColabPairing()`, gọi `startColabPairingRelay`, mở URL notebook trả về, poll hoặc nhận event `ConsumeIncomingColabPairing`, hiển thị trạng thái/Retry/Cancel. Thêm timeout hữu hạn và test end-to-end mock tunnel.
- **Hướng B — manual pairing ổn định:** bỏ relay, custom protocol, inbox và binding không dùng; cập nhật README/UI chỉ mô tả copy URL/token. Điều này làm bề mặt bảo mật nhỏ hơn đáng kể.

### P1 — `OpenHistoryAudio` tạo `file:` URL không hợp lệ trên Windows

Hàm tạo URL bằng `&url.URL{Scheme: "file", Path: path}` ở `app.go:1010-1018`. Với đường dẫn Windows như `C:\\Users\\...`, `url.URL.String()` biểu diễn ổ đĩa như authority và encode dấu `\\`, thay vì tạo dạng `file:///C:/Users/...`. Trình duyệt/Windows sẽ không coi đó là file local hợp lệ, nên nút **Mở** trong History có thể thất bại.

**Sửa đề xuất:** chuyển sang slash và thêm slash trước ổ đĩa, ví dụ `Path: "/" + filepath.ToSlash(path)`, sau đó test chính xác URI kết quả trên Windows. Nếu mục tiêu là mở bằng ứng dụng mặc định thay vì browser, dùng API shell/Wails phù hợp để mở path trực tiếp.

### P1 — `gatewayPricingIsFree` so sánh chuỗi thay vì số

Hàm chỉ nhận một vài literal `"0"`, `"0.0"`, `"0.00"`, `"0.000000"` (`app.go:771-783`). Vì vậy `"0.00000000"` hoặc `0e0` bị coi là có phí, còn giá trị chuỗi rỗng lại được bỏ qua và có thể dẫn đến kết luận model miễn phí. Điều này trái với mô tả ở `app.go:691-694` và UI ở `frontend/src/App.tsx:1486-1489`.

**Sửa đề xuất:** decode từng `json.RawMessage` sang `json.Number`/`big.Rat` hoặc `decimal`, từ chối giá trị rỗng/không parse được, rồi chỉ trả `true` khi mọi trường giá hợp lệ bằng 0. Bổ sung test cho `0.00000000`, `0e0`, number JSON `0`, chuỗi rỗng, giá âm và giá thiếu trường.

### P1 — API Gateway có thể nhận API key qua HTTP thường

Worker bắt buộc HTTPS, trừ localhost (`app.go:1576-1585`), nhưng `normalizeGatewayURL` chấp nhận mọi `http://` (`app.go:1588-1602`). Sau đó `ReviewTextWithGateway` gửi `Authorization: Bearer <API key>` (`app.go:641-647`) và `ListGatewayModels` cũng gửi key (`app.go:700-708`). Một URL custom HTTP vì thế có thể làm lộ key và nội dung review.

**Sửa đề xuất:** bắt buộc HTTPS; chỉ cho `http://localhost`, `127.0.0.1` hoặc `::1` khi có cờ development rõ ràng. Hiển thị cảnh báo không thể bỏ qua nếu người dùng cố dùng HTTP từ xa.

### P1 — Một timeout 90 giây dùng cho cả tác vụ nhanh lẫn GPU dài

`NewApp` tạo một `http.Client{Timeout: 90 * time.Second}` (`app.go:266-268`) và client này dùng cho health check, upload, import Drive, Gateway review lẫn `POST /generate` (`app.go:1455-1466`). Với văn bản tới 10.000 ký tự (`app.go:1413-1415`) hoặc Colab đang khởi động/tắc GPU, generation có thể bị client cắt sau 90 giây, dù UI còn hiển thị đồng hồ tiến độ.

**Sửa đề xuất:** tách client/timeout theo operation: health ngắn, download có read deadline, upload/generate dùng `context.Context` từ Wails với timeout dài hơn và nút Cancel. Không nên dùng một global timeout cho protocol GPU.

### P1 — Tự tải `cloudflared.exe` mà không xác minh hash/chữ ký

Relay tự tải executable từ URL `latest` (`pairing_relay.go:26-32`, `pairing_relay.go:237-289`), chỉ kiểm tra HTTP 200 và kích thước lớn hơn 1 MiB rồi chạy nó (`pairing_relay.go:292-305`). Không có SHA-256, Authenticode verification, version pinning hay xác nhận người dùng.

**Sửa đề xuất:** tốt nhất không tự tải executable trong app desktop. Yêu cầu cài `cloudflared` rõ ràng hoặc bundle một binary đã review/sign. Nếu buộc tải: pin version, tải checksum từ nguồn chính thức qua HTTPS, so sánh SHA-256, xác minh Authenticode và không xóa binary đang hoạt động trước khi file mới được xác thực.

### P2 — Quick Tunnel không có thời hạn sau khi tạo thành công

Relay chỉ dừng khi pairing thành công hoặc app shutdown (`pairing_relay.go:196-215`); không có timer TTL sau `startColabPairingRelay` (`pairing_relay.go:68-118`). Nếu người dùng bỏ dở, `trycloudflare.com` endpoint vẫn mở trong cả phiên app. Tài liệu Cloudflare nêu Quick Tunnel dành cho testing/development, còn production nên dùng remotely managed tunnel: [Quick Tunnels](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/trycloudflare/).

**Sửa đề xuất:** tạo relay với TTL 5–10 phút, hiển thị countdown và nút Cancel; sau khi hết hạn xóa nonce/pending session và kill process. Với tính năng production, cân nhắc relay hosted/managed tunnel có xác thực và audit log.

### P2 — Audio mồ côi sau khi lịch sử vượt 100 hoặc xóa file thất bại

Khi generate, file WAV được ghi trước (`app.go:1481-1488`) rồi metadata bị cắt còn 100 item (`app.go:1492-1497`). Các file của item bị cắt không bị xóa. Ngoài ra, `DeleteHistory` cố xóa file nhưng bỏ qua mọi lỗi từ `os.Remove` rồi vẫn bỏ metadata (`app.go:970-990`); `DeleteVoice` xử lý backup tương tự (`app.go:956-964`). Trên Windows, file đang được phát/mở có thể bị khóa, khiến UI báo đã xóa trong khi audio nhạy cảm vẫn còn trên ổ đĩa.

**Sửa đề xuất:** transactional delete: nếu file không xóa được, báo rõ và giữ metadata ở trạng thái `pending_delete`; khi vượt quota hãy xóa file trước, sau đó mới remove metadata. Thêm startup reconciliation để phát hiện/xóa/quarantine file mồ côi và hiển thị dung lượng History.

### P2 — Remote profile có thể được tạo nhưng local operation báo thất bại

`createVoiceFromFile` upload profile lên worker ở `app.go:1298-1301` rồi mới copy backup local tại `app.go:1303-1311`. Nếu ổ đĩa đầy, quyền thư mục lỗi hoặc ghi state thất bại, hàm trả lỗi nhưng không gọi DELETE profile remote. Lần retry có thể tạo bản clone remote trùng, trong khi người dùng chỉ thấy lỗi.

**Sửa đề xuất:** trước tiên reserve/ghi backup local an toàn, hoặc thực hiện compensating DELETE khi bước persistence lỗi. Dùng một `CreateProfile` result có trạng thái partial để UI hướng dẫn retry an toàn; thêm test lỗi `storeReference` và `saveStateLocked`.

### P2 — Kéo-thả 64 MiB audio qua base64 làm tăng mạnh bộ nhớ renderer

Frontend đọc cả file bằng `FileReader.readAsDataURL` (`frontend/src/App.tsx:341-363`), giữ chuỗi trong React state (`frontend/src/App.tsx:166-169`), rồi gửi qua bridge (`frontend/src/App.tsx:397-405`). Backend lại decode toàn bộ chuỗi vào `[]byte` (`app.go:851-860`). Với giới hạn 64 MiB (`frontend/src/App.tsx:330`), base64 đã xấp xỉ 85 MiB, chưa kể bản sao JavaScript/bridge/Go; WebView dễ lag hoặc hết bộ nhớ.

**Sửa đề xuất:** ưu tiên native file picker path; với drag-drop, dùng API drag của Wails trả path tạm/copy streaming, không đưa bytes qua JSON bridge. Hiển thị tiến độ sao chép và cancel.

### P2 — Hợp đồng Go–frontend bị nhân bản thủ công

Wails generated bindings đã tồn tại trong `frontend/wailsjs/`, nhưng UI định nghĩa lại toàn bộ `Window.go.main.App` và các type/method ở `frontend/src/api.ts:1-201`. Chính file này vẫn khai báo `ConsumeIncomingColabPairing` (`frontend/src/api.ts:124-126`, `:175-176`) dù UI không dùng nó. Khi Go API đổi, TypeScript có thể vẫn typecheck nhưng gọi sai/mất method ở runtime.

**Sửa đề xuất:** import generated bindings/models trực tiếp hoặc tạo một adapter mỏng chỉ re-export generated types. Thêm CI chạy `wails generate bindings` và fail nếu `git diff --exit-code frontend/wailsjs` có thay đổi.

### P2 — Version không có single source of truth; release pipeline chưa tồn tại

`VERSION` là `1.0.1.4`, Go hard-code cùng giá trị ở `app.go:287-290`, `blankBootstrap` lại hard-code ở `frontend/src/App.tsx:57-68`, trong khi `frontend/package.json:1-13` và lockfile dùng `1.0.0`. Không có mã nào đọc `VERSION`; `build/windows/info.json:1-14` chỉ là template chờ `Info.ProductVersion`. Kết quả là dễ phát hành binary/UI/npm metadata với version khác nhau.

Không có `.github/workflows`, package chỉ có `dev`, `build`, `typecheck` (`frontend/package.json:5-9`), không có lint/test frontend hay bước release/signing. README chỉ nêu lệnh thủ công (`README.md:20-33`) nên build chưa thực sự tái lập.

**Sửa đề xuất:** dùng một source `VERSION` hợp lệ SemVer (ví dụ `1.0.1` và build number tách riêng), đọc bằng `go:embed` hoặc inject `-ldflags -X`, truyền vào Bootstrap và Windows metadata lúc build. Thêm CI Windows: `npm ci`, typecheck/build, Go test/vet, Wails production build, kiểm tra binding, upload artifact. Tham khảo [GitHub Actions cho Go](https://docs.github.com/en/actions/tutorials/build-and-test-code/go).

### P2 — Kiến trúc hiện tại tạo điểm nghẽn bảo trì và thiếu seam test

`app.go` (~1.800 dòng) đồng thời quản lý Wails binding, state JSON, protocol worker, multipart upload, generation, documents, Drive, Gateway, Windows registry và pairing. `App` giữ concrete `*http.Client` (`app.go:42-52`, `:266-268`), nên test protocol phải dựa vào `httptest`/mutate field thay vì interface rõ ràng. `App.tsx` (~2.247 dòng) đồng thời giữ state, side effects, trang và component UI.

**Tách dần, không rewrite:**

```text
internal/worker/       Client, Health, Profiles, Generate; interface Transport
internal/library/      StateStore, references, history cleanup/reconciliation
internal/importer/     TXT/SRT/DOCX/PDF/Drive parser
internal/gateway/      OpenAI-compatible review + pricing parser
internal/pairing/      manual/relay strategy, lifecycle và security policy
internal/uiapi/        DTO + Wails-facing façade mỏng
frontend/src/features/ connection, library, studio, history, settings
frontend/src/lib/      generated bridge adapter, formatters, shared controls
```

Mỗi package mới cần unit test theo contract worker; app Wails chỉ compose dependencies. Đây sẽ giúp thay OmniVoice API, đổi storage hoặc thay pairing mà không chạm mọi vùng.

### P2 — Tài liệu chưa đủ để vận hành và hỗ trợ phát hành

README mô tả chức năng đúng ở mức cao (`README.md:5-18`) nhưng không nói rõ manual pairing là cách duy nhất đang hoạt động, worker protocol/version tương thích, các timeout/giới hạn file, vị trí dữ liệu local, hành vi dọn lịch sử, cách build Windows ký số hay cách báo lỗi. Điều này đặc biệt dễ làm người dùng tưởng notebook/relay tự ghép nối.

**Sửa đề xuất:** thêm mục “Kết nối Colab hiện tại” gồm ảnh/steps copy URL-token, “Dữ liệu local & xóa dữ liệu”, “Giới hạn”, “Troubleshooting”, “Build/release checklist” và ma trận version app–notebook–worker.

## Các điểm tốt đã xác nhận

- Worker URL chỉ chấp nhận HTTPS trừ localhost (`app.go:1576-1585`).
- State/reference/history được ghi với mode riêng tư và có recovery `.bak` (`app.go:1185-1239`).
- Token Colab/Gateway không thuộc `studioState` (`app.go:54-62`, `:231-240`).
- Import và generation có giới hạn kích thước (`app.go:29-35`, `:487-535`, `:1466-1474`).
- Go 1.24.13 được pin ở `go.mod`, cao hơn phiên bản vá cho advisory ZIP hiện tại; vẫn nên giữ toolchain cập nhật. Xem [Go vulnerability GO-2026-4342](https://pkg.go.dev/vuln/GO-2026-4342).
- Wails v2 vẫn là stable và tiếp tục nhận fixes; Wails v3 chưa phải lý do để dừng việc ổn định v2. Xem [Wails FAQ](https://v3.wails.io/faq/) và [migration guide](https://v3.wails.io/migration/v2-to-v3/).

## Lộ trình thực tế

### Sprint 1 — chặn lỗi phát hành

1. Quyết định/khắc phục pairing P0.
2. Sửa file URL, parser pricing, HTTPS Gateway và timeout operation-specific.
3. Bổ sung tests cho các lỗi trên, delete khi file lock và profile persistence failure.
4. Cập nhật README để không hứa pairing tự động.

### Sprint 2 — dữ liệu riêng tư và độ tin cậy

1. Transaction/reconciliation cho reference + history.
2. Streaming cho file import/drag-drop; progress/cancel cho clone/generate.
3. TTL/Cancel/telemetry tối thiểu cho pairing, hoặc xóa hẳn relay.
4. Bổ sung export audio, “open data folder”, dọn dung lượng theo quota và recovery state UI.

### Sprint 3 — phát triển bền vững

1. Tách `worker`, `library`, `gateway`, `importer`, `pairing` như sơ đồ trên.
2. Chuyển frontend sang feature modules và generated bindings.
3. Thiết lập CI/release Windows, version source duy nhất, SBOM/dependency update và code signing.
4. Chỉ đánh giá Wails v3 sau khi test suite/CI ổn định; v3 hiện cần migration có chủ đích, không phải hotfix.

## Gợi ý tính năng sau khi các lỗi P0/P1 được xử lý

- Wizard kết nối có diagnostics: GPU, URL, token, health, latency và retry rõ ràng.
- Hàng đợi generation có cancel, retry và giữ lịch sử lỗi không chứa token.
- Thư viện voice có tag, tìm kiếm, export/import backup được mã hóa tùy chọn.
- So sánh A/B nhiều tốc độ/steps và đánh dấu bản audio được duyệt.
- Luồng consent mạnh hơn: tên chủ giọng, ngày xác nhận, mục đích sử dụng và nút xóa toàn bộ dữ liệu liên quan.
- Accessibility pass: focus management, shortcut bàn phím, label cho trạng thái xử lý dài và kiểm tra tương phản light/dark.

## Tài liệu/kho mã tham khảo

- [Wails v2 → v3 migration](https://v3.wails.io/migration/v2-to-v3/) — tham khảo service architecture và binding mới; chưa cần migration ngay.
- [Cloudflare Quick Tunnels](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/trycloudflare/) và [cloudflared downloads](https://developers.cloudflare.com/tunnel/downloads/) — lifecycle/cài đặt tunnel.
- [cloudflared source](https://github.com/cloudflare/cloudflared) — tham khảo release packaging và quản lý connector.
- [Wails source/examples](https://github.com/wailsapp/wails) — tham khảo Wails build/bindings.
- [GitHub Actions: build and test Go](https://docs.github.com/en/actions/tutorials/build-and-test-code/go) — baseline CI cho Go.

