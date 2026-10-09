# QUY CHUẨN LẬP TRÌNH (CODING STANDARDS)

## 1. Công nghệ Cốt lõi
* **Runtime:** Node.js 20 LTS (Alpine base) với TypeScript strict mode.
* **API Framework:** **Fastify 4+** (nhanh, tiêu tốn ít bộ nhớ, tích hợp sẵn schema validation).
* **Database Driver:** `pg` (Pool client) kết hợp câu lệnh SQL thuần (*Parameterized Queries*) hoặc query builder siêu nhẹ (Kysely), **không dùng ORM**.
* **Hàng đợi:** BullMQ kết hợp `ioredis`.
* **Xử lý đồ họa:** `sharp` (cấu hình giải phóng RAM ngay sau khi sinh buffer).

## 2. Quy tắc Viết API & Xử lý Yêu cầu
* **Schema Validation bắt buộc:** Mọi route Fastify đều phải khai báo JSON Schema cho `params`, `query`, `body`, và `response`.
* **Parameterized Queries:** Mọi câu lệnh SQL phải dùng `$1, $2, ...`. Tuyệt đối cấm nối chuỗi SQL (*SQL Injection*).
* **Chuẩn Định dạng Phản hồi (Standard Response Format):**
  ```typescript
  // Thành công:
  { "success": true, "data": { ... } }

  // Thất bại:
  { "success": false, "error": { "code": "STUDENT_LOCKED", "message": "Lớp học đã bị khóa" } }
  ```
* **Thứ tự Middleware bắt buộc:**
  1. `killSwitchGuard`: Kiểm tra cờ hệ thống `registration_enabled` trong bảng `settings`.
  2. `classLockGuard`: Kiểm tra cờ `is_locked` trong bảng `classes`.
  3. `rateLimitGuard`: Redis Sliding Window (có kiểm tra bypass bằng `x-teacher-pin` hoặc `admin_session`).
  4. Controller Handler: Xử lý nghiệp vụ chính.

## 3. Quản lý Lỗi & Logging
* Ghi log theo định dạng **JSON có cấu trúc ra stdout** để Docker logging driver thu gom (không ghi log ra file đĩa để chống đầy ổ cứng).
* Bắt buộc có mã định danh truy vết (*Request ID / Trace ID*) trong mọi log entry.
