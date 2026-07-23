# KOVA Voice Studio 1.0.0.3

## Mục tiêu bản này

Nâng chất lượng clone giọng, mở rộng Phòng thu thành nơi soạn thảo/kiểm tra nội dung, và làm rõ quyền kiểm soát của người dùng trước khi tạo audio.

## Đã bổ sung

- Tách giọng khỏi nhạc bắt buộc trước khi tạo profile clone.
  - Worker Colab chạy Demucs `htdemucs --two-stems vocals --device cuda`.
  - Chỉ stem `vocals.wav` được đưa cho OmniVoice và được lưu ở worker.
  - Nếu tách thất bại hoặc quá năm phút, profile không được tạo để tránh clone lẫn nhạc.
  - Desktop hiển thị giai đoạn `separate_voice_music` trong thanh tiến độ và giải thích rõ cơ chế trong Thư viện giọng.
- Ba preset văn bản nghe thử: Ngắn (~15 giây), Vừa (~45 giây), Dài (~2 phút), có cho cả tiếng Việt và English. Mẫu luôn có thể sửa tự do.
- Phòng thu có thể nhập TXT, SRT, MD, DOCX và PDF từ máy.
  - TXT/MD đọc trực tiếp; SRT bỏ số cue và timestamp để thành nội dung đọc; DOCX/PDF trích xuất text cục bộ.
  - Có ô nhập link chia sẻ Google Drive cho các file public/shareable. Đây không yêu cầu hay lưu OAuth/Drive token; file riêng tư phải tải về máy rồi chọn bằng file picker.
- AI Gateway Review cho text nhập, nội dung soạn, hoặc tài liệu đã import.
  - Gửi yêu cầu OpenAI-compatible `POST /v1/chat/completions` với model do người dùng nhập/chọn.
  - Rà soát logic, ngữ cảnh, chính tả và dấu câu; trả về `revised_text`, tóm tắt, cảnh báo.
  - Kết quả chỉ xuất hiện ở vùng xem lại. Bản gốc không bị tự thay thế; người dùng phải bấm **Áp dụng bản AI**.
  - URL/key gateway chỉ ở bộ nhớ của phiên UI, không nằm trong `studio-state.json` hoặc thư viện giọng.
- Giao diện tối/sáng/hệ thống và chọn Tiếng Việt/English trong Cấu hình; lựa chọn được lưu cho lần mở sau.
- Giao diện cập nhật với panel glass, gradient công nghệ, chuyển động waveform/orb nhẹ, preset dạng thẻ có phản hồi hover, vùng import và review rõ ràng.

## Luồng clone giọng được giữ tách biệt

1. **Thư viện giọng:** đặt tên, chọn audio mẫu, xác nhận quyền sử dụng, worker tách voice/music, tạo và lưu profile.
2. **Phòng thu:** chỉ chọn profile đã lưu, nhập/chỉnh nội dung, nghe thử hoặc tạo audio. Phòng thu không tạo clone lại.
3. Audio mẫu được sao lưu riêng tư trên máy; nếu Colab reset, KOVA có thể dùng bản sao để khôi phục profile khi tạo audio lần sau.

## Kiểm chứng đã chạy

- `go test ./... -count=1`: pass, gồm kiểm tra backup clone, pairing session-only, trích SRT/Drive ID, và fake AI Gateway response.
- `npm run build` trong `frontend`: pass.
- `PYTHONPATH=../voice-studio/src python -m pytest -q ../voice-studio/tests`: 5 passed.

## Lưu ý vận hành

- Tách vocal bằng Demucs cần Colab GPU CUDA. Nó cố ý dừng khi không tách được; đây là bảo vệ chất lượng clone, không phải CPU fallback.
- PDF scan ảnh không có lớp text sẽ không trích xuất được nội dung. Cần OCR trước hoặc dùng PDF có text.
- Google Drive import chỉ hỗ trợ file đã bật chia sẻ qua link. Không có token Google Drive trong KOVA.
- AI Gateway có thể trả kết quả sai hoặc thay đổi sắc thái; luôn đọc phần cảnh báo và bản đề xuất trước khi bấm áp dụng.
