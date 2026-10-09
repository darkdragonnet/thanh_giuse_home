# CONSTRAINTS — 6 ĐIỀU CẤM BẤT BIẾN

## C1. Tuyệt đối KHÔNG gọi ra HANET thật
Mock server không bao giờ được gửi request ra ngoài Internet (partner.hanet.ai). Mọi phản hồi phải được sinh ra tại chỗ từ bộ nhớ.

## C2. Cấu trúc Response phải khớp HANET 100%
Cấu trúc JSON phản hồi phải chuẩn xác từng trường theo tài liệu của HANET:
```json
{
  "statusCode": 0,
  "returnCode": 1,
  "returnMessage": "SUCCESS",
  "data": { ... }
}
```
Tuyệt đối KHÔNG được tự ý thêm trường lạ, KHÔNG được đổi tên trường (ví dụ: `returnCode` không được đổi thành `code` hay `status`).

## C3. Luôn trả HTTP 200 OK
Đặc thù của HANET Cloud Open API là **luôn trả về mã trạng thái HTTP 200**, ngay cả khi nghiệp vụ thất bại (ví dụ: `returnCode = -503`, `returnCode = -103`, hay `returnCode = -9006`).
Tuyệt đối KHÔNG được trả về mã HTTP 4xx hoặc 5xx cho các lỗi nghiệp vụ này.

## C4. Hỗ trợ đúng 2 định dạng Content-Type
* Các endpoint truyền tham số URL/Text: Bắt buộc parse được `application/x-www-form-urlencoded` (hỗ trợ tiếng Việt có dấu qua UTF-8).
* Các endpoint upload ảnh file nhị phân: Bắt buộc parse được `multipart/form-data`.

## C5. Scenario phải điều khiển được ở thời gian thực (Runtime)
Không được hard-code cố định kịch bản. Người kiểm thử phải có quyền thay đổi kịch bản trả về của mock server theo từng request hoặc toàn cục mà không cần khởi động lại container.

## C6. Bộ nhớ phải xóa trắng được (Idempotent Reset)
Phải cung cấp endpoint quản trị nội bộ `DELETE /mock/reset` để xóa sạch dữ liệu học sinh mẫu đã đăng ký và đưa toàn bộ kịch bản về mặc định.
