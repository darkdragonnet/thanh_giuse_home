# ADR-002: Sử dụng Nginx Location Tạm Thời (`/tmp-faces/`) Cho HANET Tải Ảnh

## Trạng thái: ĐÃ PHÊ DUYỆT (ACCEPTED)

## Bối cảnh
API `registerByUrl` của HANET Cloud yêu cầu truyền vào một đường dẫn URL ảnh công khai (`file_url`) để AI của HANET tải về phân tích và trích xuất vector khuôn mặt. Cần giải pháp cung cấp URL mà không làm phát sinh chi phí Cloud Storage ngoài (như AWS S3 / Cloudflare R2).

## Quyết định
Sử dụng chính **Nginx Reverse Proxy** (`app_proxy`) để phục vụ đường dẫn ảnh tĩnh tạm thời tại `/tmp-faces/{token}.jpg` từ Docker Shared Volume (`shared_images_volume`).

## Hệ quả & Lợi ích
- **Chi phí & Phức tạp:** Zero cost, tận dụng container Nginx đã có sẵn trong cụm Docker.
- **Bảo mật:** Tên file chứa token ngẫu nhiên, chỉ mở trong vòng 10 phút để HANET tải về.
- **Dọn dẹp:** Sau khi HANET trả về `person_id` và lưu ảnh lên CDN của họ, file tạm được worker xóa bỏ.
