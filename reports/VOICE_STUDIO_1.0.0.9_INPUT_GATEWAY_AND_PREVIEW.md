# KOVA Voice Studio 1.0.0.9 — nhập nội dung, AI Gateway và nghe mẫu giọng

## Phạm vi bản này

- Thêm nút **Mở Google Drive** bên cạnh **Nhập từ máy** trong Phòng thu. Nút gọi trình duyệt mặc định của Windows tới Google Drive; trình duyệt đó thường dùng lại phiên Chrome đang đăng nhập. Sau khi chọn tệp, người dùng tạo liên kết chia sẻ và dán vào ô kế bên để KOVA nhập TXT, SRT, MD, DOCX hoặc PDF.
- Tách AI Gateway thành hai chế độ rõ ràng:
  - **Model miễn phí có sẵn**: nhập URL/key Gateway của phiên hiện tại, bấm **Tải model miễn phí**, rồi chọn model bằng danh sách xổ xuống.
  - **Nhập API / model riêng**: URL, key và tên model độc lập cho Gateway/nhà cung cấp của người dùng.
- Thêm `GET /v1/models` cho Gateway tương thích OpenAI. Khi Gateway trả metadata `pricing`, KOVA chỉ đưa các model có toàn bộ giá trị bằng `0` vào danh sách miễn phí. Khi Gateway không công bố giá, KOVA vẫn liệt kê model nhưng ghi rõ là không thể xác nhận miễn phí — không đánh lừa người dùng về chi phí.
- Bổ sung **mũi tên phát/dừng** trên mỗi profile trong Thư viện giọng. Lần nhấn đầu tạo mẫu câu “Xin chào” bằng profile đó; kết quả được giữ trong phiên và lần sau bấm lại phát/dừng ngay. Việc này tái sử dụng profile đã clone, không tạo profile/clone giọng mới.

## Bảo mật và giới hạn có chủ đích

- URL và API key Gateway chỉ tồn tại trong phiên renderer, không được ghi vào thư viện profile hoặc file trạng thái.
- KOVA không nhúng API key bí mật hoặc tự nhận có Gateway trả phí. Danh sách miễn phí phản ánh đúng thông tin từ Gateway mà người dùng kết nối.
- Google Drive không yêu cầu KOVA xin OAuth hay truy cập toàn bộ Drive. KOVA chỉ tải đúng tệp mà người dùng chủ động chia sẻ qua liên kết.

## Kiểm thử đã chạy

- `npm run build` — TypeScript và Vite thành công.
- `go test ./... -count=1` — thành công, bao gồm hai test mới:
  - Gateway chỉ trả model có metadata giá bằng `0` vào danh sách miễn phí.
  - Gateway không có metadata giá không bị KOVA gắn nhãn miễn phí.

## Cách kiểm tra nhanh trong app

1. Vào **Phòng thu**, bấm **Mở Google Drive**; chọn/chia sẻ tệp trong trình duyệt rồi dán liên kết và bấm **Nhập Drive**.
2. Trong **AI Gateway · kiểm tra nội dung**, chọn **Model miễn phí có sẵn**, nhập endpoint/key, bấm **Tải model miễn phí**, chọn model trong dropdown, rồi bấm **Rà soát bằng AI**.
3. Nếu dùng nhà cung cấp/model riêng, chọn **Nhập API / model riêng** và điền ba trường độc lập.
4. Vào **Thư viện giọng**, bấm nút tròn `▶` trên card giọng đã lưu. Kết nối Colab worker phải đang hoạt động để tạo mẫu đầu tiên; sau đó cùng nút chuyển thành `❚❚` để dừng mẫu đang phát.
