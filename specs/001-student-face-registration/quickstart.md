# Quickstart Validation Guide: Student Face Registration

Feature: `001-student-face-registration`  
Date: 2026-10-21  

Tài liệu này cung cấp các kịch bản kiểm thử chạy được ngay (runnable validation scenarios) nhằm chứng minh toàn bộ luồng đăng ký ảnh học sinh hoạt động chính xác từ đầu đến cuối theo đúng thiết kế và Hiến pháp.

---

## 1. Môi trường & Điều kiện Tiên quyết

1. **Khởi chạy Hạ tầng Docker**:
   ```bash
   docker compose up -d postgres redis
   ```
2. **Khởi chạy Mock HANET Cloud API**:
   ```bash
   cd apps/hanet-mock && npm run dev
   # Server lắng nghe tại http://localhost:5001
   ```
3. **Khởi chạy Fastify API Server & BullMQ Worker**:
   ```bash
   # Terminal 1: API Server
   cd apps/api && npm run dev
   # Lắng nghe tại http://localhost:3000

   # Terminal 2: Worker
   cd apps/worker && npm run dev
   ```

---

## 2. Kịch bản Kiểm chứng 1: Nộp ảnh Hợp lệ & Tiếp nhận Bất đồng bộ

**Mục tiêu**: Xác nhận ảnh gửi lên được tiếp nhận trong < 1.500 ms, DB chuyển sang `pending`, và job được đẩy vào BullMQ.

```bash
# Giả lập nộp ảnh chân dung cho Học sinh ID 1 (trạng thái ban đầu: empty)
curl -X POST http://localhost:3000/api/students/1/photo \
  -F "photo=@tests/fixtures/sample-face.jpg" \
  -i
```

**Kết quả mong đợi**:
- HTTP Status: `200 OK`
- Thời gian phản hồi: `< 1500 ms`
- Response Body:
  ```json
  {
    "success": true,
    "status": "pending",
    "queue_position": 1,
    "estimated_wait_minutes": 1,
    "message": "Đã tiếp nhận ảnh vào hàng đợi nền. Hệ thống đang đồng bộ theo nhịp an toàn."
  }
  ```

---

## 3. Kịch bản Kiểm chứng 2: Chống Xung đột Nộp Trùng (Atomic Race Condition)

**Mục tiêu**: Khi gửi 2 yêu cầu nộp ảnh đồng thời cho cùng 1 học sinh, chỉ 1 yêu cầu thành công; yêu cầu thứ 2 nhận HTTP 409 Conflict.

```bash
# Chạy 2 lệnh curl đồng thời cho Học sinh ID 2
curl -X POST http://localhost:3000/api/students/2/photo -F "photo=@tests/fixtures/sample-face.jpg" & \
curl -X POST http://localhost:3000/api/students/2/photo -F "photo=@tests/fixtures/sample-face.jpg" &
wait
```

**Kết quả mong đợi**:
- Một yêu cầu trả về: `200 OK`
- Một yêu cầu trả về: `409 Conflict` với thông báo:
  ```json
  {
    "statusCode": 409,
    "error": "Conflict",
    "message": "Hồ sơ đang trong hàng đợi xử lý hoặc không ở trạng thái được phép nộp ảnh"
  }
  ```

---

## 4. Kịch bản Kiểm chứng 3: Thăm dò Trạng thái (Short Polling 3s & Vị trí Hàng đợi)

**Mục tiêu**: Kiểm tra endpoint thăm dò trả về vị trí hàng đợi chính xác và không bị hết hạn phiên.

```bash
curl -X GET http://localhost:3000/api/students/1/status -i
```

**Kết quả mong đợi**:
- HTTP Status: `200 OK`
- Payload:
  ```json
  {
    "id": 1,
    "status": "pending",
    "queue_position": 1,
    "message": "Đang xếp hàng vị trí thứ 1 (nhịp đồng bộ 1 em/phút)"
  }
  ```

---

## 5. Kịch bản Kiểm chứng 4: Đồng bộ Theo Nhịp (1 request/phút) sang Mock HANET

**Mục tiêu**: Worker xử lý job theo nhịp điều tiết 1 req/phút, gọi mock HANET `registerByFace`, lưu `person_id` và cập nhật `status = 'success'`.

```bash
# Kiểm tra log của Worker
# Worker nhấc job -> Sharp resize 1280x736 -> Gọi HANET mock -> Update DB status: success

# Sau khi worker xử lý xong, gọi lại API status:
curl -X GET http://localhost:3000/api/students/1/status
```

**Kết quả mong đợi**:
```json
{
  "id": 1,
  "status": "success",
  "queue_position": null,
  "face_url": "https://cdn.hanet.ai/faces/person_123.jpg",
  "message": "Đăng ký khuôn mặt thành công"
}
```

---

## 6. Kịch bản Kiểm chứng 5: Phân quyền Giáo viên Miễn trừ Giới hạn (Teacher PIN Bypass)

**Mục tiêu**: Giáo viên nộp ảnh liên tục nhiều lần trên cùng 1 IP kèm mã PIN lớp học mà không bị chặn Rate Limit.

```bash
# Nộp liên tục 10 lần với header x-teacher-pin
for i in {1..10}; do
  curl -X POST http://localhost:3000/api/students/$i/photo \
    -H "x-teacher-pin: PIN_10A1_SECRET_789" \
    -F "photo=@tests/fixtures/sample-face.jpg" \
    -s -o /dev/null -w "Request $i: HTTP %{http_code}\n"
done
```

**Kết quả mong đợi**: Toàn bộ 10 request đều trả về `HTTP 200` (không có request nào dính `HTTP 429`).

---

## 7. Kịch bản Kiểm chứng 6: Cơ chế Cách ly Rà soát Thủ công (`manual_review`)

**Mục tiêu**: Học sinh ở trạng thái `manual_review` bị từ chối nộp qua cổng công khai; chỉ khi Admin can thiệp mở lại thì mới nộp được.

```bash
# 1. Cố tình nộp cho học sinh đang ở manual_review
curl -X POST http://localhost:3000/api/students/99/photo \
  -F "photo=@tests/fixtures/sample-face.jpg" -i
# Kết quả: HTTP 409 Conflict

# 2. Admin gọi API mở khóa (reset về empty)
curl -X POST http://localhost:3000/api/admin/students/99/unlock \
  -H "Authorization: Bearer ADMIN_SECRET_TOKEN" -i
# Kết quả: HTTP 200 OK (status chuyển về empty)

# 3. Học sinh nộp lại thành công
curl -X POST http://localhost:3000/api/students/99/photo \
  -F "photo=@tests/fixtures/sample-face.jpg" -i
# Kết quả: HTTP 200 OK (chuyển sang pending)
```
