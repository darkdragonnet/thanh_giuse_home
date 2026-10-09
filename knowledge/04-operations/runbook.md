# RUNBOOK — QUY TRÌNH XỬ LÝ SỰ CỐ PRODUCTION

Tài liệu này cung cấp các kịch bản khắc phục sự cố nhanh cho kỹ sư SRE/DevOps khi vận hành:

---

## Sự cố 1: Hàng đợi dồn ứ (Queue Length > 100 Jobs)
* **Hiện tượng:** Học sinh phản ánh màn hình polling chờ lâu, Admin thấy số lượng job chờ tăng cao.
* **Nguyên nhân tiềm ẩn:**
  1. API HANET Cloud phản hồi chậm hoặc trả về `-503` liên tục kích hoạt backoff 5 phút.
  2. Worker bị treo hoặc container bị crash ngầm.
* **Quy trình xử lý:**
  1. Kiểm tra log của worker: `docker logs thanh_giuse_worker --tail 100`
  2. Kiểm tra độ dài hàng đợi trong Redis:
     `docker exec -it thanh_giuse_redis redis-cli -a <password> LLEN bull:registration_queue:wait`
  3. Nếu HANET Cloud bị tê liệt diện rộng:
     - Kích hoạt chốt chặn tạm dừng nộp ảnh:
       `docker exec -it thanh_giuse_postgres psql -U postgres_user -d thanh_giuse_db -c "UPDATE settings SET value='false' WHERE key='registration_enabled';"`
     - Thông báo học sinh quay lại sau.
  4. Khi HANET hoạt động bình thường trở lại, bật lại `registration_enabled = 'true'`.

---

## Sự cố 2: Worker bị OOM (Container Exit Code 137)
* **Hiện tượng:** Container `thanh_giuse_worker` tự khởi động lại liên tục, log Docker ghi nhận `Killed`.
* **Nguyên nhân:** Xử lý ảnh có độ phân giải quá lớn vượt ngưỡng RAM 768MB của worker.
* **Quy trình xử lý:**
  1. Tìm bản ghi và file ảnh gây lỗi gần nhất:
     `docker exec -it thanh_giuse_postgres psql -U postgres_user -d thanh_giuse_db -c "SELECT id, alias_id, local_image_path FROM students WHERE status='pending' ORDER BY updated_at DESC LIMIT 1;"`
  2. Chuyển học sinh này sang trạng thái `manual_review` để giải phóng hàng đợi:
     `docker exec -it thanh_giuse_postgres psql -U postgres_user -d thanh_giuse_db -c "UPDATE students SET status='manual_review', last_error_message='OOM crash' WHERE id=<ID>;"`
  3. Khởi động lại worker: `docker restart thanh_giuse_worker`.

---

## Sự cố 3: Đầy Ổ Cứng (Disk Full > 90%)
* **Hiện tượng:** API trả về lỗi `HTTP 507 Insufficient Storage`, database không ghi được WAL.
* **Quy trình xử lý:**
  1. Kiểm tra dung lượng: `df -h`
  2. Kiểm tra dung lượng thư mục uploads: `du -sh /var/lib/docker/volumes/thanh_giuse_shared_images_volume/_data`
  3. Xóa các file ảnh tạm đã hoàn tất có tuổi thọ > 7 ngày:
     `find /var/lib/docker/volumes/thanh_giuse_shared_images_volume/_data -type f -mtime +7 -delete`
  4. Thu dọn image Docker không dùng: `docker system prune -f`

---

## Sự cố 4: Token HANET Hết Hạn (Mã lỗi -103)
* **Hiện tượng:** 100% job trong worker đều thất bại với mã lỗi `-103 ACCESS_TOKEN_EXPIRE`.
* **Quy trình xử lý:**
  1. Kích hoạt lệnh refresh token thủ công:
     `docker exec -it thanh_giuse_api node -e "require('./dist/services/hanetTokenService').refreshToken()"`
  2. Hoặc cập nhật token mới lấy từ HANET Developer Portal trực tiếp vào DB:
     `docker exec -it thanh_giuse_postgres psql -U postgres_user -d thanh_giuse_db -c "UPDATE settings SET value='<NEW_ACCESS_TOKEN>' WHERE key='hanet_access_token';"`
  3. Khởi động lại worker để nạp token mới: `docker restart thanh_giuse_worker`.
