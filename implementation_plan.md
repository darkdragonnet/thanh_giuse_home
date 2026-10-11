# Implementation Plan: Hệ Thống Đối Soát & Đồng Bộ AliasID (HANET Cloud <-> VPS PostgreSQL)

## 1. Architectural Context & Constraints
- **Hardware/VPS Limits:** VPS Ubuntu 3 vCPU, 3.0 GB RAM, Swap 2.0 GB.
- **Container Resource Ceiling:**
  - `app_api`: Fastify 4+, RAM Limit tối đa **512 MB** (`--max-old-space-size=384`).
  - `app_worker`: BullMQ Worker, Concurrency = **1** bất biến, RAM Limit tối đa **768 MB**.
  - `app_redis`: Redis 7 AOF, `maxmemory 128mb`, `noeviction`, RAM Limit **192 MB**.
  - `app_postgres`: PostgreSQL 16, `shared_buffers=128MB`, RAM Limit **512 MB**.
  - `app_proxy`: Nginx alpine, `client_max_body_size 5M`, RAM Limit **128 MB**.
- **Hiến Pháp Dự Án & Ràng Buộc Kỹ Thuật (Rules 00 & 01):**
  - **Định danh cố định 9 ký tự:** Mọi `alias_id` bắt buộc đúng 9 ký tự, khớp regex: `^[A-Za-z]{2}[A-Za-z0-9]{2}_[A-Za-z0-9]{4}$`. Tầng API và Worker kích hoạt validation chặn ngay nếu chuỗi khác 9 ký tự.
  - **Bảo tồn tuyệt đối PersonID:** TUYỆT ĐỐI KHÔNG xóa bất kỳ `person_id` nào trong hệ thống, loại bỏ triệt để endpoint `removePersonByID`.
  - **Quy trình 2 bước bảo toàn phòng ban:** Cập nhật `aliasID` bắt buộc gọi `POST /person/updateAliasID` $\rightarrow$ delay(120ms) $\rightarrow$ `POST /department/add-person`.
  - **Xử lý sự cố Token (-103):** Kích hoạt Global Kill Switch lập tức, tạm dừng hàng đợi (`queue.pause()`), giữ nguyên trạng thái bản ghi hiện tại và retry count, chờ Admin thay token trong `.env` và restart container.
  - **Lỗi không tìm thấy người (-5011):** Chuyển sang `manual_review`, cấm Worker tự động xóa person_id và cấm tự re-register ngầm.
  - **Giao thức UI:** Tuân thủ ADR-004, sử dụng HTTP Short Polling (3 giây/lần), không mở kết nối WebSocket hay SSE.
- **Affected Files:**
  - `packages/hanet-client/src/index.ts` & `packages/hanet-client/src/types.ts`
  - `packages/shared-types/src/` (bổ sung types payload và action logs)
  - `apps/api/src/routes/admin.ts`
  - `apps/worker/src/worker.ts` & `apps/worker/src/processor.ts`
  - `apps/admin/src/components/hanet/CloudFaceInspectorTab.tsx`
  - `apps/admin/src/components/hanet/SyncProgressDrawer.tsx` (tạo mới)
  - `apps/admin/src/components/hanet/ManualReviewModal.tsx` (tạo mới)
  - `tests/sync-alias-reconciliation.spec.ts` (tạo mới)

---

## 2. Technical Decisions & Core Implementation Rules

### 2.1. Tầng Fastify API (`POST /admin/sync-alias`)
1. **Kiểm tra trạng thái & Atomic Conditional Update:**
   - Chỉ các bản ghi có trạng thái thích hợp (`empty`, `error`, `manual_review`, `conflict_pending_review` hoặc các bản ghi có lệch dữ liệu `synced`/`success` cần re-sync) mới được phép chuyển sang `pending`.
   - Sử dụng câu lệnh Atomic Update có điều kiện `WHERE status IN (...) RETURNING id, class_id, alias_id, person_id` để loại bỏ hoàn toàn Race Condition khi Admin nhấn đồng bộ nhiều lần.
2. **Quản lý Bộ Nhớ Đệm Redis (128MB ceiling):**
   - Khóa tiến trình `batch:${batchId}` lưu dạng Redis Hash (`total`, `processed`, `success`, `failed`, `is_done`).
   - Bắt buộc gắn TTL tự động `EXPIRE batch:${batchId} 7200` (2 giờ) ngay tại thời điểm khởi tạo, bảo vệ nghiêm ngặt hạn mức RAM Redis.
3. **Payload Linh Hoạt & Tối Ưu Băng Thông:**
   - Body hỗ trợ 2 chế độ:
     - Chọn danh sách lẻ: `{ student_ids: [1, 2, 3] }`.
     - Đồng bộ toàn bộ lớp: `{ class_id: 10 }` (Backend tự truy vấn danh sách học sinh thuộc lớp, frontend không cần truyền mảng ID khổng lồ).

### 2.2. Tầng Worker (`apps/worker`)
1. **Ánh Xạ Phòng Ban (`departmentID`) cho Quy Trình 2 Bước:**
   - Tầng API hoặc Worker truy vấn `department_code` (hoặc mapping tương ứng trên HANET) từ bảng `classes` thông qua `class_id` của học sinh.
   - Truyền `departmentID` chuẩn xác vào bước 3 (`addPersonToDepartment`) để khóa nhân sự vào đúng phòng ban trên Cloud.
2. **Bảo Toàn Thứ Tự Ưu Tiên Hàng Đợi (BullMQ Priority):**
   - Tác vụ Admin Đồng bộ/Đối soát được gán `{ priority: 1 }`.
   - Tác vụ Học sinh tự nộp ảnh thông thường gán `{ priority: 10 }`.
   - Mặc dù `concurrency = 1`, BullMQ bảo đảm các job quản trị được ưu tiên thực thi trước mà không bị tắc nghẽn sau các job người dùng phổ thông.

### 2.3. Tầng Giao Diện Admin SPA
1. **Giảm Tải Request Body & Tối Ưu Validation:**
   - Khi chọn nút *"Đồng bộ toàn bộ lớp"*, modal chỉ gửi `{ class_id }`, payload siêu nhẹ (< 100 bytes), tiết kiệm băng thông và tài nguyên CPU kiểm tra JSON Schema.
2. **Điều Khiển Polling An Toàn:**
   - Quản lý chu kỳ 3.000 ms qua Hook `usePolling`, tự động hủy interval khi batch hoàn tất (`is_done: true`), khi đóng drawer hoặc khi chuyển tab (`document.visibilityState === 'hidden'`).

---

## 3. Phased Execution Checklist

### Phase 1: Mở Rộng Client SDK & Fastify API Routes (`app_api`)
- [x] Task 1.1: Mở rộng `packages/hanet-client`:
  - Thêm phương thức `updateAliasID(params: { personID: string; aliasID: string })` gọi `POST /person/updateAliasID`.
  - Thêm phương thức `addPersonToDepartment(params: { personID: string; departmentID: string | number })` gọi `POST /department/add-person`.
- [x] Task 1.2: Xây dựng Fastify Route `POST /admin/sync-alias`:
  - Khai báo Ajv Schema kiểm tra `student_ids?: number[]`, `class_id?: number`.
  - Xử lý phân luồng: nếu có `class_id`, tự query danh sách học sinh trong DB; nếu có `student_ids`, lọc danh sách.
  - Thực thi Atomic Conditional Update:
    ```sql
    UPDATE students 
    SET status = 'pending', updated_at = NOW() 
    WHERE id = ANY($1) AND status IN ('empty', 'error', 'manual_review', 'conflict_pending_review', 'success', 'synced')
    RETURNING id, class_id, alias_id, person_id;
    ```
  - Enqueue BullMQ `registration_queue` với `{ priority: 1 }`, tên job: `update_alias` (nếu đã có `person_id`) hoặc `register_face` (nếu chưa có `person_id`).
  - Khởi tạo Redis Hash `batch:${batchId}` và thiết lập `EXPIRE batch:${batchId} 7200` (2 giờ).
  - Trả về HTTP 202 `{ success: true, batchId, queuedCount }`.
- [x] Task 1.3: Xây dựng Fastify Route `GET /admin/sync-batches/:batchId/status`:
  - Đọc trực tiếp từ Redis Hash `batch:${batchId}` và trả về tiến độ realtime cho Short Polling.
- [x] Task 1.4: Xây dựng Fastify Route `POST /admin/reconcile-cloud`:
  - Kích hoạt tải danh sách từ HANET Cloud qua `getListByPlace`, ghi cache Redis 10 phút và thực hiện bulk upsert đối soát lô nhỏ 50–100 dòng qua UNNEST.
*Checkpoint Verification:* Chạy cURL kiểm tra `POST /admin/sync-alias` với `{ class_id }` và `{ student_ids }`, xác nhận DB cập nhật `pending`, Redis set TTL 7200s và BullMQ nhận job với priority = 1.

---

### Phase 2: Tầng Hàng Đợi & Xử Lý Worker (`app_worker`)
- [x] Task 2.1: Cập nhật Job Router trong `apps/worker/src/worker.ts`:
  - Phân luồng xử lý theo `job.name`:
    - `update_alias`: Chuyển cho handler cập nhật alias.
    - `register_face` / default: Tiếp tục thực thi `processRegistrationJob`.
    - `sync_hanet_2000`: Chuyển cho `handleHanetSync2000`.
- [x] Task 2.2: Hiện thực hóa Handler `update_alias`:
  - Chốt chặn an toàn: Kiểm tra regex 9 ký tự trước khi gọi mạng (`^[A-Za-z]{2}[A-Za-z0-9]{2}_[A-Za-z0-9]{4}$`).
  - Truy vấn `department_code` tương ứng từ bảng `classes` theo `student.class_id`.
  - Bước 1: Gọi `hanetClient.updateAliasID({ personID, aliasID: newAlias })`.
  - Bước 2: `delay(120ms)` kiểm soát rate limit.
  - Bước 3: Gọi `hanetClient.addPersonToDepartment({ personID, departmentID })`.
  - Cập nhật database: Cập nhật `alias_id` mới vào bảng `students`, status = `'success'`.
  - Cập nhật Redis Batch Hash: Tăng trường `success` và kiểm tra đánh dấu `is_done = true` khi hoàn thành toàn bộ job trong batch.
- [x] Task 2.3: Xử lý các mã lỗi đặc thù trong luồng `update_alias`:
  - Mã `-103`: Bật Kill Switch toàn hệ thống, tạm dừng hàng đợi (`queue.pause()`), giữ nguyên trạng thái bản ghi học sinh và retry count.
  - Mã `-9008`: Tạm dừng hàng đợi, bật Kill Switch, ném UnrecoverableError.
  - Mã `-5011`: Chuyển `status = 'manual_review'`, ghi mã `-5011` vào `last_error_code`, kết thúc job để giải phóng worker. Tuyệt đối không xóa `person_id`.
  - Mã `-9005`: Nếu trùng đúng alias -> Idempotent Pass; nếu trùng người khác -> ghi nhận vào bảng `sync_conflicts` và chuyển `status = 'manual_review'`.
  - Mã `-503`: Ném `HanetServiceUnavailableError` để BullMQ kích hoạt backoff 300s.
*Checkpoint Verification:* Giả lập chạy 1 job `update_alias` qua mock server, xác nhận thực hiện đủ 2 bước kèm departmentID đúng; giả lập lỗi -103 xác nhận queue đóng băng và trạng thái học sinh được bảo toàn.

---

### Phase 3: Giao Diện Quản Trị (Admin SPA Frontend)
- [x] Task 3.1: Nâng cấp [CloudFaceInspectorTab.tsx](file:///Users/dragonnet/Documents/thanh_Giuse/apps/admin/src/components/hanet/CloudFaceInspectorTab.tsx):
  - Bổ sung cột Checkbox chọn từng dòng hoặc chọn toàn bộ trên trang.
  - Bổ sung Action Bar:
    - Nút *"Đồng bộ đã chọn"*: Gửi `{ student_ids }`.
    - Nút *"Đồng bộ toàn bộ lớp"*: Mở modal xác nhận và chỉ gửi `{ class_id }`.
  - Hiển thị badge trạng thái: Chưa có trên Cloud, Khớp hoàn toàn, Lệch AliasID, Xung đột khuôn mặt (-9005), Lỗi đồng bộ.
- [x] Task 3.2: Tạo Component `SyncProgressDrawer.tsx`:
  - Nhận `batchId` khi Admin kích hoạt đồng bộ.
  - Sử dụng hook `usePolling` gọi `GET /admin/sync-batches/:batchId/status` mỗi 3.000 ms.
  - Tự động dừng polling khi `is_done: true`, khi đóng drawer hoặc khi tab chuyển sang ẩn (`visibilitychange`).
  - Hiển thị thanh tiến trình trực quan, thống kê số lượng thành công, lỗi, đang xử lý.
- [x] Task 3.3: Tạo Component `ManualReviewModal.tsx`:
  - Hiển thị danh sách các ca bị vướng `-5011` hoặc `-9005`.
  - Cho phép Admin xem ảnh đối chiếu 2 bên, nhập ghi chú giải quyết xung đột thủ công.
*Checkpoint Verification:* Mở giao diện Admin trên trình duyệt, thử chọn 1 lớp để bấm "Đồng bộ toàn bộ lớp", kiểm tra Network tab chỉ gửi `{ class_id }`, drawer mở ra và cập nhật tiến độ mỗi 3 giây.

---

### Phase 4: Kiểm Thử Tích Hợp & Kiểm Toán An Toàn (Verification)
- [x] Task 4.1: Xây dựng test suite Vitest `tests/sync-alias-reconciliation.spec.ts`:
  - Test Case 1: Validate đầu vào chặn các alias khác 9 ký tự.
  - Test Case 2: Kiểm tra quy trình 2 bước gọi HANET API đúng thứ tự kèm delay 120ms và đúng departmentID.
  - Test Case 3: Mô phỏng lỗi -103 xác nhận Kill Switch được kích hoạt và student record không bị đánh trượt.
  - Test Case 4: Mô phỏng lỗi -5011 xác nhận chuyển manual_review và không bị xóa person_id.
- [x] Task 4.2: Kiểm toán tài nguyên bộ nhớ (Memory Safety Check):
  - Chạy kịch bản đồng bộ lô 100 học sinh, giám sát mức tiêu thụ RAM container:
  - `app_api` duy trì dưới 512 MB.
  - `app_worker` duy trì dưới 768 MB với Concurrency = 1.
*Checkpoint Verification:* Lệnh `npm test` chạy toàn bộ test suite đạt 100% PASS; kiểm tra `docker stats` xác nhận RAM nằm trong giới hạn an toàn của VPS 3GB.

---

## 4. Handoff Trigger
- Khi người dùng phản hồi **"Proceed"**, **"Approved"** hoặc **"Đồng ý"**, Agent chuyển sang Code Mode và thực thi tuần tự từ Phase 1.
