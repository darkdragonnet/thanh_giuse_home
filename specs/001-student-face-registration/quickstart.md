# Quickstart Validation Guide: Student Face Registration

Feature: `001-student-face-registration`  
Branch: `adopt-spec-kit` (Phase 8 Final Polish)  
Date: 2026-10-22  
Test Suite Status: **153/153 Tests Passing (22 Test Files)**

Tài liệu này cung cấp các kịch bản kiểm thử chạy được ngay (runnable validation scenarios) nhằm chứng minh toàn bộ luồng đăng ký ảnh học sinh hoạt động chính xác từ đầu đến cuối theo đúng thiết kế và Hiến pháp dự án.

---

## 1. Môi trường & Lệnh Chạy Toàn Bộ Test Suite

### 1.1. Khởi Chạy Hạ Tầng Local
1. **Khởi chạy CSDL & Redis qua Docker:**
   ```bash
   docker compose up -d postgres redis
   ```
2. **Khởi chạy Mock HANET Cloud API (Cổng 4000):**
   ```bash
   cd apps/hanet-mock && npm run dev
   # Hoặc dùng Docker profile: docker compose --profile mock up -d app_mock
   # Lắng nghe tại: http://localhost:4000
   ```
3. **Khởi chạy Fastify API Server & BullMQ Worker:**
   ```bash
   # Terminal 1: API Server
   cd apps/api && npm run dev
   # Lắng nghe tại http://localhost:3000

   # Terminal 2: Worker (Concurrency = 1)
   cd apps/worker && npm run dev
   ```

### 1.2. Chạy Toàn Bộ Bộ Kiểm Thử Tự Động (Full Regression)
```bash
# Chạy toàn bộ 153 test cases của dự án
npm test

# Chạy riêng kiểm thử trọn vẹn E2E Pipeline (T033)
npx vitest run tests/e2e-registration-pipeline.spec.ts

# Chạy 2 script kiểm chứng chính thức (T034)
npx tsx tests/verify-production-suite.ts
npx tsx tests/verify-3tier-error-handling.ts
```

---

## 2. Danh Mục Các Endpoint Chính & Trang Quản Trị

| Endpoint / URL | Phương Thức | Quyền Truy Cập | Mục Đích |
| :--- | :--- | :--- | :--- |
| `/api/students/:id/photo` | `POST` | Public / Teacher | Nộp ảnh học sinh (Multipart). Chặn trùng HTTP 409, Teacher PIN bypass rate limit |
| `/api/students/:id/status` | `GET` | Public | Tra cứu trạng thái nộp, vị trí hàng đợi và thời gian chờ ước tính (Polling 3s) |
| `/api/classes/:code/students` | `GET` | Public / Teacher | Danh sách học sinh theo lớp. Public chỉ nhận DTO tối thiểu; Teacher PIN nhận thêm cờ |
| `/api/public/classes` | `GET` | Public | Danh sách lớp học và tổng số liệu thống kê (Header X-Total-Students, X-Total-Success) |
| `/api/admin/settings/kill-switch` | `POST` | Admin Bearer Token | Bật / tắt cổng đăng ký khẩn cấp và tạm ngắt hàng đợi BullMQ |
| `/api/admin/students/manual-review` | `GET` | Admin Bearer Token | Lấy danh sách hồ sơ bị cô lập rà soát thủ công (lỗi -9006, -9005, retry exhausted) |
| `/api/admin/students/:id/unlock` | `POST` | Admin Bearer Token | Mở khóa hồ sơ cô lập về trạng thái `empty` kèm ghi chú Audit Log |
| `/admin/manual-review` | Web UI | Admin Session | Trang giao diện Rà soát & Phê duyệt Mở khóa (`ManualReviewApproval.tsx`) |
| `/admin/settings` | Web UI | Admin Session | Bảng điều khiển Chốt chặn Khẩn cấp & Kill Switch (`SystemSettings.tsx`) |

---

## 3. Kịch Bản 1: Nộp Ảnh Hợp Lệ & Tiếp Nhận Bất Đồng Bộ (< 1.500 ms)

**Mục tiêu**: Xác nhận ảnh gửi lên được tiếp nhận trong < 1.500 ms, DB chuyển sang `pending`, và job được đẩy vào BullMQ.

```bash
# Nộp ảnh chân dung cho Học sinh ID 1 (trạng thái ban đầu: empty)
curl -X POST http://localhost:3000/api/students/1/photo \
  -F "photo=@tests/fixtures/sample_face.jpg" \
  -i
```

**Kết quả mong đợi**:
- HTTP Status: `200 OK`
- Thời gian phản hồi: `< 1500 ms`
- Response Body:
  ```json
  {
    "success": true,
    "message": "Ảnh đã được tiếp nhận và đưa vào hàng đợi xử lý"
  }
  ```

---

## 4. Kịch Bản 2: Chống Xung Đột Nộp Trùng (Atomic Race Condition — HTTP 409)

**Mục tiêu**: Khi gửi 2 yêu cầu nộp ảnh đồng thời cho cùng 1 học sinh, chỉ 1 yêu cầu thành công; yêu cầu thứ 2 nhận HTTP 409 Conflict nhờ cơ chế khóa nguyên tử (`claimStudentForUpload`).

```bash
# Chạy 2 lệnh curl đồng thời cho Học sinh ID 2
curl -X POST http://localhost:3000/api/students/2/photo -F "photo=@tests/fixtures/sample_face.jpg" & \
curl -X POST http://localhost:3000/api/students/2/photo -F "photo=@tests/fixtures/sample_face.jpg" &
wait
```

**Kết quả mong đợi**:
- Một yêu cầu trả về: `200 OK`
- Một yêu cầu trả về: `409 Conflict` với thông báo:
  ```json
  {
    "statusCode": 409,
    "error": "Conflict",
    "message": "Học sinh này đã được đăng ký hoặc đang trong quá trình xử lý."
  }
  ```

---

## 5. Kịch Bản 3: Thăm Dò Trạng Thái (Short Polling 3s & Vị Trí Hàng Đợi)

**Mục tiêu**: Kiểm tra endpoint thăm dò trả về vị trí hàng đợi chính xác, thời gian ước tính, và **tuyệt đối không làm lộ thông tin nhạy cảm** (P0 Security: không có `face_url` hay `person_id`).

```bash
curl -X GET http://localhost:3000/api/students/1/status -i
```

**Kết quả mong đợi (Khi đang Pending)**:
- HTTP Status: `200 OK`
- Payload:
  ```json
  {
    "id": 1,
    "status": "pending",
    "queue_position": 1,
    "estimated_wait_minutes": 1,
    "message": "Đang xếp hàng vị trí thứ 1 (nhịp đồng bộ 1 em/phút)",
    "last_error_message": null
  }
  ```

---

## 6. Kịch Bản 4: Đồng Bộ Theo Nhịp Sang Mock HANET & Cập Nhật Success

**Mục tiêu**: Worker xử lý job theo nhịp điều tiết 1 req/phút, Sharp resize 1280x736, gọi mock HANET `registerByUrl`, lưu `person_id` và cập nhật `status = 'success'`.

```bash
# Sau khi Worker hoàn tất job, gọi lại API status:
curl -X GET http://localhost:3000/api/students/1/status
```

**Kết quả mong đợi**:
```json
{
  "id": 1,
  "status": "success",
  "queue_position": null,
  "estimated_wait_minutes": null,
  "message": "Đã hoàn tất đăng ký",
  "last_error_message": null
}
```

---

## 7. Kịch Bản 5: Phân Quyền Giáo Viên Miễn Trừ Giới Hạn (Teacher PIN Bypass)

**Mục tiêu**: Giáo viên nộp ảnh liên tục nhiều lần trên cùng 1 IP kèm mã PIN lớp học qua header `x-teacher-pin` mà không bị chặn Rate Limit.

```bash
# Nộp liên tục 10 lần với header x-teacher-pin hợp lệ
for i in {1..10}; do
  curl -X POST http://localhost:3000/api/students/$i/photo \
    -H "x-teacher-pin: PIN_TS1A_SECRET_123" \
    -F "photo=@tests/fixtures/sample_face.jpg" \
    -s -o /dev/null -w "Request $i: HTTP %{http_code}\n"
done
```

**Kết quả mong đợi**: Toàn bộ 10 request đều trả về `HTTP 200` (không dính lỗi `HTTP 429`).

---

## 8. Kịch Bản 6: Cơ Chế Cách Ly Rà Soát Thủ Công (`manual_review`) & Mở Khóa

**Mục tiêu**: Học sinh gặp lỗi AI -9006 được cách ly sang `manual_review`; xuất hiện trên trang Admin Rà soát Thủ công; Admin mở khóa đưa về `empty` để phụ huynh nộp lại.

```bash
# 1. Giả lập kịch bản -9006 trên Mock HANET
curl -X POST http://localhost:4000/mock/scenario \
  -H "Content-Type: application/json" \
  -d '{"scenario": "-9006", "hits": 1}'

# 2. Học sinh nộp ảnh -> Worker cách ly sang manual_review
curl -X POST http://localhost:3000/api/students/4/photo \
  -F "photo=@tests/fixtures/sample_face.jpg"

# 3. Admin tra cứu danh sách cô lập
curl -X GET http://localhost:3000/api/admin/students/manual-review \
  -H "Authorization: Bearer admin_secret_super_secure_token"

# 4. Admin mở khóa hồ sơ (reset về empty)
curl -X POST http://localhost:3000/api/admin/students/4/unlock \
  -H "Authorization: Bearer admin_secret_super_secure_token" \
  -H "Content-Type: application/json" \
  -d '{"notes": "Yêu cầu phụ huynh chụp lại ở nơi đủ sáng"}'

# Kết quả: HTTP 200 OK, status học sinh được đưa về empty an toàn
```
