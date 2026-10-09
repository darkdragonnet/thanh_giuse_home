# TÀI LIỆU ĐẶC TẢ KIẾN TRÚC HẠ TẦNG HỆ THỐNG
**Dự án:** Hệ thống Onboarding Đăng ký Khuôn mặt Học sinh tích hợp HANET Cloud  
**Mục tiêu quy mô:** 1.200 học sinh (Chiến dịch cao điểm trong 01 tháng)  
**Vai trò:** Infrastructure & System Architecture Blueprint

---

## 1. TỔNG QUAN TÀI NGUYÊN VẬT LÝ & DOCKER MATRIX

### 1.1. Thông số Phần cứng Máy chủ (VPS Ubuntu)
* **CPU:** 3 vCPU @ 2300 MHz
* **RAM:** 3072 MB (3.0 GB)
* **Storage:** 20 GB SSD
* **Swap Space:** 2.0 GB (`/swapfile`, `vm.swappiness = 10`)

### 1.2. Ma trận Giới hạn Tài nguyên Container (Resource Limits)
Toàn bộ frontend (Học sinh & Admin) được build thành static files và phục vụ trực tiếp qua Nginx để triệt tiêu chi phí RAM của container Node.js phía client.

| Container Name | Base Image | CPU Limit | RAM Reserve | RAM Limit | Vai trò & Cấu hình đặc tả |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **`app_proxy`** | `nginx:alpine` | 0.5 vCPU | 32 MB | **128 MB** | Reverse Proxy, SSL, phục vụ SPA Frontend, Rate Limiting. |
| **`app_postgres`**| `postgres:16-alpine` | 1.0 vCPU | 256 MB | **512 MB** | Source of Truth. `shared_buffers=128MB`, `max_connections=40`. |
| **`app_redis`** | `redis:7-alpine` | 0.5 vCPU | 64 MB | **192 MB** | Broker BullMQ, Rate Limiter. `maxmemory 128mb`, `noeviction`, AOF. |
| **`app_api`** | `node:20-alpine` | 1.0 vCPU | 128 MB | **512 MB** | Web API, xác thực PIN, Atomic DB, Enqueue. Node `--max-old-space-size=384`. |
| **`app_worker`** | `node:20-alpine` | 1.5 vCPU | 256 MB | **768 MB** | Queue Consumer (Concurrency=1), Sharp, Call HANET. `stop_grace_period: 150s`. |
| **TỔNG DOCKER** | — | — | **736 MB** | **2.112 MB** | **Dư ~500 MB RAM** cho OS Cache và Buffer an toàn. |

---

## 2. TOPOLOGY MẠNG & LUỒNG DỮ LIỆU TỔNG THỂ

```
[ Trình duyệt Học sinh / Mobile ]       [ Trình duyệt Admin / Desktop ]
                │                                       │
                └───────────────────┬───────────────────┘
                                    │ (HTTPS Port 443 / 80)
                                    ▼
         ┌─────────────────────────────────────────────────────┐
         │ app_proxy (Nginx Reverse Proxy)                     │
         │ - Phục vụ Static Files (SPA Student & Admin)        │
         │ - client_max_body_size: 5MB                         │
         │ - Chặn brute-force IP thô                           │
         └──────────────────────────┬──────────────────────────┘
                                    │ (proxy_pass: internal-net)
                                    ▼
         ┌─────────────────────────────────────────────────────┐
         │ app_api (Node.js API Server)                        │
         │ - Rate Limit Middleware (Redis Sliding Window)      │
         │ - Teacher PIN / Admin Session Bypass Check          │
         │ - Atomic DB Update Lock ('empty' -> 'pending')      │
         │ - Lưu ảnh tạm -> Docker Volume shared               │
         │ - Enqueue BullMQ Job (Idempotent JobID)             │
         │ - Phản hồi ngay 200 OK (Asynchronous Receipt)       │
         └──────────────┬──────────────────────────┬───────────┘
                        │                          │
                        ▼                          ▼
      ┌───────────────────────────┐      ┌───────────────────────────┐
      │ app_postgres (Postgres 16)│      │ app_redis (Redis 7 - AOF) │
      │ - classes, students,      │      │ - Queue: registrationQueue│
      │   logs, settings          │      │ - Rate Limiter Store      │
      └───────────────────────────┘      └─────────────┬─────────────┘
                                                       │
                                                       ▼ (Pull Job tuần tự: Concurrency = 1)
                                         ┌───────────────────────────┐
                                         │ app_worker (BullMQ Worker)│
                                         │ - Sharp: Resize 1280x736  │
                                         │ - Timeout: 120s / request │
                                         │ - Retry: -503 sau 300s    │
                                         │ - Circuit Breaker (Max 3) │
                                         └─────────────┬─────────────┘
                                                       │
                                                       ▼ (HTTPS External Call)
                                            [ HANET Cloud API ]
```

---

## 3. CƠ CHẾ PHÒNG VỆ, BẢO MẬT & RATE LIMITING

### 3.1. Phân tầng Rate Limiting (Redis Sliding Window)
* **Luật mặc định:** Áp dụng cho học sinh thông thường: **Tối đa 5 request / 5 phút trên một IP**.
* **Cơ chế Miễn trừ (Bypass Rate Limit):**
  * **Admin:** Có Session/Token đăng nhập hợp lệ.
  * **Giáo viên hỗ trợ:** Link đính kèm mã định danh lớp hợp lệ qua header `x-teacher-pin` hoặc query `teacher_pin` (khớp trường `token` trong bảng `classes`).
  * *Lưu ý:* Việc kiểm tra Bypass diễn ra tại **Backend Middleware**, không hardcode tại Nginx để tránh lỗi khi đổi IP động/4G.

### 3.2. Chốt chặn khẩn cấp (Global Kill-Switch & Class Locking)
1. **Toàn hệ thống:** Bảng `settings` chứa `registration_enabled: 'true'|'false'`. Middleware API từ chối toàn bộ request với HTTP `403 Registration Closed` khi cờ này chuyển `false`.
2. **Theo từng lớp:** Bảng `classes` chứa cờ `is_locked: boolean`. Khi lớp đủ chỉ tiêu hoặc giáo viên khóa lớp, API chặn nộp ảnh với HTTP `423 Locked`.

---

## 4. CHIẾN LƯỢC XỬ LÝ ẢNH & CHỐNG TRÀN BỘ NHỚ (OOM)

Nhằm đảm bảo an toàn tuyệt đối cho VPS 3GB RAM, áp dụng chiến lược **Hybrid 3 Tầng**:

1. **Tầng 1 (Client Pre-compression):**
   * Web học sinh dùng Canvas nén ảnh trước khi gửi: Cạnh dài tối đa **1920px**, format **JPEG chất lượng 0.85**.
   * File tải lên giảm từ 10MB xuống còn **400KB – 800KB** nhưng vẫn bảo toàn đầy đủ Facial Landmarks cho AI.
2. **Tầng 2 (Reverse Proxy Guard):**
   * Nginx giới hạn: `client_max_body_size 5M;`. Chặn đứng nguy cơ tấn công làm nghẽn băng thông.
3. **Tầng 3 (Worker Sharp Sequential Processing):**
   * Do `app_worker` chạy với `concurrency: 1`, Sharp chỉ nạp và giải nén đúng 1 ảnh tại một thời điểm vào RAM.
   * Worker đọc file từ Volume chia sẻ, resize chuẩn xác về **1280×736** (tỉ lệ chuẩn HANET), format JPEG, sau đó giải phóng bộ nhớ ngay lập tức. Mức tiêu thụ RAM của worker duy trì ổn định dưới 150MB.

---

## 5. MÔ HÌNH DỮ LIỆU & QUY CHUẨN TRẠNG THÁI (STATE MACHINE)

### 5.1. Bảng Dữ liệu Cơ sở (PostgreSQL)

```sql
-- 1. Bảng Lớp học
CREATE TABLE classes (
    id SERIAL PRIMARY KEY,
    code VARCHAR(50) UNIQUE NOT NULL,
    name VARCHAR(100) NOT NULL,
    teacher_name VARCHAR(100),
    token VARCHAR(64) NOT NULL,            -- Mã PIN giáo viên dùng để Bypass Rate Limit
    is_locked BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 2. Bảng Học sinh
CREATE TYPE student_status AS ENUM ('empty', 'pending', 'success', 'error', 'manual_review');

CREATE TABLE students (
    id SERIAL PRIMARY KEY,
    class_id INT REFERENCES classes(id) ON DELETE CASCADE,
    name VARCHAR(100) NOT NULL,
    alias_id VARCHAR(64) UNIQUE NOT NULL,   -- Mã định danh duy nhất ngẫu nhiên
    status student_status DEFAULT 'empty',
    person_id VARCHAR(100),                -- Do HANET Cloud cấp (Source of Truth)
    face_url TEXT,                         -- Link ảnh lưu trữ trên HANET CDN
    local_image_path TEXT,                 -- Đường dẫn file ảnh trên Docker Volume
    last_error_code VARCHAR(50),
    last_error_message TEXT,
    retry_count INT DEFAULT 0,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 3. Bảng Logs hoạt động
CREATE TABLE logs (
    id BIGSERIAL PRIMARY KEY,
    alias_id VARCHAR(64),
    class_id INT,
    action VARCHAR(50) NOT NULL,           -- REGISTER, UPDATE_PHOTO, MANUAL_OVERRIDE, RETRY
    result_code VARCHAR(50),
    result_message TEXT,
    ip VARCHAR(45),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 4. Bảng Cấu hình hệ thống (Kill Switch)
CREATE TABLE settings (
    key VARCHAR(50) PRIMARY KEY,
    value TEXT NOT NULL
);
```

### 5.2. Máy Trạng thái (State Machine) & Ràng buộc Cập nhật Nguyên tử (Atomic Update)

#### Vòng đời Trạng thái:
```
empty ---> [Nộp ảnh] ---> pending ---> [Worker HANET] ---> success (Nhận person_id, khóa)
                                                     ---> error / manual_review (>=3 lần lỗi)
```

#### Quy tắc Khóa nguyên tử (Atomic Conditional Update):
Ngăn chặn Race Condition khi hai học sinh bấm chọn cùng một tên hoặc bấm nộp liên tục:
```sql
UPDATE students 
SET 
  status = 'pending',
  local_image_path = :new_image_path,
  retry_count = 0,
  updated_at = NOW()
WHERE id = :student_id 
  AND status IN ('empty', 'error', 'manual_review')
RETURNING id, alias_id, person_id;
```
* **Nếu có bản ghi trả về:** Hợp lệ -> Đẩy job vào BullMQ -> Trả về HTTP 200 (Biên nhận).
* **Nếu không có bản ghi nào được cập nhật:** Trả về HTTP `409 Conflict: Bản ghi đang được xử lý hoặc đã hoàn tất`.

---

## 6. QUY CHUẨN HÀNG ĐỢI (BULLMQ WORKER SPECIFICATION)

### 6.1. Cấu hình Hàng đợi & Worker Engine
* **Queue Name:** `registration_queue`
* **Worker Concurrency:** `1` (Chạy tuần tự từng request đơn lẻ).
* **Timeout:** `120.000 ms` (2 phút). Quản lý qua `AbortSignal.timeout(120000)` tại tầng HTTP client.
* **Idempotent JobID:** Đặt `jobId: student_${alias_id}` để chống duplicate job trong Redis.
* **Shutdown Handler:** Khai báo `stop_grace_period: 150s` trong Docker Compose để cho phép worker hoàn tất trọn vẹn request 2 phút khi deploy CD.

### 6.2. Chiến lược Retry & Ngắt mạch (Circuit Breaker)
1. **Lỗi Quá tải từ HANET (`-503`):**
   * Worker ném lỗi tùy chỉnh `HanetServiceUnavailableError`.
   * Cấu hình BullMQ Backoff: `{ type: 'fixed', delay: 300000 }` (Chờ đúng 5 phút để thử lại).
2. **Ngắt mạch Cách ly (`manual_review`):**
   * Nếu gặp lỗi logic từ HANET (Không tìm thấy khuôn mặt, góc mặt sai quy chuẩn).
   * Hoặc số lần thử lại chạm ngưỡng: `retry_count >= 3`.
   * **Hành động:** 
     * Đánh dấu `status = 'manual_review'`.
     * Giữ nguyên ảnh tại `local_image_path`.
     * Gỡ bỏ job khỏi BullMQ, giải phóng worker cho học sinh tiếp theo.
3. **Cơ chế Admin Đổi ảnh (Ưu tiên):**
   * Job do Admin kích hoạt gắn tham số `{ priority: 1 }` (Job thường là `priority: 10`).
   * Payload chứa cờ `actionType: 'UPDATE_PHOTO'` và `personId`. Worker sẽ gọi API cập nhật ảnh vào `person_id` cũ.
   * File ảnh lưu theo cơ chế Cache-Busting: `${alias_id}_v${Date.now()}.jpg`.

---

## 7. QUY CHUẨN CI/CD & TRIỂN KHAI PRODUCTION

### 7.1. Pipeline GitHub Actions
```
[ Developer Push 'main' ]
          │
          ▼
┌────────────────────────────────────────────────────────┐
│ GitHub Actions CI Runner                               │
│ 1. Lint (`eslint`) & Typecheck (`tsc`)                 │
│ 2. Chạy Unit Tests kiểm tra logic hàng đợi & atomic db  │
│ 3. Build Docker Image Multi-stage (Node 20 Alpine)    │
│ 4. Push Image lên GitHub Container Registry (ghcr.io)  │
└─────────────────────────┬──────────────────────────────┘
                          │ (Kích hoạt SSH CD)
                          ▼
┌────────────────────────────────────────────────────────┐
│ Ubuntu VPS Target                                      │
│ 1. docker compose pull api-server queue-worker         │
│ 2. docker compose up -d --no-deps api-server           │
│ 3. docker compose up -d --no-deps queue-worker         │
│    (Chờ SIGTERM hoàn tất nhờ stop_grace_period: 150s)  │
│ 4. docker image prune -f                               │
└────────────────────────────────────────────────────────┘
```

---

## 8. SẴN SÀNG CHO GIAI ĐOẠN ROUTE & CONTROLLER (CHECKLIST)

Tài liệu này là tiền đề kỹ thuật trực tiếp để hiện thực hóa tầng logic ứng dụng:
* [x] **Middleware 1:** `killSwitchGuard` (Kiểm tra bảng `settings`).
* [x] **Middleware 2:** `classLockGuard` (Kiểm tra `is_locked` theo `class_id`).
* [x] **Middleware 3:** `rateLimitGuard` (Redis Sliding Window, kiểm tra bypass bằng `x-teacher-pin` hoặc `admin_session`).
* [x] **Student Route:** `GET /classes/:code/students` (Lấy danh sách, gắn cờ disabled cho tên `pending`/`success`).
* [x] **Registration Route:** `POST /students/:id/register` (Nhận file nén, Atomic Update, nạp BullMQ, trả về Fire-and-Forget receipt).
* [x] **Admin Route:** `POST /admin/students/:id/override-photo` (Đẩy job priority = 1 cập nhật ảnh cho `person_id` có sẵn).
* [x] **Worker Processor:** `registrationWorker.ts` (Sharp resize 1280x736, gọi HANET, bắt lỗi -503 và xử lý DLQ/manual_review).
