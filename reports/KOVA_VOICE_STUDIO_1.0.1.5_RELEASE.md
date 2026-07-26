# KOVA Voice Studio 1.0.1.5 — Báo cáo phát hành

Ngày build: 2026-07-27

## Thay đổi

- Hero trên trang Tổng quan có dãy sóng SVG hai lớp uốn lượn ngang liên tục, chạy đều 20 giây mỗi vòng (28 giây ở môi trường reduced-motion để hiệu ứng vẫn hiện rất nhẹ).
- Chuẩn hóa quy tắc phiên bản KOVA: `x.y.z.0` đến `x.y.z.9`; sau `1.0.1.9` là `1.0.2.0`, không dùng `1.0.1.10`.
- Bổ sung test kiểm tra format phiên bản bốn phần và script đóng gói Windows kiểm tra quy tắc này trước khi phát hành.
- Wails vẫn build tạm vào `build/bin/`, sau đó hook tự chuyển artifact cuối về trực tiếp `build/KOVA-Voice-Studio-<version>.exe`.

## Artifact đã xác minh

- File: `build/KOVA-Voice-Studio-1.0.1.5.exe`
- Kích thước: 12,195,840 bytes
- SHA-256: `997FC8F1EDFB2BD7EE75F4DCD73E5A8FA07D34B8CCFD5BDDD45D5610107F5152`
- `build/bin/KOVA-Voice-Studio.exe`: không tồn tại sau đóng gói.

## Kiểm tra

- `npm run typecheck` và `npm run build`: pass.
- `wails build -clean`: pass; post-build packaging hook chạy thành công.
- Kiểm tra cục bộ UI: hai path sóng tồn tại và animation `hero-wave-drift` chạy lặp vô hạn.
