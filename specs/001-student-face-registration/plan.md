# Implementation Plan: Student Face Registration & Onboarding

**Branch**: `001-student-face-registration` | **Date**: 2026-10-21 | **Spec**: [specs/001-student-face-registration/spec.md](file:///Users/dragonnet/Documents/thanh_Giuse/specs/001-student-face-registration/spec.md)

**Input**: Feature specification from `specs/001-student-face-registration/spec.md`

## Summary

Triển khai luồng đăng ký và chuẩn hóa ảnh khuôn mặt cho 1.200 học sinh tích hợp HANET Cloud trên hạ tầng VPS 3.0 GB RAM. Giải pháp áp dụng kiến trúc bất đồng bộ Fire-and-Forget: client nén trước qua HTML5 Canvas (< 800 KB), Nginx Reverse Proxy bảo vệ payload (chặn cứng 5MB, trần IP 60 req/phút CHỈ áp dụng cho endpoint ghi như nộp ảnh và xác thực mã PIN; các endpoint đọc như polling status 3s hay danh sách lớp/học sinh hoàn toàn được miễn trừ), Fastify API thực hiện khóa nguyên tử (`empty`/`error` -> `pending`) và đẩy tác vụ vào BullMQ queue, phản hồi biên nhận trong < 1.500ms. Phía học sinh theo dõi tiến độ qua Short Polling 3 giây với vị trí hàng đợi minh bạch; Worker BullMQ (`concurrency: 1`) điều tiết nhịp đồng bộ đám mây ở mức 1 request/phút (toàn trường ~20 giờ nền) kèm xử lý lỗi 3 tầng an toàn. Trạng thái `pending` không hết hạn. Quản trị viên (Admin) sở hữu endpoint mở khóa chuyên biệt để giải phóng hồ sơ `manual_review`.

## Technical Context

**Language/Version**: Node.js 20 LTS (TypeScript 5.5+)  
**Primary Dependencies**: Fastify 4.28+, BullMQ 5.12+, ioredis 5.4+, Sharp 0.33+ (Worker), HTML5 Canvas API (Client Portal)  
**Storage**: PostgreSQL 16 Alpine (`shared_buffers=128MB`, `max_connections=40`), Redis 7 Alpine (AOF enabled, `maxmemory 128mb`, `noeviction`)  
**Testing**: Vitest 1.x, `@thanh-giuse/hanet-mock` (Fastify mock server)  
**Target Platform**: Linux Server (Ubuntu 3 vCPU, 3.0 GB RAM, Docker Compose cgroup limits)  
**Project Type**: Monorepo Web Application (Fastify Web API + BullMQ Worker + Static SPAs Student/Admin)  
**Performance Goals**:
- Phản hồi biên nhận nộp ảnh (Asynchronous Receipt API): p95 < 1.500 ms.
- Client nén ảnh Canvas: mục tiêu < 800 KB (trần chặn tiếp nhận < 1 MB).
- Nhịp đồng bộ HANET Cloud: 1 request/phút (cấu hình hệ thống `hanet_sync_rate_limit`), hoàn tất 1.200 học sinh trong ~20 giờ nền.
**Constraints**:
- Tổng RAM phân bổ Docker Matrix **≤ 2.112 MB** (`app_proxy`: 128MB, `app_postgres`: 512MB, `app_redis`: 192MB, `app_api`: 512MB, `app_worker`: 768MB).
- BullMQ Worker Concurrency **bắt buộc = 1**, `sharp.concurrency(1)` và `sharp.cache(false)`.
- Tuyệt đối không dùng ORM nhị phân cồng kềnh (Prisma); dùng Kysely hoặc raw SQL qua `pg`.
**Scale/Scope**: 1.200 học sinh (chiến dịch cao điểm trong 01 tháng), ~40 lớp học.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

- [x] **Principle I (Finite Resource Invariant)**: Tổng RAM containers không vượt quá 2.112 MB; Fastify 4+ được sử dụng; không có Prisma/heavy ORM; heap bounds `--max-old-space-size=384` (API) và `--max-old-space-size=512` (Worker). -> **PASS**
- [x] **Principle II (Worker Scarcity & Sequential Processing)**: BullMQ `concurrency: 1`; Sharp chuẩn hóa khung hình 1280x736; timeout 120s với `AbortSignal`; retry -503 sau 300s; tối đa 3 lần lỗi rồi chuyển `manual_review`. -> **PASS**
- [x] **Principle III (Single Source of Truth & Atomic Integrity)**: PostgreSQL là master; alias_id chuẩn 9 ký tự; Atomic Conditional Update (`UPDATE students SET status = 'pending' WHERE id = :id AND status IN ('empty', 'error') RETURNING ...`) trả về HTTP 409 nếu trùng lặp; `manual_review` chỉ do Admin can thiệp. -> **PASS**
- [x] **Principle IV (Safe HANET Cloud Dependency)**: Quota ceiling kiểm soát; nhịp đồng bộ cấu hình 1 req/phút; kiểm thử hồi quy 100% qua mock server (`@thanh-giuse/hanet-mock`). -> **PASS**
- [x] **Principle V (Mobile-First & Polling Architecture)**: Canvas pre-compression (<800KB); Nginx `client_max_body_size 5M`; Short Polling 3s kèm Queue Position Feedback; `pending` duy trì không hết hạn. -> **PASS**

## Project Structure

### Documentation (this feature)

```text
specs/001-student-face-registration/
├── spec.md              # Feature Specification (Ratified & Clarified)
├── plan.md              # This file (Implementation Plan)
├── research.md          # Phase 0 output (Technical decisions & trade-offs)
├── data-model.md        # Phase 1 output (Entities, State machine, DB Schema)
├── quickstart.md        # Phase 1 output (Runnable validation scenarios)
└── contracts/           # Phase 1 output (API schemas & endpoint definitions)
    ├── student-api.yaml # OpenAPI 3.0 specification for registration endpoints
    └── admin-api.yaml   # OpenAPI 3.0 specification for admin operations (unlock manual_review)
```

### Source Code (repository root)

```text
apps/
├── api/                 # Fastify REST API Server (Node 20)
│   └── src/
│       ├── routes/      # Endpoints: /api/classes, /api/students/:id/photo, /status
│       ├── plugins/     # Rate limiter, PIN auth bypass, multipart upload
│       └── services/    # RegistrationService, QueueProducer
├── worker/              # BullMQ Consumer Worker (Node 20, concurrency: 1)
│   └── src/
│       ├── processors/  # RegistrationProcessor (Paced sync 1 req/min)
│       ├── image/       # Sharp normalizer (1280x736 cover)
│       └── hanet/       # HanetSyncService with 3-tier error handling
├── student/             # Mobile-First SPA (Vite / React / Canvas compressor)
│   └── src/
│       ├── components/  # CameraCapture, PhotoPreview, QueueStatusModal
│       └── utils/       # canvasCompressor.ts (<800KB target)
├── admin/               # Admin Management SPA (Vite / React)
│   └── src/
│       └── pages/       # StudentList, ManualReviewApproval, SystemSettings
└── hanet-mock/          # Local Mock Server for HANET Cloud API

packages/
├── shared-types/        # Shared DTOs, StudentStatus enum, JobPayload
├── shared-infra/        # DB pool (pg/Kysely), Redis client, BullMQ helpers
├── error-mapping/       # HANET error code mappings & 3-tier classification
└── hanet-client/        # Type-safe HANET Cloud HTTP client
```

**Structure Decision**: Monorepo sẵn có với cấu trúc tách biệt rõ ràng giữa API tiếp nhận (`apps/api`) và Worker xử lý nền (`apps/worker`), đảm bảo cách ly tuyệt đối về tài nguyên CPU/RAM theo Docker Matrix.

## Complexity Tracking

| Invariant / Rule | Implementation Approach | Simpler Alternative Rejected Because |
| :--- | :--- | :--- |
| **Paced Sync (1 req/min)** | BullMQ limiter/delay rate control + config `hanet_sync_rate_limit` | Đồng bộ tức thì (sync call) bị loại bỏ vì gây nghẽn mạng, dính quota HANET và làm sập RAM VPS khi nhiều người nộp cùng lúc |
| **Short Polling 3s** | HTTP GET `/api/students/:id/status` với Redis cache vị trí | WebSocket/SSE bị loại bỏ vì giữ kết nối thường trực gây tiêu hao RAM của Node process và Nginx |
| **Selective Rate Limiter (FR-011)** | Middleware chỉ áp dụng trần 60 req/phút/IP cho WRITE routes (`POST /photo`, PIN auth); READ routes (`GET /status`, `GET /classes`) được bypass | Áp trần toàn cục cho cả READ bị loại bỏ vì chu kỳ polling 3s của 30–40 học sinh trong 1 lớp (600–800 req/phút) sẽ chặn nhầm toàn bộ lớp học |
| **Atomic DB Lock** | Single parameterized SQL query with `WHERE status IN ('empty', 'error')` | In-memory lock bị loại bỏ vì không an toàn khi có nhiều worker/process và không bền vững nếu service restart |
