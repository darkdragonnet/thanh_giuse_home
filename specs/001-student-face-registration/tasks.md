---
description: "Actionable, dependency-ordered tasks for Student Face Registration & HANET Cloud Onboarding"
---

# Tasks: Student Face Registration & HANET Cloud Onboarding

**Input**: Design documents from `specs/001-student-face-registration/` (`spec.md`, `plan.md`, `data-model.md`, `contracts/`, `research.md`)  
**Constitution**: `.specify/memory/constitution.md` (Ratified Baseline 1.0.0)  
**Target Architecture**: Monorepo Web Application (`apps/api`, `apps/worker`, `apps/student`, `apps/admin`, `apps/hanet-mock`, `packages/`, `tests/`)

---

## Phase 1: Setup & Prerequisite Validation (Shared Infrastructure)

**Purpose**: Shared infrastructure and critical early image-validator gate before large subsystem tasks.

- [X] T001 Implement core image validator in `packages/shared-infra/src/validators/image.validator.ts` rejecting payloads >5MB, non-image or corrupted buffers, and sub-detection resolutions (<100x100), while accepting any aspect ratio (Sharp downstream handles 1280x736 cover normalization)
- [X] T002 [P] Write unit tests in `tests/image-validator.test.ts` to verify and accept image validator rules (>5MB rejected, corrupt bytes rejected, sub-detection rejected, arbitrary aspect ratio accepted)
- [X] T003 [P] Create CI verification script `scripts/verify-docker-ram-limits.ts` validating that no service in `docker/docker-compose.yml` exceeds its individual memory limit (`app_proxy`: 128MB, `app_postgres`: 512MB, `app_redis`: 192MB, `app_api`: 512MB, `app_worker`: 768MB) and aggregate sum is ≤ 2,112 MB (REQUIRED GATE: Principle I)
- [X] T004 [P] Configure monorepo package scripts, TypeScript build references, and environment configuration in `package.json` and `.env.example`

**Checkpoint**: Image validator and memory guard verified before proceeding to database and service foundations.

---

## Phase 2: Foundational (Blocking Prerequisites & Architecture Gates)

**Purpose**: Core infrastructure and hard technical gates that MUST be complete before ANY user story can be implemented.

**⚠️ CRITICAL**: No user story work can begin until this phase is complete.

- [X] T005 Initialize and verify database schema, 9-character alias regex constraint `^[A-Za-z]{2}[A-Za-z0-9]{2}_[A-Za-z0-9]{4}$`, and default system settings (`registration_enabled='true'`, `hanet_sync_rate_limit='1'`) in `docker/postgres/init.sql`
- [X] T006 [P] Write unit test in `tests/worker-concurrency.test.ts` asserting BullMQ worker initialization option `worker.opts.concurrency === 1` and process heap bound `--max-old-space-size=512` (REQUIRED GATE: Principle II)
- [X] T007 [P] Write unit test in `tests/sync-rate-limiter.test.ts` asserting BullMQ rate limiter pacing enforcing `hanet_sync_rate_limit = 1 req/phút` (delay of 60,000 ms between jobs)
- [X] T008 [P] Write integration test in `tests/selective-rate-limit.test.ts` validating FR-011 selective IP rate limiting (60 req/min/IP ceiling applies strictly to write endpoints `POST /api/students/:id/photo` and teacher PIN verify, whereas read endpoints `GET /api/students/:id/status` and `GET /api/classes` are completely bypassed)
- [X] T009 Implement selective IP rate limiter middleware in `apps/api/src/middleware/rateLimiter.ts` enforcing FR-011 selective counting for write routes and bypassing read routes
- [X] T010 Implement 3-tier error mapping and classification in `packages/error-mapping/src/index.ts` (-503 transient overload with 300s fixed backoff, -9006 data error to manual_review, -9008/-103 critical account alert)

**Checkpoint**: Foundation ready - all constitution baseline gates verified. User story implementation can now begin.

---

## Phase 3: User Story 1 - Học sinh tự nộp ảnh qua điện thoại (Priority: P1) 🎯 MVP

**Goal**: Học sinh hoặc phụ huynh truy cập liên kết, chọn tên từ danh sách lớp, chụp hoặc tải ảnh chân dung nén qua Canvas (<800KB), nhận biên nhận tiếp nhận <1.500ms và đưa vào hàng đợi nền.

**Independent Test**: Dùng trình duyệt di động truy cập, chọn một học sinh chưa đăng ký (`status='empty'`), nộp ảnh chân dung hợp lệ và nhận phản hồi HTTP 200 `pending` trong <1.500ms; worker chuẩn hóa 1280x736 và đồng bộ thành công sang `@thanh-giuse/hanet-mock`.

### Tests for User Story 1 (Write FIRST)
- [X] T011 [P] [US1] Write contract and integration tests in `tests/contract/test-student-photo-upload.spec.ts` for `POST /api/students/:id/photo` per `contracts/student-api.yaml` (accepting <1MB, returning 200 with queue receipt in <1.500ms)

### Implementation for User Story 1
- [X] T012 [P] [US1] Implement client-side Canvas pre-compression utility in `apps/student/src/utils/canvasCompressor.ts` (max dimension 1920px, JPEG 0.85 quality, target <800 KB, hard ceiling <1 MB)
- [ ] T013 [P] [US1] Build mobile-first photo capture, guidelines, and preview interface in `apps/student/src/components/CameraCapture.tsx` and `apps/student/src/index.ts`
- [X] T014 [US1] Implement asynchronous photo upload endpoint `POST /api/students/:id/photo` with multipart file intake and Fastify payload guard in `apps/api/src/index.ts`
- [X] T015 [US1] Implement sequential image normalization in `apps/worker/src/imageProcessor.ts` resizing to 1280x736 with `fit: 'cover', position: 'center'`, `sharp.cache(false)`, and `sharp.concurrency(1)`
- [X] T016 [US1] Implement BullMQ registration processor in `apps/worker/src/processor.ts` calling `@thanh-giuse/hanet-client` to register face on cloud and updating student status to `success`

**Checkpoint**: User Story 1 complete and independently testable as MVP.

---

## Phase 4: User Story 4 - Chặn xung đột nộp trùng (Race Condition) (Priority: P1)

**Goal**: Ngăn chặn triệt để tình trạng hai người cùng gửi ảnh cho một học sinh tại một thời điểm hoặc người dùng nhấn nút nộp nhiều lần liên tiếp, bảo đảm tính toàn vẹn dữ liệu.

**Independent Test**: Gửi đồng thời hai HTTP POST photo request cho cùng một `student_id`; đúng 1 request thành công (200), request còn lại bị từ chối với HTTP 409 Conflict.

### Tests for User Story 4 (Write FIRST)
- [X] T017 [P] [US4] Write concurrency integration test in `tests/concurrency-duplicate-registration.spec.ts` simulating simultaneous duplicate registration requests to assert HTTP 409 Conflict on the second attempt (REQUIRED GATE: Principle III)

### Implementation for User Story 4
- [X] T018 [US4] Implement atomic conditional update query in `apps/api/src/services/registration.ts` (`UPDATE students SET status = 'pending', local_image_path = :path WHERE id = :id AND status IN ('empty', 'error') RETURNING id, status`) returning HTTP 409 Conflict when 0 rows updated
- [X] T019 [US4] Enforce idempotent BullMQ job IDs keyed by `student_${alias_id}` in `apps/api/src/queue.ts` to prevent duplicate queued tasks

**Checkpoint**: Atomic DB locks prevent concurrent duplicate jobs across multiple clients.

---

## Phase 5: User Story 2 - Giáo viên chủ nhiệm hỗ trợ chụp hàng loạt tại lớp (Priority: P2)

**Goal**: Giáo viên chủ nhiệm sử dụng mã PIN của lớp để chụp ảnh liên tục cho từng học sinh trong một buổi học mà không bị hệ thống chặn vì gửi yêu cầu dồn dập từ cùng một thiết bị/IP.

**Independent Test**: Gửi 30 ảnh liên tục cho 30 học sinh trong vòng 10 phút trên cùng 1 địa chỉ IP kèm header `x-teacher-pin` hợp lệ; toàn bộ 30 yêu cầu đều được chấp nhận không bị lỗi 429.

### Tests for User Story 2 (Write FIRST)
- [ ] T020 [P] [US2] Write integration test in `tests/teacher-authorization-bypass.spec.ts` verifying teacher PIN authentication and rate-limit exemption when submitting 30 consecutive photos from a single IP

### Implementation for User Story 2
- [ ] T021 [US2] Implement teacher PIN verification and rate-limit bypass mechanism against `classes.token` in `apps/api/src/middleware/rateLimiter.ts`
- [ ] T022 [US2] Implement teacher PIN entry modal and batch photography workflow in `apps/student/src/index.ts` passing `x-teacher-pin` header on upload requests

**Checkpoint**: Teachers can register entire classrooms continuously without hitting rate limits.

---

## Phase 6: User Story 3 - Theo dõi tiến trình đồng bộ & vị trí hàng đợi (Priority: P2)

**Goal**: Sau khi nộp ảnh, học sinh theo dõi tiến trình qua HTTP Short Polling (3 giây/lần), nhận thông tin vị trí hàng đợi minh bạch, và trạng thái `pending` duy trì liên tục không bị hết hạn.

**Independent Test**: Nộp ảnh và kiểm tra `GET /api/students/:id/status` trả về vị trí hàng đợi; đóng trình duyệt và tra cứu lại sau nhiều giờ, trạng thái `pending` vẫn được bảo toàn an toàn.

### Tests for User Story 3 (Write FIRST)
- [ ] T023 [P] [US3] Write frontend integration test in `tests/frontend-polling.spec.ts` validating 3-second polling interval and human-friendly error messages upon queue rejection (REQUIRED GATE: Principle V)

### Implementation for User Story 3
- [ ] T024 [P] [US3] Implement status inquiry endpoint `GET /api/students/:id/status` in `apps/api/src/routes/status.ts` returning current `status`, `queue_position`, and `estimated_wait_minutes` without expiring `pending`
- [ ] T025 [US3] Implement client-side 3-second short polling cycle and queue position feedback modal in `apps/student/src/components/QueueStatusModal.tsx` and `apps/student/src/index.ts`

**Checkpoint**: Polling operates at 3-second intervals with non-expiring pending state.

---

## Phase 7: User Story 5 - Quản trị viên rà soát thủ công & Chốt chặn khẩn cấp (Kill Switch) (Priority: P2)

**Goal**: Tự động kích hoạt Kill Switch khi HANET trả lỗi -103 (PostgreSQL là Single Source of Truth, worker pause, không tự refresh token, chỉ Admin mở lại); áp dụng backoff 5 phút cho -503 tối đa 3 lần rồi cách ly `manual_review`; cung cấp Admin API và UI mở khóa hồ sơ theo `contracts/admin-api.yaml`.

**Independent Test**: Giả lập lỗi -103 từ mock server, kiểm chứng worker dừng đẩy và `settings.registration_enabled = 'false'`; giả lập lỗi -503 kiểm chứng 5 phút cố định retry 3 lần; Admin gọi `POST /api/admin/students/:id/unlock` mở khóa hồ sơ `manual_review` về `empty`.

### Tests for User Story 5 (Write FIRST)
- [ ] T026 [P] [US5] Write integration test in `tests/kill-switch-103.spec.ts` simulating error `-103 (ACCESS_TOKEN_EXPIRE)` against `@thanh-giuse/hanet-mock` to verify that `settings.registration_enabled = 'false'` is written to PostgreSQL, Redis `setting:kill_switch='true'` is set, and `worker.pause()` is executed without auto token refresh (REQUIRED GATE: Principle IV)
- [ ] T027 [P] [US5] Write integration test in `tests/fixed-backoff-503.spec.ts` simulating error `-503` verifying 5-minute fixed backoff (300,000 ms), maximum 3 attempts per error tier, then transitioning to `manual_review` cross-referencing `tests/verify-3tier-error-handling.ts`
- [ ] T028 [P] [US5] Write contract tests in `tests/contract/test-admin-manual-review.spec.ts` for `GET /api/admin/students/manual-review` and `POST /api/admin/students/:id/unlock` per `contracts/admin-api.yaml`

### Implementation for User Story 5
- [ ] T029 [US5] Implement Kill Switch triggers (-103 sets `registration_enabled='false'` in PostgreSQL, halts queue, no token refresh) and fixed 5-minute backoff (-503 with max 3 attempts then `manual_review`) in `apps/worker/src/processor.ts`
- [ ] T030 [US5] Implement `GET /api/admin/students/manual-review` and `POST /api/admin/students/:id/unlock` endpoints in `apps/api/src/routes/admin.ts` per `contracts/admin-api.yaml` with audit logging in `logs` table
- [ ] T031 [US5] Implement Admin manual review management page and unlock action dialog in `apps/admin/src/pages/ManualReviewApproval.tsx`
- [ ] T032 [US5] Implement Admin emergency safeguards management panel in `apps/admin/src/pages/SystemSettings.tsx` connecting to `POST /api/admin/settings/kill-switch` to toggle global registration

**Checkpoint**: Kill Switch halts queues on -103, -503 handles fixed 5-minute backoffs, and Admin can review and unlock quarantined students.

---

## Phase 8: Polish & Cross-Cutting Verification

**Purpose**: System-wide integration, full regression pipeline verification, and documentation integrity.

- [ ] T033 [P] Write comprehensive end-to-end integration test runner in `tests/e2e-registration-pipeline.spec.ts` executing end-to-end enrollment against `@thanh-giuse/hanet-mock`
- [ ] T034 Execute full test suite verifying all 5 Constitution REQUIRED GATES against `tests/verify-production-suite.ts` and `tests/verify-3tier-error-handling.ts`
- [ ] T035 [P] Update operational runbook and deployment validation procedures in `docs/RUNBOOK.md` and `specs/001-student-face-registration/quickstart.md`

---

## Dependencies & Execution Order

### Phase Dependencies
- **Phase 1 (Setup)**: No dependencies - can start immediately. Image validator (T001, T002) MUST be validated before Phase 3.
- **Phase 2 (Foundational)**: Depends on Phase 1 completion. BLOCKS all user story development.
- **Phase 3 (User Story 1 - MVP)**: Depends on Phase 2 completion.
- **Phase 4 (User Story 4 - Race Condition)**: Depends on Phase 2 and T014/T018 DB models.
- **Phase 5 (User Story 2 - Teacher Batch)**: Depends on Phase 3 completion (extends photo upload with PIN bypass).
- **Phase 6 (User Story 3 - Polling & Queue)**: Depends on Phase 3 completion (status polling after upload).
- **Phase 7 (User Story 5 - Kill Switch & Admin Unlock)**: Depends on Phase 2 & Phase 3 (monitors worker errors and manages `manual_review` state).
- **Phase 8 (Polish)**: Depends on completion of all user story phases.

### User Story Dependencies
```text
Phase 1 (Setup & Image Validator)
       │
       ▼
Phase 2 (Foundational & Constitution Gates)
       │
       ├────────────────────────┬────────────────────────┐
       ▼                        ▼                        ▼
Phase 3 (US1 - MVP)      Phase 4 (US4 - Lock)    Phase 7 (US5 - Kill Switch / Admin)
       │
       ├────────────────────────┐
       ▼                        ▼
Phase 5 (US2 - Teacher)  Phase 6 (US3 - Polling)
       │                        │
       └────────────────────────┴────────────────────────┘
                                │
                                ▼
                     Phase 8 (Polish & CI/CD)
```

---

## Parallel Execution Opportunities

- **Phase 1**: T002, T003, T004 can run in parallel after T001.
- **Phase 2**: T006, T007, T008 can run in parallel while T005 DB init runs.
- **Phase 3**: Tests T011, client compressor T012, and UI capture T013 can run in parallel.
- **Phase 5 & 6**: US2 (Teacher PIN) and US3 (Short Polling) can be executed in parallel once US1 (MVP) is delivered.
- **Phase 7**: Tests T026, T027, T028 can run in parallel before implementation tasks T029-T032.

---

## Implementation Strategy (MVP First)

1. **Phase 1 & Phase 2**: Build image-validator, database schema, rate limiter, and verify all 5 Constitution Gates.
2. **Phase 3 (MVP)**: Deliver User Story 1 (Student mobile capture, Canvas compression, Fastify upload, Sharp 1280x736, BullMQ sync).
3. **Phase 4**: Harden race condition protections with atomic conditional updates (HTTP 409).
4. **Phase 5 & 6**: Enable teacher batch photo shooting with PIN bypass and 3-second queue polling.
5. **Phase 7**: Wire up Kill Switch (-103 halt, -503 5-min backoff) and Admin unlock API/UI.
6. **Phase 8**: Execute full E2E suite against `hanet-mock` and document runbook.
