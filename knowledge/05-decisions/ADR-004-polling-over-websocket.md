# ADR-004: Sử Dụng HTTP Short Polling Thay Vì WebSocket

## Trạng thái: ĐÃ PHÊ DUYỆT (ACCEPTED)

## Bối cảnh
Cần cập nhật trạng thái kết quả đăng ký khuôn mặt cho giao diện học sinh sau khi worker xử lý xong (khoảng 3–15 giây). Cần cân nhắc giữa WebSocket giữ kết nối liên tục và HTTP Polling.

## Quyết định
Sử dụng **HTTP Polling** mỗi **3 giây** (tối đa 5 phút) từ phía trình duyệt học sinh thay vì duy trì kết nối WebSocket.

## Hệ quả & Lợi ích
- **Tiết kiệm RAM & File Descriptors:** WebSocket yêu cầu giữ persistent connection, tốn socket và RAM trên Nginx và Node.js khi có hàng trăm kết nối cùng lúc.
- **Khả năng phục hồi:** Polling hoạt động cực kỳ ổn định trên mạng di động 4G/3G chập chờn mà không bị rớt socket hoặc reconnect phức tạp.
- **Hiệu năng:** Endpoint kiểm tra trạng thái học sinh `GET /students/:alias_id/status` chỉ đọc 1 bản ghi và được cache Redis nhẹ nhàng nếu cần.
