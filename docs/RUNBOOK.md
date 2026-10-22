# SỔ TAY VẬN HÀNH HỆ THỐNG (OPERATIONAL RUNBOOK)
## Hệ Thống Onboarding Đăng Ký Khuôn Mặt Học Sinh — Tích Hợp HANET Cloud

*Tài liệu chuẩn hóa dành cho Quản trị viên (DevOps / System Administrator / Admin Giáo xứ)*  
*Thời gian cập nhật: 22/10/2026 — Phiên bản đối soát: adopt-spec-kit (Phase 8)*

---

## 1. Kiến Trúc Tổng Thể & Ma Trận Giới Hạn Tài Nguyên (RAM Limit)

Hệ thống được thiết kế chạy trên VPS Ubuntu 3 vCPU, 3.0 GB RAM, 20 GB SSD, 2.0 GB Swap theo chuẩn Docker Compose (`docker/docker-compose.yml`). Tổng trần RAM của toàn bộ container được giới hạn cứng ở mức **2.112 MB** (bảo đảm an toàn tuyệt đối cho OS và Swap).

```
[ Khách / Học Sinh / Giáo Viên ]
              │
              ▼  (Port 80/443 -> Proxy:8090)
 ┌─────────────────────────────────────────────────────────────┐
 │ thanh_giuse_proxy (Nginx Reverse Proxy & Static SPA)        │
 │ RAM Limit: 128 MB | Caches /tmp-faces with No-Cache         │
 └──────────────┬───────────────────────────────┬──────────────┘
                │ /api                          │ /tmp-faces
                ▼                               ▼
 ┌──────────────────────────────┐  ┌───────────────────────────┐
 │ thanh_giuse_api              │  │ Shared Uploads Volume     │
 │ Node.js Fastify Port 3000    │  │ /app/uploads/tmp-faces/   │
 │ RAM Limit: 512 MB            │  └─────────────▲─────────────┘
 │ NODE_OPTIONS: --max-old-space│                │
 │ -size=384                    │                │ Ảnh resize
 └──────────────┬───────────────┘                │ 1280x736
                │ Job Enqueue                    │
                ▼                                │
 ┌──────────────────────────────┐                │
 │ thanh_giuse_redis            │                │
 │ Redis 7 AOF Port 6379        │                │
 │ RAM Limit: 192 MB            │                │
 └──────────────┬───────────────┘                │
                │ BullMQ registration_queue      │
                ▼                                │
 ┌───────────────────────────────────────────────┴─────────────┐
 │ thanh_giuse_worker (BullMQ Background Worker)               │
 │ Concurrency = 1 (Bất biến) | RAM Limit: 768 MB              │
 │ NODE_OPTIONS: --max-old-space-size=512                      │
 │ stop_grace_period: 150s                                     │
 └──────────────┬───────────────────────────────┬──────────────┘
                │ Kysely / Pool                 │ HANET Cloud Open API
                ▼                               ▼ (partner.hanet.ai)
 ┌──────────────────────────────┐  ┌───────────────────────────┐
 │ thanh_giuse_postgres         │  │ HANET Cloud               │
 │ PostgreSQL 16 Alpine         │  │ (or Mock at port 4000)    │
 │ RAM Limit: 512 MB            │  └───────────────────────────┘
 └──────────────────────────────┘
```

### Bảng Phân Bổ RAM Chi Tiết (Container Hard Limits)

| Container Name | Service | Image / Base | RAM Limit | RAM Reservation | CPU Limit | Ghi Chú Đặc Biệt |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| `thanh_giuse_proxy` | Nginx Proxy | Custom Alpine | **128 MB** | 32 MB | 0.5 vCPU | Chặn cache `no-store` cho `/tmp-faces/`, tải tĩnh SPA |
| `thanh_giuse_postgres` | Database | `postgres:16-alpine` | **512 MB** | 256 MB | 1.0 vCPU | `shared_buffers=128MB`, `max_connections=40`, `work_mem=4MB` |
| `thanh_giuse_redis` | Queue & Cache | `redis:7-alpine` | **192 MB** | 64 MB | 0.5 vCPU | AOF persistence, lưu session rate limit & trạng thái Kill Switch |
| `thanh_giuse_api` | REST API | Node.js 20 Fastify | **512 MB** | 128 MB | 1.0 vCPU | `NODE_OPTIONS="--max-old-space-size=384"`, tiếp nhận upload |
| `thanh_giuse_worker` | Queue Worker | Node.js 20 Worker | **768 MB** | 256 MB | 1.5 vCPU | `NODE_OPTIONS="--max-old-space-size=512"`, Concurrency = 1, Sharp RAM safe |
| **TỔNG CỘNG** | **5 Containers** | — | **2.112 MB** | 736 MB | — | **An toàn dưới ngưỡng 3.0 GB RAM của VPS** |

---

## 2. Vận Hành Hàng Đợi (BullMQ Queue Operation)

### 2.1. Nhịp Điều Tiết (Rate Limiter)
- **Cấu hình nhịp:** Đọc từ CSDL bảng `settings` thông qua khóa `hanet_sync_rate_limit`.
  - Mặc định: `1` request/phút (`limiter: { max: 1, duration: 60000 }` tại `apps/worker/src/workerOptions.ts`).
  - Mục đích: Bảo vệ hạn mức gọi API đám mây của HANET, tránh lỗi 429 và nghẽn mạng ngoại vi.
- **Worker Concurrency = 1:** Worker chỉ xử lý duy nhất 1 job tại một thời điểm (`concurrency: 1`), kết hợp vô hiệu hóa cache Sharp (`sharp.cache(false)`) và `sharp.concurrency(1)` để tránh tràn RAM khi resize ảnh độ phân giải cao lên 1280x736.

### 2.2. Tính Toán Vị Trí Hàng Đợi & Dự Kiến Chờ (Queue Position Calculation)
Tại endpoint `GET /api/students/:id/status` (`apps/api/src/routes/status.ts`):
1. **Truy vấn BullMQ:**
   - Kiểm tra số lượng job đang chạy (`activeJobs.length`).
   - Đếm số lượng job xếp hàng phía trước (gồm các job `waiting` và `delayed`).
   - Công thức: `queuePosition = hasActiveRunning + aheadCount + 1`.
2. **Fallback CSDL (Khi Redis bị ngắt kết nối hoặc job không tìm thấy):**
   - Đếm số học sinh đang `pending` có thời điểm cập nhật trước học sinh hiện tại:
     ```sql
     SELECT COUNT(*)::int AS count FROM students
     WHERE status = 'pending' AND (updated_at < $1 OR (updated_at = $1 AND id < $2));
     ```
   - `queuePosition = count + 1`.
3. **Thời gian ước tính:** `estimatedWaitMinutes = Math.ceil(queuePosition / syncRateLimit)`.
4. **Bảo toàn trạng thái:** Học sinh ở trạng thái `pending` **không bao giờ bị hết hạn tự động** (Session non-expiring), phụ huynh có thể đóng trình duyệt và quay lại tra cứu vị trí bất kỳ lúc nào.

---

## 3. Quy Trình Chốt Chặn Khẩn Cấp (Kill Switch Protocol)

### 3.1. Điều Kiện Kích Hoạt Tự Động (Triggers)
Hệ thống tự động kích hoạt Kill Switch khi Worker nhận một trong các mã lỗi nghiêm trọng từ HANET:
1. **Lỗi Token Hết Hạn hoặc Sai Lệch (`-103` ACCESS_TOKEN_EXPIRE hoặc `-401` UNAUTHORIZED):**
   - Xảy ra khi token nhà phát triển của HANET hết hạn (thường sau 30-90 ngày) hoặc bị thu hồi.
2. **Lỗi Cạn Hạn Mức Face ID (`-9008` TOTAL_FACE_ID_NOT_ENOUGH_ERROR):**
   - Xảy ra khi tài khoản HANET Cloud không còn chỗ trống để đăng ký thêm khuôn mặt.

### 3.2. Cơ Chế Tự Động Thực Thi của Hệ Thống
Khi xảy ra lỗi token hoặc quota:
1. Worker gọi `pauseWorker()` -> Tạm ngắt tiêu thụ hàng đợi (`registrationWorker.pause()`).
2. Ghi cờ khóa khẩn cấp vào Redis:
   - `system:registration_disabled = '1'`
   - `setting:kill_switch = 'true'`
   - `setting:maintenance_message = 'Hệ thống đang tạm bảo trì kết nối đám mây...'`
3. Ghi trạng thái khóa vào PostgreSQL:
   - `UPDATE settings SET value = 'false' WHERE key = 'registration_enabled'`.
4. Ném lỗi `UnrecoverableError` để BullMQ không retry mù quáng làm spam log.
5. **BẢO VỆ HỌC SINH:** Học sinh gặp lỗi token `-103` hoặc `-401` **được giữ nguyên trạng thái `pending`**, tuyệt đối **KHÔNG bị đánh trượt sang `manual_review`** hay `error`.

### 3.3. Các Bước Admin Cần Thực Hiện Khi Kill Switch Ngắt

Khi nhận thông báo Kill Switch đã bật:

#### Bước 1: Lấy Access Token Mới từ HANET
Đăng nhập cổng đối tác HANET Cloud (https://partner.hanet.ai), lấy OAuth Access Token mới có hiệu lực.

#### Bước 2: Cập Nhật Biến Môi Trường trên VPS
Truy cập VPS qua SSH và cập nhật tệp cấu hình `.env`:
```bash
ssh user@vps-ip
cd /path/to/thanh_Giuse
nano .env
# Thay đổi dòng HANET_ACCESS_TOKEN=<token_mới>
```

#### Bước 3: Khởi Động Lại API & Worker
Áp dụng cấu hình mới vào container mà không ảnh hưởng tới DB và Redis:
```bash
docker compose restart app_api app_worker
```

#### Bước 4: Mở Lại Cổng Đăng Ký & Tự Động Requeue Học Sinh Bị Kẹt
Có thể thực hiện qua Giao diện hoặc Gọi API:
- **Cách 1 (Giao diện Quản trị):**
  1. Truy cập `https://thanhgiuse.gaudetedomino.io.vn/admin`
  2. Vào mục **Cài đặt Hệ thống (System Settings)**
  3. Nhấn nút gạt **"Mở lại Cổng Đăng ký" (Resume Registration)**
- **Cách 2 (API Trực tiếp):**
  ```bash
  curl -X POST https://thanhgiuse.gaudetedomino.io.vn/api/admin/settings/kill-switch \
    -H "Authorization: Bearer <ADMIN_SECRET_TOKEN>" \
    -H "Content-Type: application/json" \
    -d '{"enabled": true}'
  ```

#### Bước 5: Kiểm Tra Cơ Chế Tự Động Requeue (Auto-Requeue Verification)
Hàm `requeuePendingStudentsAfterKillSwitch()` trong `apps/api/src/routes/admin.ts` sẽ tự động:
1. Quét toàn bộ học sinh đang ở trạng thái `pending`.
2. Kiểm tra các job chưa hoàn thành hoặc bị gián đoạn trong BullMQ.
3. Đẩy lại các học sinh này vào `registration_queue` theo đúng thứ tự ưu tiên mà không cần phụ huynh phải nộp lại ảnh.

---

## 4. Xử Lý Hồ Sơ Cô Lập (Manual Review Handling)

### 4.1. Các Nguyên Nhân Hồ Sơ Bị Đưa Vào `manual_review`
- **Mã `-9006`:** Thuật toán AI HANET không tìm thấy khuôn mặt, ảnh quá mờ, góc nghiêng quá 30 độ hoặc độ tương phản kém.
- **Mã `-9005` (Sync Conflict):** Khuôn mặt nộp trùng với một nhân sự khác đã có trên Cloud nhưng khác AliasID.
- **Mã `-5011`:** Không tìm thấy Person ID khi cập nhật mã danh bộ.
- **Chạm trần thử lại (Max Retries = 3):** Lỗi mạng ngoại vi hoặc server 503 kéo dài quá 3 chu kỳ (15 phút).
- **Mã định danh cũ (Legacy Format):** AliasID không khớp chuẩn regex 9 ký tự.

### 4.2. Quy Trình Rà Soát & Mở Khóa Thủ Công
1. Truy cập trang Quản trị: `https://thanhgiuse.gaudetedomino.io.vn/admin/manual-review` (Giao diện `ManualReviewApproval.tsx`).
2. Xem danh sách học sinh bị cô lập:
   - Hệ thống hiển thị ảnh chân dung gốc (lưu tại đĩa), mã lỗi kỹ thuật HANET (`last_error_code`), lý do chi tiết và thời gian nộp.
   - Hỗ trợ lọc theo Lớp học (`class_code`).
3. Hành động của Quản trị viên:
   - **Mở khóa cho nộp lại (Unlock to empty):**
     Nhấn "Mở Khóa" kèm ghi chú giải trình (ví dụ: *"Đã dặn phụ huynh chụp lại chỗ sáng hơn"*).
     Hệ thống chuyển trạng thái học sinh về `empty`, xóa mã lỗi cũ, và dọn dẹp ảnh hỏng.
   - **Xác nhận cưỡng chế (Override/Direct Sync):**
     Nếu ảnh đạt chất lượng nhưng AI từ chối sai, Admin có thể dùng công cụ đẩy thủ công với cờ bypass.
4. **Ghi nhận Nhật ký Kiểm toán (Audit Log):**
   Mỗi thao tác mở khóa đều được ghi vào bảng `logs`:
   `action = 'UNLOCK_STUDENT'`, `result_code = 'UNLOCKED'`, lưu kèm tên Admin và ghi chú.

---

## 5. Webhook Hoãn Lại Khi Kill Switch Ngắt (Deferred Webhook)

- Khi cổng đăng ký bị khóa khẩn cấp (`settings.registration_enabled = 'false'`), mọi webhook sự kiện đẩy về từ HANET Cloud (`POST /api/webhooks/hanet`) sẽ **không xử lý trực tiếp** để tránh làm sai lệch trạng thái CSDL.
- Webhook nhận được sẽ được lưu vào bảng `logs`:
  - `action = 'WEBHOOK_DEFERRED'`
  - `result_code = 'KILL_SWITCH_ACTIVE'`
  - Payload JSON được lưu trữ đầy đủ để Admin đối soát lại sau khi phục hồi hệ thống.

---

## 6. Sao Lưu & Khôi Phục CSDL (Backup & Disaster Recovery)

### 6.1. Sao Lưu Nhanh CSDL (pg_dump)
Thực hiện định kỳ trước mỗi đợt bảo trì hoặc thay đổi lớn:
```bash
# Tạo file backup có gắn mốc thời gian vào thư mục backups/
BACKUP_NAME="backup_local_$(date +%Y%m%d_%H%M%S).sql"
docker exec thanh_giuse_postgres pg_dump -U postgres_user thanh_giuse_db > "backups/${BACKUP_NAME}"

# Kiểm tra dung lượng file backup
ls -lh "backups/${BACKUP_NAME}"
```

### 6.2. Khôi Phục CSDL từ Bản Sao Lưu (Restore)
```bash
# Dừng API và Worker để tránh xung đột kết nối ghi
docker compose stop app_api app_worker

# Khôi phục từ file backup đã chọn
docker exec -i thanh_giuse_postgres psql -U postgres_user -d thanh_giuse_db < backups/backup_local_YYYYMMDD_HHMMSS.sql

# Khởi động lại API và Worker
docker compose start app_api app_worker
```

---

## 7. Lưu Ý CSDL & Chuẩn Hóa Schema

1. **Chuẩn Alias ID 9 Ký Tự (Cloud Ceiling Guard):**
   - Mọi `alias_id` bắt buộc tuân thủ regex: `^[A-Za-z]{2}[A-Za-z0-9]{2}_[A-Za-z0-9]{4}$` (VD: `TS1A_A1B2`).
   - Các mã cũ hoặc sai format sẽ bị chặn ngay tại tầng Worker và chuyển vào diện cô lập an toàn.
2. **Cột `qr_token` (Migration 003):**
   - Cột `qr_token` trong bảng `students` là token định danh nội bộ (có thể null ở các bản ghi tạo mới).
   - **TUYỆT ĐỐI BẢO MẬT:** Không bao giờ để lộ `qr_token`, `person_id`, `face_url` ra các endpoint công khai (danh sách lớp, tra cứu trạng thái).
3. **Enum Trạng Thái Học Sinh (`student_status`):**
   `empty` ➔ `pending` ➔ `success` (hoặc `manual_review` / `error` / `conflict_pending_review` / `synced`).

---

## 8. Bảng Kiểm Tra Sau Khi Triển Khai (Post-Deploy Checklist)

Mỗi khi deploy phiên bản mới lên VPS, Quản trị viên **BẮT BUỘC** thực hiện tuần tự danh sách kiểm tra sau:

- [ ] **1. Trạng Thái Container:**
  ```bash
  docker ps
  ```
  Xác nhận cả 5 containers (`thanh_giuse_proxy`, `thanh_giuse_api`, `thanh_giuse_worker`, `thanh_giuse_postgres`, `thanh_giuse_redis`) đều `Up (healthy)`.
- [ ] **2. Giới Hạn Bộ Nhớ (RAM Matrix):**
  ```bash
  docker stats --no-stream
  ```
  Xác nhận tổng lượng RAM tiêu thụ tức thời < 1.5 GB và giới hạn cứng (LIMIT) của từng container đúng ma trận (Proxy 128M, Postgres 512M, Redis 192M, API 512M, Worker 768M).
- [ ] **3. Kiểm Tra Healthcheck API:**
  ```bash
  curl -s https://thanhgiuse.gaudetedomino.io.vn/health
  # Kỳ vọng: {"status":"ok","serviceStatus":"UP"}
  ```
- [ ] **4. Kiểm Tra Header Chống Cache Ảnh Tĩnh:**
  ```bash
  curl -I https://thanhgiuse.gaudetedomino.io.vn/tmp-faces/sample.jpg
  # Kỳ vọng có header: Cache-Control: no-store, no-cache, must-revalidate
  ```
- [ ] **5. Kiểm Tra Bảo Vệ Danh Sách Lớp Công Khai (P0 Security):**
  ```bash
  curl -s https://thanhgiuse.gaudetedomino.io.vn/api/classes/TS3A/students | grep -i "qr_token"
  # Kỳ vọng: RỖNG (Không được chứa bất kỳ chuỗi qr_token, person_id, face_url nào)
  ```
- [ ] **6. Chạy Bộ Kiểm Chứng Tự Động Toàn Diện:**
  ```bash
  npx tsx tests/verify-production-suite.ts
  npx tsx tests/verify-3tier-error-handling.ts
  # Kỳ vọng: Cả 2 bộ kiểm chứng đều báo 100% PASS!
  ```
