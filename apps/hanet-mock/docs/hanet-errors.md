# BẢNG TRA CỨU MÃ LỖI CHUẨN HANET CLOUD

Mọi phản hồi lỗi của HANET đều có mã `statusCode = 0` (hoặc `-1`), kèm `returnCode` âm và thông điệp tiếng Anh quy chuẩn:

| returnCode | returnMessage | Ý nghĩa thực tế |
| :---: | :--- | :--- |
| **`1`** | `SUCCESS` | Yêu cầu xử lý thành công trọn vẹn |
| **`-1`** | `INVALID_INPUT_ERROR` | Thiếu trường bắt buộc hoặc sai định dạng |
| **`-103`** | `ACCESS_TOKEN_EXPIRE` | Token truy cập đã hết hạn (Cần refresh) |
| **`-503`** | `SYSTEM_ERROR` | Máy chủ HANET quá tải (Cần Circuit Breaker & Backoff) |
| **`-909`** | `UPLOAD_FACE_ERROR` | Lỗi khi tải ảnh lên máy chủ CDN |
| **`-9002`** | `FILE_EXTENTION_ERROR` | Đuôi file ảnh không được hỗ trợ (chỉ nhận JPG/PNG) |
| **`-9003`** | `REGISTER_ERROR` | Lỗi thuật toán phân tích khuôn mặt |
| **`-9005`** | `EMPLOYEE_IS_EXISTS` | Học sinh/Nhân viên đã tồn tại trên địa điểm |
| **`-9006`** | `EMPLOYEE_REGISTER_IMG_INVALID_ERROR` | Ảnh không có khuôn mặt hoặc khuôn mặt quá mờ |
| **`-9007`** | `EMPLOYEE_REGISTER_IMG_DUPLICATE_ERROR` | Khuôn mặt bị trùng lặp với người khác đã có trên hệ thống |
| **`-9008`** | `FACE_ID_NOT_ENOUGH_ERROR` | Địa điểm đã hết dung lượng khuôn mặt đăng ký |
| **`-5011`** | `PERSON_NOT_FOUND` | Không tìm thấy mã học sinh/người này |
