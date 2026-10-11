# Implementation Plan: Bộ Công Cụ Kiểm Thử Toàn Diện Module Đăng Ký Học Sinh (Vitest, Mock Server & E2E)

## 1. Architectural Context & Constraints
- **Hardware/VPS Limits:** VPS Ubuntu 3 vCPU, 3.0 GB RAM, Swap 2.0 GB.
- **Hiến pháp Dự án (Rules 00 & 01):**
  - Worker Concurrency: 1 bất biến.
  - Định danh học sinh chuẩn cố định: **9 ký tự** (`^[A-Za-z]{2}[A-Za-z0-9]{2}_[A-Za-z0-9]{4}$`).
  - Cô lập tuyệt đối dữ liệu seed cũ 17 ký tự (`STU_...` -> `LEGACY_FORMAT_QUARANTINED`).
  - Lỗi -9008 (hết Face ID quota): ngắt mạch hàng đợi (`queue.pause()`), bật cờ Redis `system:registration_disabled = 'true'`.
  - Lỗi -9005 (trùng mặt người khác): cách ly bản ghi vào trạng thái `conflict_pending_review`.
  - Lỗi 0 (thành công): cập nhật trạng thái `synced` / `success` và lưu `person_id`.
- **Affected Files:**
  - `package.json` (thêm `vitest`, `node-fetch` devDependencies, cập nhật test script)
  - `shared/validators/identifier.validator.ts` & `packages/shared/` (Engine kiểm tra định dạng 9 ký tự)
  - `apps/worker/src/services/system-lock.service.ts` (Dịch vụ khóa hệ thống khi cạn quota -9008)
  - `apps/worker/src/processors/register-face.processor.ts` (Worker processor xử lý phản hồi từ HANET)
  - `apps/api/src/routes/registration.ts` hoặc `apps/api/src/index.ts` (Endpoint `POST /api/registration/submit`)
  - `tests/mocks/hanet-mock-server.ts` (Mock Server HANET Cloud độc lập cổng 9999)
  - `tests/registration.spec.ts` (Test Suite tự động Vitest)
  - `scripts/test-registration-flow.ts` (E2E Runner thủ công)

## 2. Technical Decisions (From Clarification)
- **Test Framework:** `vitest` v2.x (Hỗ trợ native ESM, TypeScript, cực nhẹ không tốn RAM).
- **Mock Server:** Fastify server độc lập tại `tests/mocks/hanet-mock-server.ts` cổng `9999` với header điều khiển `x-mock-scenario` (`EXCEED_QUOTA`, `EXPIRED_TOKEN`, `CONFLICT_DIFFERENT_PERSON`).
- **Validator Engine:** Module thuần túy `validateStudentIdentifier(aliasId, hanetPersonId)` kiểm tra regex `^[A-Za-z]{2}[A-Za-z0-9]{2}_[A-Za-z0-9]{4}$`, kiểm tra độ dài 9 ký tự, chặn legacy 17 ký tự `STU_...`, và yêu cầu `hanetPersonId` hợp lệ.
- **Queue & System Lock:** Redis key `system:registration_disabled` điều khiển Kill Switch. Khi gặp -9008, worker tự động gọi `queue.pause()` và set key Redis này.

## 3. Phased Execution Checklist

### Phase 1: Cài đặt Vitest & Validator Engine (9 Ký Tự)
- [x] Task 1.1: Cài đặt `vitest` và `node-fetch` vào devDependencies trong `package.json`.
- [x] Task 1.2: Xây dựng module `shared/validators/identifier.validator.ts`:
  - Kiểm tra `hanetPersonId` không null (`MISSING_HANET_PERSON_ID`).
  - Phát hiện và cô lập format legacy 17 ký tự `STU_...` (`LEGACY_FORMAT_QUARANTINED`, `isLockedForManualEdit: true`).
  - Kiểm tra chuẩn 4_4 (9 ký tự) theo regex `^[A-Za-z]{2}[A-Za-z0-9]{2}_[A-Za-z0-9]{4}$`.
  - Trả về mã lỗi `INVALID_IDENTIFIER_FORMAT` cho các trường hợp không đúng định dạng.
*Checkpoint Verification:* Chạy unit test riêng cho `identifier.validator.ts` xác nhận 4/4 assertions đều PASS.

### Phase 2: Dịch Vụ Khóa Hệ Thống & Worker Face Registration Processor
- [x] Task 2.1: Tạo `apps/worker/src/services/system-lock.service.ts` định nghĩa hằng số `REDIS_KEY_SYSTEM_REGISTRATION_DISABLED = 'system:registration_disabled'`.
- [x] Task 2.2: Xây dựng `apps/worker/src/processors/register-face.processor.ts`:
  - Kết nối HANET Cloud API (hoặc Mock Server).
  - Xử lý Case 0: Đăng ký thành công -> cập nhật student `person_id`, status = `synced`.
  - Xử lý Case -9008: Quota face exceeded -> set Redis flag `system:registration_disabled = 'true'`, gọi `queue.pause()`, ném lỗi `/Quota face exceeded/`.
  - Xử lý Case -9005: Xung đột khuôn mặt -> cập nhật DB status = `conflict_pending_review`, ném lỗi `/Xung đột khuôn mặt/`.
*Checkpoint Verification:* Kiểm chứng logic ngắt mạch và cập nhật DB khi gặp từng mã lỗi từ Mock.

### Phase 3: Mock Server HANET API Độc Lập (Cổng 9999)
- [x] Task 3.1: Xây dựng file `tests/mocks/hanet-mock-server.ts` bằng Fastify:
  - In-memory store `registeredFaces` (kiểm tra tính idempotent).
  - Tuyến `POST /person/register`: mô phỏng `EXCEED_QUOTA` (-9008), `EXPIRED_TOKEN` (-103), `CONFLICT_DIFFERENT_PERSON` (-9005), và Success (0).
  - Tuyến `POST /auth/refreshToken`: trả về token mới.
  - Hàm `startMockHanet()` khởi chạy server tại cổng 9999.
*Checkpoint Verification:* Khởi chạy mock server độc lập và gọi cURL thử nghiệm 4 scenarios.

### Phase 4: Test Suite Tự Động Vitest (`tests/registration.spec.ts`)
- [x] Task 4.1: Xây dựng file `tests/registration.spec.ts` theo đúng đặc tả:
  - `describe('Tầng Kiểm Tra Định Dạng (Validator Engine)')`: 4 test cases cho 9 ký tự, legacy 17 ký tự, invalid format, missing person_id.
  - `describe('Tầng Worker & Ngoại Lệ HANET')`: 3 test cases cho Case 0, Case -9008 (pause queue & redis key), Case -9005 (DB conflict_pending_review).
*Checkpoint Verification:* Chạy lệnh `npx vitest run tests/registration.spec.ts` đạt **7/7 tests PASSED**.

### Phase 5: Tuyến API Nộp Hồ Sơ & Script E2E Runner (`scripts/test-registration-flow.ts`)
- [x] Task 5.1: Bổ sung endpoint `POST /api/registration/submit` trong Fastify API (`apps/api`) kiểm tra validator trước khi tiếp nhận:
  - Alias sai chuẩn -> trả về HTTP 400/422.
  - Alias hợp lệ 9 ký tự -> Enqueue và trả về HTTP 200/201.
- [x] Task 5.2: Xây dựng file `scripts/test-registration-flow.ts` mô phỏng nộp ảnh qua API với cả 2 trường hợp (hợp lệ vs vi phạm định dạng).
*Checkpoint Verification:* Chạy `npx tsx scripts/test-registration-flow.ts` và xác nhận API trả về 200 cho mã hợp lệ và 422 cho mã sai.

## 4. Handoff Trigger
- Khi người dùng phản hồi **"Proceed"**, Agent chuyển sang Code Mode và thực thi tuần tự từ Phase 1 đến Phase 5.
