# Đặc tả Tính năng: Trang Xem Sự Kiện Webhook Push (Phương án A — Chỉ xem, Không đổi hành vi)

## 1. Mục tiêu (Goals)
- Cung cấp trang quản trị Admin để xem lại toàn bộ các sự kiện push từ HANET Cloud đã nhận được tại endpoint `/api/webhooks/hanet`.
- Hỗ trợ ghi nhận đầy đủ 3 loại dữ liệu theo tài liệu tích hợp HANET Cloud:
  1. **Face Data**: `data_type = 'person'` (với `action_type`: `add`, `update`, `delete`).
  2. **Device Data**: `data_type = 'device'` (với `action_type`: `add`, `update`, `delete`).
  3. **Place Data**: `data_type = 'place'` (với `action_type`: `add`, `update`, `delete`).
- Lưu trữ lịch sử sự kiện với trạng thái kết quả xử lý (disposition), phục vụ công tác giám sát, kiểm toán và hỗ trợ vận hành.

## 2. Trạng thái Xử lý (Event Dispositions)
Mỗi sự kiện nhận được sẽ được gán một trong 5 giá trị disposition chính xác:
- `applied`: Đã áp dụng thay đổi vào cơ sở dữ liệu thành công theo logic hiện hành (áp dụng cho Face Data `person` add/update/delete khi không gặp exception).
- `deferred`: Kill Switch đang kích hoạt, việc xử lý được tạm hoãn và ghi log `WEBHOOK_DEFERRED` (giữ nguyên hành vi cũ).
- `invalid_hash`: Chữ ký hash MD5 trong payload không khớp với `HANET_CLIENT_SECRET` (trả mã HTTP 400 như cũ).
- `ignored`: Loại push hợp lệ nhưng hệ thống hiện tại chưa cấu hình logic nghiệp vụ xử lý chuyên biệt (áp dụng cho các push `device`, `place` hoặc các `data_type` khác; vẫn trả 200 SUCCESS như cũ).
- `failed`: Xử lý Face Data `person` gặp lỗi/ngoại lệ cơ sở dữ liệu (exception được bắt và ghi log, không làm sập server; trả 200 SUCCESS như cũ).

## 3. Ràng buộc & Giới hạn Ngoài phạm vi (Non-Goals)
- **KHÔNG** thay đổi logic nghiệp vụ xử lý person hiện hành (các câu lệnh UPDATE cho add, update, delete giữ nguyên từng ký tự).
- **KHÔNG** thêm logic xử lý nghiệp vụ cho device hoặc place (chỉ ghi nhận sự kiện vào bảng webhook_events và trả HTTP 200 như trước).
- **KHÔNG** thay đổi quy trình xác thực chữ ký hash (MD5 verification).
- **KHÔNG** thay đổi hành vi hoạt động của Kill Switch.
- **KHÔNG** tự động xóa học sinh trong cơ sở dữ liệu dưới bất kỳ trường hợp nào (khi delete person trên cloud, chỉ đánh dấu trạng thái `manual_review`).
- **KHÔNG** thay đổi mã HTTP trả về hoặc cấu trúc payload phản hồi cho HANET (luôn trả 200 `{ returnCode: 1, message: 'SUCCESS' }`, ngoại trừ sai hash trả 400 `{ returnCode: -1, message: 'INVALID_HASH' }`).
- Vệ sinh dữ liệu nhạy cảm: Trường `keycode` trong payload nếu có phải bị loại bỏ (đặt null) trước khi lưu vào cơ sở dữ liệu.
