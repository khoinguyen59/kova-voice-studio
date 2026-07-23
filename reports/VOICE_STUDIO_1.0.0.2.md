# KOVA Voice Studio 1.0.0.2

## Luồng giọng tách biệt

1. **Thư viện giọng** tạo profile clone từ audio mẫu có xác nhận quyền sử dụng.
2. Profile lưu ID worker và bản sao audio mẫu cục bộ.
3. **Phòng thu** chỉ chọn profile đã lưu để nghe thử hoặc tạo audio. Không upload audio mẫu, không tạo clone mới trong luồng này.
4. Nếu Colab reset, app chỉ khôi phục profile từ bản sao cục bộ khi worker không còn profile đó.

## Theo dõi tác vụ

Clone, nghe thử và tạo audio đều có thẻ theo dõi riêng: giai đoạn đang chạy, phần trăm giai đoạn, trạng thái và đồng hồ thời gian thực cập nhật mỗi giây. Phần trăm là tiến độ giao thức giữa desktop và worker; nó không giả định có thể đọc tiến độ token nội bộ của OmniVoice.

## Ghép nối Colab một chạm

1. Mở KOVA Voice Studio trước.
2. Mở [Kova_Voice_Studio_GPU.ipynb](../../voice-studio/notebooks/Kova_Voice_Studio_GPU.ipynb) trên Colab và chọn GPU.
3. Chạy **Run all**.
4. Ở cell cuối, nhấn **Kết nối KOVA Voice Studio**.

Notebook gửi URL worker cùng mã ghép nối dùng một lần qua `kova-voice-studio://`. Desktop đổi mã qua HTTPS lấy token, kiểm tra worker và chỉ giữ token trong RAM của phiên hiện tại. Token không được lưu trong profile, lịch sử hay tệp cấu hình. Nhập URL/token thủ công vẫn là phương án dự phòng.

## Kiểm tra

- `go test ./... -count=1`
- `npm run build`
- `python -m pytest -q tests` trong `voice-studio`
- Kiểm tra JSON và cú pháp cell ghép nối của notebook.
