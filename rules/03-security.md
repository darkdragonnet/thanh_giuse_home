# QUY CHUẨN BẢO MẬT HỆ THỐNG

## 1. Cơ chế Rate Limiting Đa tầng
* **Mặc định cho học sinh:** Tối đa **5 request / 5 phút trên 1 địa chỉ IP** (Lưu vết qua Redis Sliding Window).
* **Cơ chế Miễn trừ (Bypass Rate Limit):**
  * Admin: Có token xác thực hợp lệ.
  * Giáo viên hỗ trợ nạp ảnh hàng loạt cho lớp: Gửi kèm header `x-teacher-pin` hoặc query `teacher_pin` khớp với trường `token` trong bảng `classes`.
  * *Lưu ý:* Việc kiểm tra Bypass diễn ra tại tầng Middleware Backend, không hardcode tại Nginx để tránh lỗi khi người dùng sử dụng mạng 4G đổi IP liên tục.

## 2. Bảo mật Tải lên File & Ảnh
* Nginx chặn ngay từ cổng vào: `client_max_body_size 5M;`.
* API kiểm tra MIME-Type: Chỉ chấp nhận `image/jpeg` và `image/png`.
* Tên file lưu trên ổ đĩa được sinh ngẫu nhiên theo UUID/NanoID kết hợp timestamp: `${alias_id}_v${Date.now()}.jpg` (chống ghi đè và Cache-Busting).

## 3. Bảo mật URL Ảnh Tạm (`/tmp-faces/`)
* Phục vụ cho HANET `registerByUrl` tải ảnh trực tiếp từ Nginx.
* Tên file ảnh công khai tạm thời sử dụng mã token ngẫu nhiên kết hợp chữ ký HMAC ngắn hạn.
* File tạm tự động bị hủy hoặc Nginx chỉ cho phép tải trong vòng **10 phút** kể từ thời điểm phát hành job.

## 4. Quản lý Bí mật (Secrets Management)
* Tuyệt đối không commit tệp `.env` hoặc các khóa bí mật lên Git.
* Khóa bí mật API HANET (`client_id`, `client_secret`, `access_token`, `refresh_token`) được nạp qua biến môi trường hoặc lưu trữ trong bảng `settings` của PostgreSQL.
