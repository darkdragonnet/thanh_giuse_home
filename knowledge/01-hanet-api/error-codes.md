# BẢNG ÁNH XẠ MÃ LỖI HANET CLOUD API & CHIẾN LƯỢC XỬ LÝ

Tài liệu này dùng cho `Worker Agent` và module xử lý hàng đợi để phân loại phản hồi từ HANET Cloud API:

| Mã lỗi | Constant Name | Có thể Retry? | Hành động của Hệ thống | Mô tả chi tiết |
| :---: | :--- | :---: | :--- | :--- |
| **`1`** | `SUCCESS` | — | Chuyển `status = 'success'`, lưu `person_id` & `face_url` | Đăng ký thành công |
| **`-1`** | `INVALID_INPUT_ERROR` | ❌ | Chuyển `status = 'manual_review'`, log chi tiết | Dữ liệu đầu vào không hợp lệ |
| **`-103`** | `ACCESS_TOKEN_EXPIRE` | ✅ | Kích hoạt ngay hàm refresh token, sau đó thử lại job | Token hết hạn |
| **`-2035`** | `PERMISSION_DENY` | ❌ | Cảnh báo Admin, chuyển `manual_review` | Tài khoản HANET bị từ chối quyền truy cập |
| **`-404`** | `UNSUPPORTED_ERROR` | ❌ | Chuyển `manual_review` (lỗi endpoint/code) | API không hỗ trợ phương thức này |
| **`-503`** | `SYSTEM_ERROR` | ✅ | Ném lỗi `HanetServiceUnavailableError`, BullMQ backoff 300s | Hệ thống HANET quá tải tạm thời |
| **`-909`** | `UPLOAD_FACE_ERROR` | ✅ | Cho phép thử lại 1 lần; nếu vẫn lỗi $\rightarrow$ `manual_review` | Tải ảnh lên CDN của HANET thất bại |
| **`-9002`** | `FILE_EXTENTION_ERROR` | ❌ | Chuyển `manual_review` | Định dạng file ảnh không đúng chuẩn |
| **`-9003`** | `REGISTER_ERROR` | ✅ | Cho phép thử lại tối đa 2 lần | Lỗi đăng ký nội bộ từ AI HANET |
| **`-9004`** | `REMOVE_ERROR` | ❌ | Ghi log, không thử lại | Lỗi khi xóa người |
| **`-9005`** | `EMPLOYEE_IS_EXISTS` | ❌ | Chuyển sang gọi API cập nhật ảnh thay vì đăng ký mới | Học sinh đã tồn tại trên địa điểm HANET |
| **`-9006`** | `IMG_INVALID` | ❌ | Chuyển ngay sang `manual_review` (KHÔNG retry) | Không tìm thấy khuôn mặt hoặc ảnh quá mờ |
| **`-9007`** | `IMG_DUPLICATE` | ❌ | Chuyển ngay sang `manual_review` (KHÔNG retry) | Khuôn mặt bị trùng khớp với người đã có |
| **`-9008`** | `FACE_ID_NOT_ENOUGH` | ❌ | **BÁO ĐỘNG KHẨN CẤP** qua Telegram/Email cho Admin | Hết hạn ngạch (quota) nhận diện của địa điểm |
| **`-5011`** | `PERSON_NOT_FOUND` | ❌ | Chuyển sang `manual_review` | Không tìm thấy `person_id` để cập nhật |

---

## Quy tắc chuyển trạng thái Circuit Breaker
* Nếu gặp mã lỗi `-503` liên tiếp 5 lần trong vòng 60 giây:
  * Ngắt mạch (*OPEN*).
  * Tạm dừng gọi HANET trong 300 giây (5 phút).
  * Sau 5 phút chuyển sang *HALF_OPEN*, cho phép 1 job thử nghiệm. Nếu thành công thì đóng mạch (*CLOSED*).
