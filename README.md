# Hệ thống Onboarding Đăng ký Khuôn mặt Học sinh (HANET Cloud Integration)

> **Mục tiêu quy mô:** 1.200 học sinh (Chiến dịch cao điểm trong 01 tháng)  
> **Hạ tầng triển khai:** VPS Ubuntu (3 vCPU, 3.0 GB RAM, 20 GB SSD, 2.0 GB Swap)  
> **Kiến trúc chi tiết:** Xem toàn bộ tại [Tài liệu Đặc tả Kiến trúc Hệ thống](docs/ARCHITECTURE.md)

---

## 1. Giới thiệu Dự án

Dự án cung cấp giải pháp thu thập và chuẩn hóa ảnh chân dung của học sinh, tự động đồng bộ khuôn mặt lên hệ sinh thái nhận diện AI của **HANET Cloud**. Hệ thống được thiết kế tối ưu hóa triệt để để vận hành mượt mà, chống tràn bộ nhớ (OOM) và chống nghẽn mạng trên phần cứng máy chủ tiết kiệm chi phí.

### Điểm nổi bật:
* **Chống tràn RAM (Zero OOM):** Frontend SPA tĩnh phục vụ qua Nginx, worker xử lý ảnh tuần tự bằng Sharp (`concurrency: 1`), tổng lượng RAM toàn bộ container duy trì ổn định dưới 2.1 GB.
* **Chống Race Condition:** Khóa cập nhật nguyên tử (*Atomic Conditional Update*) ở tầng PostgreSQL ngăn chặn tình trạng nhiều học sinh chọn trùng tên hoặc bấm gửi liên tục.
* **Xếp hàng bất đồng bộ (Fire-and-Forget):** Nhận ảnh, kiểm tra hợp lệ, ghi nhận vào hàng đợi BullMQ và phản hồi biên nhận ngay lập tức cho học sinh.
* **Phân quyền & Bypass linh hoạt:** Cơ chế Redis Sliding Window Rate Limiting chống spam IP, đồng thời cho phép giáo viên chủ nhiệm dùng mã PIN (`x-teacher-pin`) hoặc Admin hỗ trợ chụp hàng loạt cho cả lớp mà không bị chặn.
* **Cơ chế phục hồi & Ngắt mạch:** Tự động bắt lỗi quá tải `-503` từ HANET để retry sau 5 phút, tự động chuyển trạng thái `manual_review` khi ảnh không đạt chuẩn hoặc lỗi quá 3 lần.

---

## 2. Ma trận Container & Giới hạn Tài nguyên (Docker Matrix)

Toàn bộ dịch vụ được đóng gói thành 5 container Docker với hạn mức tài nguyên nghiêm ngặt:

| Container | Base Image | CPU Limit | RAM Reserve | RAM Limit | Vai trò chính |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **`app_proxy`** | `nginx:alpine` | 0.5 vCPU | 32 MB | **128 MB** | Reverse proxy, SSL, phục vụ SPA Frontend tĩnh, giới hạn `client_max_body_size 5M`. |
| **`app_postgres`** | `postgres:16-alpine` | 1.0 vCPU | 256 MB | **512 MB** | Cơ sở dữ liệu quan hệ (PostgreSQL 16). `shared_buffers=128MB`, `max_connections=40`. |
| **`app_redis`** | `redis:7-alpine` | 0.5 vCPU | 64 MB | **192 MB** | Broker cho BullMQ, lưu trữ Sliding Window Rate Limit. AOF enabled. |
| **`app_api`** | `node:20-alpine` | 1.0 vCPU | 128 MB | **512 MB** | REST API Server, kiểm tra xác thực, atomic DB update, enqueue job. |
| **`app_worker`** | `node:20-alpine` | 1.5 vCPU | 256 MB | **768 MB** | BullMQ Consumer (`concurrency: 1`), Sharp resize 1280x736, gọi HANET API. |
| **TỔNG CỘNG** | — | — | **736 MB** | **2.112 MB** | **Dư ~500 MB RAM** cho OS Cache và Buffer an toàn. |

---

## 3. Luồng Dữ liệu Tổng thể (Data Flow)

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

## 4. Mô hình Dữ liệu (Database Schema)

Cơ sở dữ liệu sử dụng **PostgreSQL 16** với 4 bảng cốt lõi:

* **`classes`**: Thông tin lớp học, mã PIN giáo viên (`token`), cờ khóa lớp (`is_locked`).
* **`students`**: Danh sách học sinh, mã định danh `alias_id`, trạng thái đăng ký, `person_id` và link ảnh CDN từ HANET.
* **`logs`**: Nhật ký hoạt động đăng ký, đổi ảnh, override và IP nguồn.
* **`settings`**: Cấu hình hệ thống (Bao gồm chốt chặn khẩn cấp `registration_enabled`).

### Vòng đời trạng thái học sinh:
```
empty  ──► (Nộp ảnh) ──►  pending  ──► (Worker gọi HANET) ──►  success (Đã có person_id)
                                                           └──►  error / manual_review (>=3 lần lỗi)
```

---

## 5. Cấu trúc Dự án Đề xuất

```
thanh_Giuse/
├── .gitignore
├── README.md
├── docs/
│   └── ARCHITECTURE.md          # Tài liệu đặc tả kiến trúc kỹ thuật chi tiết
├── docker/
│   ├── docker-compose.yml       # Khởi chạy 5 container với resource limits
│   ├── nginx/
│   │   ├── nginx.conf
│   │   └── default.conf
│   └── postgres/
│       └── init.sql             # Script khởi tạo bảng và enum PostgreSQL
├── src/
│   ├── api/                     # Node.js API Server (Express/Fastify)
│   │   ├── middlewares/         # rateLimit, killSwitch, classLock
│   │   ├── routes/              # classes, students, admin
│   │   └── server.ts
│   ├── worker/                  # BullMQ Background Worker
│   │   ├── processors/          # registrationWorker, sharpProcessor
│   │   ├── services/            # hanetService
│   │   └── worker.ts
│   └── shared/                  # Database client, Redis client, Types/Interfaces
└── frontend/                    # Web SPA (React/Vue/Vite) được build thành static
```

---

## 6. Lộ trình Triển khai (Checklist)

- [x] **Giai đoạn 0:** Khởi tạo Git repository, `.gitignore`, lưu trữ tài liệu đặc tả kiến trúc.
- [ ] **Giai đoạn 1:** Soạn thảo cấu hình `docker-compose.yml`, `init.sql` và cấu hình Nginx reverse proxy.
- [ ] **Giai đoạn 2:** Xây dựng phần `shared` (kết nối Postgres, Redis connection pool, Prisma/Kysely/Drizzle schema).
- [ ] **Giai đoạn 3:** Xây dựng `src/api` với các Middleware phòng vệ (`killSwitchGuard`, `classLockGuard`, `rateLimitGuard`) và các endpoint chính.
- [ ] **Giai đoạn 4:** Xây dựng `src/worker` với Sharp image optimization và tích hợp API HANET Cloud (retry & circuit breaker).
- [ ] **Giai đoạn 5:** Xây dựng giao diện Frontend (Học sinh chọn lớp & nén ảnh Canvas; Admin dashboard).
- [ ] **Giai đoạn 6:** Viết kịch bản kiểm thử tải, kiểm tra rò rỉ bộ nhớ (Memory Leak Check) và triển khai CI/CD lên VPS.

---

## 7. Liên kết Hữu ích
* [Tài liệu Kiến trúc Toàn diện (ARCHITECTURE.md)](docs/ARCHITECTURE.md)
* [HANET Cloud Open API Documentation](https://hanet.com)
