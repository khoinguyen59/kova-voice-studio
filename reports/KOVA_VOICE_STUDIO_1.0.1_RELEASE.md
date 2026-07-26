# KOVA Voice Studio 1.0.1 — Báo cáo hoàn thiện

Ngày kiểm tra: 2026-07-26  
Mục tiêu: hoàn tất các hạng mục còn dở, xử lý lỗi đã phát hiện, làm mới UI/UX, và tạo bản Windows dùng được.

## Kết quả

- Đã tạo production executable: `build/bin/KOVA-Voice-Studio.exe`.
- Kích thước: 12,194,304 bytes.
- SHA-256: `35DE7D1BA4CE8331B635AEC4FABAE6E9722CFBEA0AC3B136ADAC060441AFA99C`.
- Phiên bản ứng dụng: `1.0.1`, dùng chung cho `VERSION`, backend bootstrap và frontend metadata.

## Hạng mục đã hoàn tất

### Kết nối và bảo mật

- Đối chiếu notebook Colab thực tế: cell cuối chỉ in `KOVA_VOICE_URL` và `KOVA_VOICE_TOKEN`; không hề có callback về desktop. Đã bỏ luồng ghép cặp callback không thể hoạt động và ghi rõ luồng dán URL/token thủ công trong UI và README.
- URL Gateway từ xa bắt buộc HTTPS; chỉ `localhost` được phép HTTP để phát triển.
- Token worker và API key Gateway chỉ tồn tại trong phiên; không được ghi vào state cục bộ.
- Thay timeout HTTP toàn cục bằng timeout riêng theo tác vụ: health, yêu cầu worker, tải tài liệu, Gateway, upload profile và tạo audio.
- Chỉ gắn nhãn model “free” khi Gateway trả về giá trị số bằng 0 một cách rõ ràng; giá trị thiếu, sai định dạng hoặc khác 0 không bị đoán là miễn phí.

### Toàn vẹn dữ liệu

- Việc tạo profile có bù trừ: nếu sao lưu local/state thất bại sau khi upload, profile remote sẽ được dọn dẹp.
- Xóa profile/history không còn âm thầm bỏ qua lỗi file; metadata chỉ bị cập nhật khi thao tác cục bộ an toàn.
- Khi ứng dụng khởi động, file reference/history không còn được state tham chiếu sẽ được dọn dẹp. Lịch sử được giữ tối đa 100 mục mà không tạo orphan file.
- Mở audio lịch sử tạo `file:///C:/...` URL chuẩn trên Windows.
- Kéo-thả audio dùng cơ chế native Wails và đường dẫn file, không còn đưa cả file vào React dưới dạng Base64.

### UI/UX

- Giao diện mặc định là trắng, xanh dương và cyan gradient; trạng thái nền sáng không còn flash nền tối lúc khởi động.
- Nhận diện KOVA dùng logo chữ **K** gradient, card rõ cấp bậc, trạng thái kết nối dễ đọc, drop zone native và thông báo hướng dẫn kết nối theo notebook thực tế.
- Thêm chuyển động nhẹ cho waveform/card/button và hỗ trợ `prefers-reduced-motion`.
- Giữ dark mode tùy chọn, đồng thời cải thiện responsive layout và khoảng cách thao tác.

### Bảo trì và build

- Frontend gọi bindings Wails được sinh tự động thay vì duy trì danh sách bridge thủ công, giảm nguy cơ UI lệch API Go.
- Wails runtime và CLI đồng bộ ở `v2.12.0`, tương thích Go 1.24; loại bỏ cảnh báo bất tương thích lúc build.
- Đã thêm GitHub Actions Windows CI: `npm ci`, typecheck, production frontend build, `go vet`, test Go và build Wails.
- README đã có hướng dẫn chạy `.exe`, kết nối Colab, vị trí dữ liệu local và lệnh phát triển.

## Xác minh đã chạy

| Kiểm tra | Kết quả |
| --- | --- |
| `go vet ./...` | Pass |
| `go test ./... -count=1` | Pass |
| `npm ci` | Pass, 0 vulnerabilities được npm báo cáo |
| `npm run typecheck` | Pass |
| `npm run build` | Pass |
| Kiểm tra trực quan local UI | Pass: nền sáng gradient, logo K, hướng dẫn kết nối thủ công và desktop-preview fallback |
| `wails build -clean` | Pass, Windows/amd64 executable tạo thành công |

## Lưu ý vận hành

- File `.exe` hiện **chưa ký code-signing**. Windows SmartScreen có thể hiện cảnh báo khi phát hành công khai; cần chứng chỉ ký mã trước khi phân phối rộng rãi.
- Máy người dùng cần WebView2 Runtime (đa số Windows hiện đại đã có).
- Ứng dụng vẫn cần worker Colab do người dùng chạy; URL/token tunnel chỉ có hiệu lực trong phiên Colab đó và phải được dán thủ công.
- Chỉ dùng audio có sự cho phép của người nói. Dữ liệu profile, audio mẫu và lịch sử nằm local tại `%APPDATA%\KOVA Voice Studio` trừ khi đặt `KOVA_VOICE_STUDIO_DATA_DIR`.
