# KOVA Voice Studio 1.0.0.5 — refined overview surface

## Mục tiêu

Thay thế phần trang trí chuyển động, đặc biệt là các đường cong xoay ở hero, bằng một giao diện audio rõ ràng, tĩnh và dễ đọc hơn.

## Thay đổi

- Gỡ hoàn toàn hiệu ứng chuyển động ở icon/logo và hero cũ.
- Bỏ các vòng tròn, đường cong và nốt nhạc trang trí không gắn với thao tác.
- Thêm `Voice signal`: một bảng waveform tĩnh, hiển thị rõ trạng thái profile cục bộ sẵn sàng dùng lại.
- Giảm độ dày của glow, lưới nền, bóng đổ và hiệu ứng hover; panel không còn “nhảy” khi rê chuột.
- Giữ tương phản tốt ở cả dark/light theme, gồm sidebar và toàn bộ vùng nội dung.
- Tôn trọng `prefers-reduced-motion` của hệ điều hành.

## Tham chiếu thiết kế

Ngôn ngữ thiết kế được rút ra ở mức nguyên tắc: ưu tiên một không gian làm việc audio tập trung, phân cấp bằng typography/card rõ ràng và dùng waveform để biểu đạt nội dung. KOVA không sao chép tài sản, mã nguồn hay giao diện nguyên bản của ElevenLabs hoặc MiniMax.

## Xác minh

- `npm run build` (frontend)
- `go test ./... -count=1`
- `wails build -clean -o KOVA-Voice-Studio-1.0.0.5.exe`
