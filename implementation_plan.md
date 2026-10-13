# Implementation Plan: Kiến Trúc Snapshot Dump Nội Bộ & Chiến Lược 2-Phase AliasID (FNV-1a Base36 + QR Token Cố Định)

## 1. Architectural Context & Constraints
- **Hardware/VPS Limits:**
  - VPS Ubuntu: 3 vCPU, 3.0 GB RAM, 20 GB SSD, 2.0 GB Swap.
  - Trần RAM Docker Containers $\le$ 2.112 MB (`app_proxy`: 128 MB, `app_postgres`: 512 MB, `app_redis`: 192 MB, `app_api`: 512 MB, `app_worker`: 768 MB).
  - BullMQ Worker: `concurrency = 1`, `lockDuration = 120000ms`, Cooldown `3000ms`/job khi chạy batch, Nginx `client_max_body_size = 5M`.
- **Hiến Pháp Dự Án ([rules/00-constitution.md](file:///Users/dragonnet/Documents/thanh_Giuse/rules/00-constitution.md) Điều 3 & Điều 4):**
  - Định danh `alias_id` chuẩn 9 ký tự bất biến: `^[A-Za-z]{2}[A-Za-z0-9]{2}_[A-Za-z0-9]{4}$` ($\text{Prefix}_4 + \text{"\_"} + \text{Suffix}_4$).
  - Cột `alias_id` cho phép `NULL` khi khởi tạo danh sách từ Excel (chưa có `person_id` trên HANET Cloud).
  - Cột `qr_token` cố định 16 ký tự URL-safe (`crypto.randomBytes(12).toString('base64url')`), sinh ngay từ lúc khởi tạo và không bao giờ thay đổi.
- **Affected Files:**
  - [docker/postgres/init.sql](file:///Users/dragonnet/Documents/thanh_Giuse/docker/postgres/init.sql)
  - `docker/postgres/migrations/003_snapshot_and_2phase_alias.sql` (Tạo mới)
  - [packages/shared-types/src/hanet-cloud.ts](file:///Users/dragonnet/Documents/thanh_Giuse/packages/shared-types/src/hanet-cloud.ts) & [packages/shared-types/src/hanet-cloud.test.ts](file:///Users/dragonnet/Documents/thanh_Giuse/packages/shared-types/src/hanet-cloud.test.ts)
  - [packages/shared-infra/src/repositories/studentRepository.ts](file:///Users/dragonnet/Documents/thanh_Giuse/packages/shared-infra/src/repositories/studentRepository.ts) & [logRepository.ts](file:///Users/dragonnet/Documents/thanh_Giuse/packages/shared-infra/src/repositories/logRepository.ts)
  - [apps/api/src/index.ts](file:///Users/dragonnet/Documents/thanh_Giuse/apps/api/src/index.ts) & [apps/api/src/routes/admin.ts](file:///Users/dragonnet/Documents/thanh_Giuse/apps/api/src/routes/admin.ts)
  - [apps/worker/src/processor.ts](file:///Users/dragonnet/Documents/thanh_Giuse/apps/worker/src/processor.ts) & [apps/worker/src/processors/update-alias.processor.ts](file:///Users/dragonnet/Documents/thanh_Giuse/apps/worker/src/processors/update-alias.processor.ts)
  - [apps/admin/src/components/hanet/CloudFaceInspectorTab.tsx](file:///Users/dragonnet/Documents/thanh_Giuse/apps/admin/src/components/hanet/CloudFaceInspectorTab.tsx)
  - `scripts/snapshot-and-seed-1200.ts` & `scripts/cleanup-staging-faces.ts` (Tạo mới)
  - [tests/sync-alias-reconciliation.spec.ts](file:///Users/dragonnet/Documents/thanh_Giuse/tests/sync-alias-reconciliation.spec.ts)

---

## 2. Technical Decisions (From Clarification)
- **Database Layer:** PostgreSQL 16 + Raw SQL (`pg` Pool), không dùng ORM nặng.
  - Bảng `students`: Cho phép `alias_id` NULL; bổ sung `qr_token VARCHAR(32) UNIQUE NOT NULL`, `cloud_alias_synced BOOLEAN DEFAULT FALSE`, `is_updating BOOLEAN DEFAULT FALSE`.
  - Bảng `staging_cloud_faces`: Lưu trữ Snapshot 1 lần của 140 học sinh từ HANET Cloud phục vụ đối soát Set-based SQL (< 50ms).
  - Bảng `logs` & `admin_requests`: Bổ sung `student_id INT REFERENCES students(id) ON DELETE SET NULL`, cho phép `admin_requests.alias_id` NULL.
  - Partial Index tối ưu retry ngầm: `CREATE INDEX idx_students_cloud_synced ON students(cloud_alias_synced) WHERE status = 'success';`.
- **Giai đoạn 1 — Khởi tạo Offline 100% trong DB & RAM (Snapshot Dump & Set-Based Mapping):**
  1. **Tiền xử lý In-Memory trước khi mở Transaction (Chống giữ Lock bảng lâu):**
     - Đọc toàn bộ file CSV/Excel (1.200 học sinh), sinh sẵn mảng `qr_token` và chuẩn bị toàn bộ dữ liệu Snapshot (140 học sinh) trong bộ nhớ RAM **trước khi** mở kết nối `BEGIN`.
  2. **Bọc Transaction Nguyên Khối Siêu Tốc (< 100ms, `BEGIN ISOLATION LEVEL READ COMMITTED ... COMMIT` / `ROLLBACK`):**
     - **Bước 2a:** Thực thi Batch Insert qua `UNNEST` nạp `staging_cloud_faces`, `classes`, và 1.200 học sinh vào `students` (`status = 'empty'`, `alias_id = NULL`, `qr_token` 16 ký tự cố định).
     - **Bước 2b (SQL Set-based Update < 50ms):** Khớp theo `(target_class_id, normalized_name)` cho các tên duy nhất trong lớp $\rightarrow$ Cập nhật `person_id`, `face_url`, `alias_id = stg.raw_alias`, `status = 'success'`, `cloud_alias_synced = TRUE` (bảo toàn `qr_token` gốc).
     - **Bước 2c (Phương án 1 - Auto-INSERT học sinh phát sinh ngoài Excel):** Tự động `INSERT` các bản ghi còn lại trong `staging_cloud_faces` (chưa khớp tên với Excel) vào bảng `students` theo `target_class_id`, giữ nguyên `raw_alias`, `person_id`, `face_url`, sinh `qr_token` mới, `status = 'success'`, `cloud_alias_synced = TRUE`.
     - Nếu xảy ra bất kỳ lỗi nào, `ROLLBACK` toàn bộ để đưa dữ liệu về trạng thái sạch, chống hiện tượng half-baked data.
  3. **Chính sách Dọn dẹp Bảng Nháp (Staging Cleanup Policy - Bảo vệ 20GB SSD):**
     - Duy trì dữ liệu trong `staging_cloud_faces` trong vòng **7 ngày** kể từ lúc seed để phục vụ Admin đối soát trên giao diện Cloud Face Inspector.
     - Cung cấp script `scripts/cleanup-staging-faces.ts` và API endpoint Admin (`POST /api/admin/staging/cleanup`) thực thi `TRUNCATE TABLE staging_cloud_faces;` để giải phóng dung lượng ổ cứng SSD.
- **Giai đoạn 2 — Chiến lược "2-Phase AliasID" khi Đăng ký mới (1.060 học sinh):**
  - **Pha 1 (Đăng ký bảo toàn Lớp bằng Alias Tạm):**
    - Sinh `tempAliasId = Prefix4 + "_" + RandomSuffix4` (4 ký tự Base36 in hoa, khớp tuyệt đối Regex 9 ký tự).
    - Gọi `hanetClient.registerByUrl({ aliasID: tempAliasId, ... })`. Nếu đứt mạng/mất điện ngay sau bước này, trên HANET Cloud học sinh vẫn nằm đúng lớp `Prefix4`.
  - **Pha 2 (Chuyển đổi mã băm chuẩn FNV-1a nội bộ Local-first):**
    - Ngay khi nhận `personID` và `faceUrl` từ HANET:
      $$\text{Suffix}_4 = \text{padStart4}\Big(\big(((\text{FNV1a\_32}(\text{personID}) \ggg 0) + \text{attempt}) \bmod 36^4\big)\text{.toString}(36)\Big)\text{.toUpperCase()}$$
    - Áp dụng **Deterministic Linear Probing (`attempt = 0..3`)** chống va chạm Hash trong cùng một lớp.
    - Cập nhật Database nội bộ trước: `status = 'success'`, `person_id`, `face_url`, `alias_id = finalAliasId`, `cloud_alias_synced = FALSE`.
  - **Đồng bộ Cloud (Soft-fail / Non-blocking) & Guard 30s cho Job Retry:**
    - Trong khối `try/catch`, Worker gọi `hanetClient.updateAliasID({ personID, aliasID: finalAliasId })` (kèm `delay(120ms)` + `addPersonToDepartment` nếu có `departmentID` để bảo toàn phòng ban theo Điều 4.3 Hiến pháp).
    - Nếu thành công: Cập nhật `cloud_alias_synced = TRUE`.
    - Nếu gặp lỗi mạng: **Không đánh trượt học sinh**, giữ nguyên `status = 'success'` và `cloud_alias_synced = FALSE`.
    - **Chốt chặn chống Race Condition khi Retry ngầm:** Khi quét các bản ghi `status = 'success' AND cloud_alias_synced = FALSE` để đưa vào hàng đợi retry, truy vấn SQL bắt buộc có điều kiện `AND updated_at < NOW() - INTERVAL '30 seconds'` nhằm tránh retry đè lên một Job nộp ảnh mới vừa hoàn tất Pha 2 vài giây trước đó.
- **Phân tầng Ưu tiên Hàng đợi BullMQ (Queue Priority Separation cho `concurrency = 1`):**
  - **`priority: 1` (Cao nhất):** Job học sinh/giáo viên đổi ảnh ưu tiên qua kênh cá nhân (`/u/:qr_token`) hoặc Admin Override.
  - **`priority: 5` (Trung bình - Thực thời):** Job học sinh nộp ảnh đăng ký mới trực tiếp tại lớp (`/c/:class_code`).
  - **`priority: 20` (Thấp - Chạy nền):** Job đồng bộ hàng loạt (`Batch Alias Sync` từ Cloud Inspector / Retry ngầm các bản ghi `cloud_alias_synced = FALSE` kèm cooldown `3.000ms`).
- **Tách biệt 2 Luồng Nghiệp vụ & Khóa Nguyên Tử:**
  - **Luồng 1 (`/c/:class_code`):** `claimStudentForClassRegister` chỉ nhận `status IN ('empty', 'error', 'manual_review')`, chặn tuyệt đối `status = 'success'`.
  - **Luồng 2 (`/u/:qr_token`):** `claimStudentForTokenSelfService` xác thực bằng `qr_token`; khi `status = 'success'` muốn đổi ảnh thì bật `is_updating = TRUE`, đẩy Job `UPDATE_PHOTO` (`priority = 1`), và bảo toàn nguyên vẹn `status = 'success'` + `face_url` cũ nếu ảnh mới bị lỗi (`-9006`).
  - Định danh BullMQ Job và file ảnh tạm dùng `qr_token` (`student_${qr_token}`) thay vì `alias_id` để chống lỗi trùng `student_null`.

---

## 3. Phased Execution Checklist

### Phase 1: Database Schema & Migration (`docker/postgres/`)
- [x] Task 1.1: Tạo tệp `docker/postgres/migrations/003_snapshot_and_2phase_alias.sql`:
  - `ALTER TABLE students ALTER COLUMN alias_id DROP NOT NULL;`
  - Migration 3 bước an toàn cho `qr_token VARCHAR(32) UNIQUE NOT NULL`.
  - Bổ sung `cloud_alias_synced BOOLEAN DEFAULT FALSE` và `is_updating BOOLEAN DEFAULT FALSE` vào `students`.
  - Tạo bảng `staging_cloud_faces` phục vụ Snapshot Dump & Set-based SQL Mapping.
  - Bổ sung `student_id` vào `logs` và `admin_requests`, bỏ `NOT NULL` trên `admin_requests.alias_id`.
  - Tạo các index: `idx_students_qr_token`, `idx_students_class_id_status`, `idx_students_alias_id`, và Partial Index `idx_students_cloud_synced`.
- [x] Task 1.2: Đồng bộ cấu trúc DDL vào [docker/postgres/init.sql](file:///Users/dragonnet/Documents/thanh_Giuse/docker/postgres/init.sql).
*Checkpoint Verification:* Chạy kiểm tra cú pháp SQL và áp dụng migration thành công với 0 lỗi.

### Phase 2: Core Hash Engine & Shared Repositories (`packages/shared-types` & `packages/shared-infra`)
- [x] Task 2.1: Cập nhật [packages/shared-types/src/hanet-cloud.ts](file:///Users/dragonnet/Documents/thanh_Giuse/packages/shared-types/src/hanet-cloud.ts):
  - Nâng cấp `generateDeterministicSuffix4(personID: string, attempt = 0)` với phép toán `(((hash >>> 0) + attempt) % 1679616).toString(36).padStart(4, '0').toUpperCase()`.
  - Bổ sung hàm `generateTempAliasId(classCode: string)` (`Prefix4_Random4` Base36 in hoa) và `generateQrToken()` (`crypto.randomBytes(12).toString('base64url')`).
  - Sửa lỗi bắt `ERR_EMPTY_SEGMENT` trong `parseAndClassifyAlias` khi gặp thành phần rỗng (`TN__01`).
- [x] Task 2.2: Cập nhật [packages/shared-types/src/hanet-cloud.test.ts](file:///Users/dragonnet/Documents/thanh_Giuse/packages/shared-types/src/hanet-cloud.test.ts) đồng bộ chuẩn 9 ký tự.
- [x] Task 2.3: Nâng cấp [packages/shared-infra/src/repositories/studentRepository.ts](file:///Users/dragonnet/Documents/thanh_Giuse/packages/shared-infra/src/repositories/studentRepository.ts):
  - Triển khai `resolveUniqueFinalAliasId(classCode, personId, excludeStudentId)` với Linear Probing (`attempt = 0..3`).
  - Tách biệt `claimStudentForClassRegister` và `claimStudentForTokenSelfService`.
  - Bổ sung `markPhase2LocalSuccess`, `markCloudAliasSynced`, `getUnsyncedCloudAliasesForRetry` (có điều kiện `updated_at < NOW() - INTERVAL '30 seconds'`), `findByQrToken`, `getStudentsByClassCode`.
*Checkpoint Verification:* Chạy unit test `packages/shared-types` và `npm run build:packages` thành công 100%.

### Phase 3: Snapshot Mapping Pipeline (In-Memory Prep + <100ms Transaction) & API Queue Priority (`scripts/` & `apps/api`)
- [x] Task 3.1: Xây dựng module/script Giai đoạn 1 (`scripts/snapshot-and-seed-1200.ts` & `scripts/cleanup-staging-faces.ts`):
  - Đọc và chuẩn hóa toàn bộ dữ liệu Excel/CSV + Snapshot vào bộ nhớ RAM **trước khi** mở Transaction.
  - Mở `BEGIN ISOLATION LEVEL READ COMMITTED`, thực thi Batch `UNNEST` Insert + Set-based `UPDATE` + Auto-`INSERT` học sinh phát sinh ngoài Excel (Phương án 1) và `COMMIT` trong vòng **< 100ms** (`ROLLBACK` ngay nếu có lỗi).
  - Cung cấp tiện ích dọn dẹp `TRUNCATE TABLE staging_cloud_faces;` sau 7 ngày đối soát để bảo vệ ổ cứng SSD 20GB.
- [x] Task 3.2: Cập nhật [apps/api/src/index.ts](file:///Users/dragonnet/Documents/thanh_Giuse/apps/api/src/index.ts):
  - Hỗ trợ Luồng 1 (`GET /api/classes/:classCode/students`, `POST /api/students/:studentId/register` & `/photo`): Dùng `qr_token` làm BullMQ `jobId` và tên file ảnh tạm, gán **`priority: 5`**.
  - Hỗ trợ Luồng 2 (`GET /api/students/token/:qrToken`, `POST /api/students/token/:qrToken/photo`): Cho phép sửa lỗi (`priority: 5` nếu đăng ký mới) và đổi ảnh ưu tiên (**`priority: 1`** khi `actionType = 'UPDATE_PHOTO'`).
- [x] Task 3.3: Tối ưu [apps/api/src/routes/admin.ts](file:///Users/dragonnet/Documents/thanh_Giuse/apps/api/src/routes/admin.ts) (`POST /api/admin/hanet/sync-cloud-aliases` & `/sync-alias`):
  - Ưu tiên đọc Redis cache `cache:hanet:real_cloud_faces` chống `504 Gateway Timeout`, validate `person_ids`, áp dụng In-Memory Probing.
  - Gán **`priority: 20`** cho các job đồng bộ hàng loạt (`Batch Alias Sync` / Retry ngầm `cloud_alias_synced = FALSE` với điều kiện `updated_at < NOW() - INTERVAL '30 seconds'`).
*Checkpoint Verification:* Build `@thanh-giuse/api` thành công 0 lỗi TypeScript.

### Phase 4: Worker 2-Phase AliasID Processor & Admin UI (`apps/worker` & `apps/admin`)
- [x] Task 4.1: Nâng cấp [apps/worker/src/processor.ts](file:///Users/dragonnet/Documents/thanh_Giuse/apps/worker/src/processor.ts) triển khai trọn vẹn chiến lược **2-Phase AliasID**:
  - **Pha 1:** Dùng `tempAliasId = Prefix4_Random4` gọi `hanetClient.registerByUrl`.
  - **Pha 2:** Nhận `personID` $\rightarrow$ Tính `finalAliasId` (FNV-1a + Linear Probing) $\rightarrow$ Cập nhật DB nội bộ (`status = 'success'`, `cloud_alias_synced = FALSE`).
  - **Đồng bộ Cloud (Soft-fail):** Gọi `updateAliasID` (+ `addPersonToDepartment` nếu có phòng ban) trong khối `try/catch`; nếu thành công đổi `cloud_alias_synced = TRUE`, nếu lỗi mạng vẫn giữ `status = 'success'` và ghi log để retry ngầm sau 30 giây.
  - Khi xử lý `UPDATE_PHOTO` cho học sinh đã `success` mà ảnh mới lỗi (`-9006`): Bảo toàn `status = 'success'`, `person_id`, `face_url` cũ và tắt `is_updating = FALSE`.
- [x] Task 4.2: Trong [apps/worker/src/processors/update-alias.processor.ts](file:///Users/dragonnet/Documents/thanh_Giuse/apps/worker/src/processors/update-alias.processor.ts), bọc `try/catch` bắt lỗi Postgres `23505` (`unique_violation`) chuyển sang `manual_review` / `sync_conflicts` và đảm bảo luôn gọi `recordBatchProgress` để thanh tiến độ đạt 100%.
- [x] Task 4.3: Trong [apps/admin/src/components/hanet/CloudFaceInspectorTab.tsx](file:///Users/dragonnet/Documents/thanh_Giuse/apps/admin/src/components/hanet/CloudFaceInspectorTab.tsx), tự động xóa `selectedPersonIds` (`setSelectedPersonIds(new Set())`) sau khi kích hoạt batch action và trong callback `onCompleted`.
*Checkpoint Verification:* Build `@thanh-giuse/worker` và `@thanh-giuse/admin` thành công 100%.

### Phase 5: Kiểm Thử Tự Động & Hồi Quy (`tests/`)
- [x] Task 5.1: Cập nhật [tests/sync-alias-reconciliation.spec.ts](file:///Users/dragonnet/Documents/thanh_Giuse/tests/sync-alias-reconciliation.spec.ts) bổ sung các kịch bản:
  - Kiểm thử chiến lược **2-Phase AliasID** (`tempAliasId` $\rightarrow$ `registerByUrl` $\rightarrow$ `finalAliasId` $\rightarrow$ `updateAliasID` thành công & kịch bản Soft-fail khi `updateAliasID` lỗi mạng vẫn giữ `status = 'success'`, `cloud_alias_synced = FALSE`).
  - Kiểm thử truy vấn retry `cloud_alias_synced = FALSE` tôn trọng khoảng đệm `updated_at < NOW() - INTERVAL '30 seconds'`.
  - Kiểm thử Giai đoạn 1 In-Memory Prep + `< 100ms` Transaction (`READ COMMITTED` + `ROLLBACK` khi lỗi) + Auto-`INSERT` (Phương án 1) + dọn dẹp `TRUNCATE TABLE staging_cloud_faces`.
  - Kiểm thử phân tầng ưu tiên hàng đợi (`priority: 1` vs `priority: 5` vs `priority: 20`).
  - Kiểm thử đệm `'0'` (`padStart(4, '0')`), Linear Probing (`attempt = 0..3`) và bắt lỗi `23505`.
- [x] Task 5.2: Chạy toàn bộ test suite `npx vitest run` đạt 100% PASS.
*Checkpoint Verification:* Tất cả các bài test trong `tests/` vượt qua 100%.

---

## 4. Handoff Trigger
- Khi người dùng phản hồi **"Proceed"**, **"Approved"** hoặc **"Đồng ý"**, Agent chuyển sang Code Mode và thực thi tuần tự từ Phase 1.
