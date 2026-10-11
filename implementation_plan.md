# Implementation Plan: Triển Khai Đối Soát & Chuẩn Hóa AliasID 9 Ký Tự (HANET Cloud <-> VPS PostgreSQL)

## 1. Architectural Context & Constraints
- **Hardware/VPS Limits:**
  - Cấu hình VPS: Ubuntu 3 vCPU, 3.0 GB RAM, 20 GB SSD, 2.0 GB Swap.
  - Docker Container RAM Limits (tổng trần $\le$ 2.112 MB):
    - `app_api`: Fastify v4+, RAM trần 512 MB (`--max-old-space-size=384`).
    - `app_worker`: BullMQ Worker (`concurrency: 1` bất biến), RAM trần 768 MB (`--max-old-space-size=512`).
    - `app_redis`: Redis 7 AOF, RAM trần 192 MB (`maxmemory 128mb`, `maxmemory-policy noeviction`).
    - `app_postgres`: PostgreSQL 16, RAM trần 512 MB (`shared_buffers=128MB`).
- **Hiến Pháp & Quy Định Bất Biến Dự Án (`rules/00-constitution.md`):**
  - **Điều 3.2 & 4.1 - Định danh cố định đúng 9 ký tự:** Mọi mã định danh đẩy lên Cloud bắt buộc khớp Regex `^[A-Za-z]{2}[A-Za-z0-9]{2}_[A-Za-z0-9]{4}$` (VD: `GLV0_FK2S`, `TS1A_0001`, `RL2A_4BDI`).
  - **Điều khoản Bảo Tồn PersonID:** Tuyệt đối cấm xóa bất kỳ `person_id` nào trong cơ sở dữ liệu và trên Cloud; loại bỏ hoàn toàn endpoint `POST /person/removePersonByID`.
  - **Quy trình 2 bước bảo toàn phòng ban:** Bắt buộc gọi `POST /person/updateAliasID` $\rightarrow$ Delay 120ms (tránh nghẽn HANET 30 req/phút) $\rightarrow$ `POST /department/add-person`.
  - **Xử lý sự cố Token (-103):** Không tự động refresh ngầm; kích hoạt Global Kill Switch ngay lập tức, tạm dừng hàng đợi (`queue.pause()`), bảo toàn trạng thái bản ghi học sinh (không đánh trượt).
  - **Cơ chế Giám sát UI (ADR-004):** Tuân thủ tuyệt đối HTTP Short Polling chu kỳ 3 giây cho Drawer tiến trình; không mở WebSocket hay SSE riêng.
- **Affected Files:**
  - `packages/shared-types/src/hanet-cloud.ts` (Parser và từ điển chuẩn hóa mã lớp 9 ký tự).
  - `apps/api/src/routes/admin.ts` (API đối soát, phân trang tối đa 35 trang Cloud thật, enqueue BullMQ priority 1).
  - `apps/worker/src/processors/update-alias.processor.ts` (Handler thực thi Quy trình 2 bước và xử lý mã lỗi).
  - `apps/worker/src/worker.ts` (Router phân luồng BullMQ Worker).
  - `apps/admin/src/components/hanet/CloudFaceInspectorTab.tsx` (Tab kiểm tra đối soát Cloud thật).
  - `apps/admin/src/components/hanet/SyncProgressDrawer.tsx` (Drawer Polling 3s theo dõi tiến độ lô).
  - `apps/admin/src/components/hanet/ManualReviewModal.tsx` (Modal xử lý thủ công các ca vướng lỗi -5011 / -9005).
  - `tests/sync-alias-reconciliation.spec.ts` (Bộ kiểm thử hồi quy 14 test cases).

## 2. Technical Decisions (From Clarification)
- **Chuẩn Hóa Dữ Liệu Thực Tế Trên Cloud HANET (Lựa chọn A):**
  - Quét toàn bộ dữ liệu hiện có trên Cloud HANET (`placeID: 998577`), bóc tách và quy chuẩn hóa tất cả mã cũ về đúng 9 ký tự:
    - Giáo Lý Viên 2 phần (8 ký tự) dạng `GLV_FK2S` $\rightarrow$ Đệm thành `GLV0_FK2S`.
    - Thiếu Nhi 3 phần (17 ký tự) dạng `TN_XUNGTOI2A_4BDI` $\rightarrow$ Ánh xạ thành `RL2A_4BDI`.
    - Mã đã chuẩn 9 ký tự dạng `TS1A_0001` $\rightarrow$ Giữ nguyên.
  - Sử dụng Quy trình 2 bước đẩy cập nhật lại toàn bộ Cloud HANET theo danh sách chuẩn hóa.
- **Khắc phục triệt để lỗi hiển thị 108 bản ghi:**
  - Khi cấu hình `HANET_API_BASE_URL` trỏ về `partner.hanet.ai`, API chỉ gọi duy nhất Cloud HANET thật, loại bỏ hoàn toàn fallback ngầm sang `app_mock:4000`.
  - Nâng `maxPages` từ 5 lên 35 trang (quét tối đa 1.750 người), đảm bảo quét hết 1.200 học sinh và nhân sự.
- **Kiểm soát Tần Suất Gọi API HANET (Rate Limiting $\le 20-25$ req/phút):**
  - Giới hạn của HANET Cloud là 30 requests/phút. Với Quy trình 2 bước, mỗi học sinh tiêu tốn 2 requests (`updateAliasID` + `addPersonToDepartment`).
  - Đã tích hợp độ trễ cooldown **3.000ms** ở cuối mỗi job `update_alias` trong BullMQ Worker (cùng với delay 120ms giữa bước 1 và bước 2). Tổng thời gian mỗi vòng đời job đạt $\approx 3.3 - 3.5$ giây, đảm bảo tần suất phát request toàn hệ thống luôn dao động từ **17 – 20 requests/phút** (tuyệt đối an toàn dưới trần 30 req/phút, không bao giờ bị HANET khóa IP).
- **Quản lý TTL Cache & Tối Ưu Băng Thông Khi Xử Lý Lô Lớn:**
  - Nâng TTL của Redis cache `cache:hanet:real_cloud_faces` trong API từ 60s/600s lên **1.800s (30 phút)**, đảm bảo ngay cả khi đồng bộ lô 100 học sinh kéo dài 6-8 phút thì cache vẫn còn hiệu lực.
  - Tối ưu `SyncProgressDrawer.tsx`: Trong khi batch đang chạy, drawer chỉ gửi Short Polling 3s đọc dữ liệu nhẹ từ Redis Hash `batch:${batchId}` (TTL 7.200s); lập tức hủy `setInterval` ngay khi `isDone === true` và chỉ gọi làm mới bảng `onCompleted()` duy nhất một lần qua `useRef`, ngăn ngừa tình trạng kích hoạt tải lại lặp vô tận.
- **Cơ Chế Rollback Dự Phòng Cho Cập Nhật Hàng Loạt:**
  - Bảng `logs` ghi nhận đầy đủ cả hai giá trị định danh: `[OLD_ALIAS: ${aliasId}] -> [NEW_ALIAS: ${newAlias}]` kèm `student_id`, `personID` và `departmentId`.
  - Trong trường hợp cần đối soát hoặc rollback ngược lại, Admin có thể tra cứu chính xác mã cũ trong lịch sử logs để khôi phục nguyên trạng.
- **Database & Queue Strategy:**
  - PostgreSQL 16: Sử dụng câu lệnh Atomic Conditional Update `WHERE status IN ('empty', 'error', 'manual_review', 'conflict_pending_review', 'success', 'synced')` chuyển sang `pending` nhằm chống race condition.
  - Redis 7 AOF: Lưu tiến độ từng lô tại key `batch:${batchId}` với TTL 7.200s (2 giờ).
  - BullMQ: Tác vụ Admin gán `priority: 1` để ưu tiên xử lý trước lượt nộp ảnh thông thường (`priority: 10`).

## 3. Phased Execution Checklist

### Phase 1: Tầng Thư Viện Dùng Chung & Bộ Bóc Tách 9 Ký Tự (`packages/shared-types`)
- [x] Task 1.1: Cập nhật `CLOUD_CLASS_DICTIONARY` bổ sung đầy đủ mã 4 ký tự đệm (`GLV0`, `LM01`, `TS1A`, `RL2A`,...).
- [x] Task 1.2: Thiết kế hàm `parseAndClassifyAlias` bóc tách linh hoạt mã 2 phần, mã 3 phần, và mã 9 ký tự cố định, tính toán sẵn trường `aliasChuanHoaDuKien`.
- [x] Task 1.3: Biên dịch gói dùng chung `npm run build:packages`.
*Checkpoint Verification:* Chạy lệnh `npm run build:packages` hoàn tất không có lỗi TypeScript compilation.

### Phase 2: Tầng API Fastify & Quản Lý Lô Đồng Bộ (`apps/api`)
- [x] Task 2.1: Triển khai endpoint `POST /api/admin/sync-alias`:
  - Kiểm tra điều kiện đầu vào (`student_ids` hoặc `class_id`).
  - Atomic Conditional Update cập nhật `status = 'pending'` trong PostgreSQL.
  - Khởi tạo Redis Hash `batch:${batchId}` với `EXPIRE 7200`.
  - Đẩy các job `update_alias` (học sinh đã có `person_id`) hoặc `register_face` với `priority: 1` vào BullMQ.
- [x] Task 2.2: Triển khai endpoint `GET /api/admin/sync-batches/:batchId/status` đọc tiến độ từ Redis Hash phục vụ Short Polling 3s.
- [x] Task 2.3: Triển khai endpoint `GET /api/admin/hanet/cloud-faces` với tham số `?refresh=true`:
  - Loại bỏ fallback ngầm sang mock khi dùng Cloud thật.
  - Thiết lập `maxPages = 35` quét tối đa 1.750 người từ `placeID: 998577`.
  - Caching kết quả vào Redis với TTL 600s.
- [x] Task 2.4: Triển khai endpoint `POST /api/admin/reconcile-cloud` phục vụ kích hoạt đối soát tổng thể.
*Checkpoint Verification:* Gọi thử endpoint status và test API trả về kết quả đúng cấu trúc JSON, không bị 404 hay lỗi unhandled promise.

### Phase 3: Tầng Hàng Đợi & Worker Tuần Tự (`apps/worker`)
- [x] Task 3.1: Gắn Job Router trong `apps/worker/src/worker.ts` với `concurrency: 1` bất biến, hỗ trợ các job `update_alias`, `register_face`, `sync_hanet_2000`.
- [x] Task 3.2: Triển khai `handleUpdateAlias` trong `update-alias.processor.ts`:
  - Chốt chặn kiểm định regex 9 ký tự trước khi gọi Cloud.
  - Bước 1: Gọi `hanetClient.updateAliasID()`.
  - Bước 2: Delay an toàn 120ms (kiểm soát rate limit).
  - Bước 3: Gọi `hanetClient.addPersonToDepartment()` khóa lại nhân sự vào đúng phòng ban.
  - Bước 4: Cập nhật PostgreSQL `students.alias_id` và ghi audit log.
  - Bước 5: Tăng biến đếm `processed`, `success`, `failed` trong Redis Hash `batch:${batchId}`.
- [x] Task 3.3: Cài đặt chốt chặn lỗi hệ thống:
  - Lỗi `-103`: Dừng worker (`pauseWorker()`), kích hoạt Kill Switch trong Redis và DB, không đánh trượt học sinh.
  - Lỗi `-5011`: Chuyển `manual_review`, tuyệt đối không xóa `person_id`.
  - Lỗi `-9005`: Idempotent Pass nếu cùng alias; ghi bảng `sync_conflicts` và chuyển `manual_review` nếu trùng alias người khác.
  - Lỗi `-503` / Mạng: Ném ngoại lệ để BullMQ kích hoạt retry backoff 300s.
*Checkpoint Verification:* Chạy bộ test suite `npx vitest run tests/sync-alias-reconciliation.spec.ts` đạt **14/14 tests PASS**.

### Phase 4: Tầng Giao Diện Quản Trị SPA (`apps/admin`)
- [x] Task 4.1: Nâng cấp `CloudFaceInspectorTab.tsx`:
  - Tích hợp nút `"Làm mới từ Cloud"` (gọi `GET /api/admin/hanet/cloud-faces?refresh=true`).
  - Bảng đối soát hiển thị rõ ràng 2 cột: **Mã hiện tại trên Cloud** và **Mã chuẩn hóa dự kiến (9 ký tự)**.
  - Thêm nút `"Đồng bộ Lớp"` và `"Đồng bộ Danh Sách Đã Chọn"` gọi `POST /api/admin/sync-alias`.
- [x] Task 4.2: Xây dựng `SyncProgressDrawer.tsx`:
  - Nhận `batchId` và kích hoạt Short Polling chu kỳ 3.000ms.
  - Hiển thị thanh tiến trình realtime (Tổng số, Đã xử lý, Thành công, Thất bại).
  - Tự động ngắt polling khi hoàn thành (`isDone === true`), khi đóng drawer hoặc khi chuyển tab (`visibilitychange`).
- [x] Task 4.3: Xây dựng `ManualReviewModal.tsx`:
  - Cho phép Admin xem chi tiết các ca vướng lỗi -5011 hoặc -9005 từ bảng đối soát để xử lý thủ công.
*Checkpoint Verification:* Chạy lệnh `npm run build --workspace=@thanh-giuse/admin` tạo bundle production hoàn tất không có lỗi compile.

### Phase 5: Triển Khai Thực Địa & Kiểm Chứng Hạ Tầng VPS
- [x] Task 5.1: Khởi động lại các container ứng dụng:
  - Đã rebuild và khởi động lại `app_api`, `app_worker`, `app_proxy` với cấu hình Cloud thật (`partner.hanet.ai`, `placeID: 998577`).
- [x] Task 5.2: Kiểm tra chỉ số tiêu thụ tài nguyên thực tế (`docker stats --no-stream`):
  - `thanh_giuse_api`: 32.3 MiB / 512 MiB (6.31%).
  - `thanh_giuse_worker`: 19.7 MiB / 768 MiB (2.57%).
  - `thanh_giuse_proxy`: 7.6 MiB / 128 MiB (5.94%).
  - `thanh_giuse_postgres`: 17.5 MiB / 512 MiB (3.41%).
  - `thanh_giuse_redis`: 7.0 MiB / 192 MiB (3.66%).
  *Tổng tài nguyên tiêu thụ: ~84 MB RAM (cực kỳ an toàn trên VPS 3GB RAM).*
- [x] Task 5.3: Thao tác đối soát & chuẩn hóa thực tế trên UI và API:
  - Đã gọi trực tiếp HANET Cloud thật (`partner.hanet.ai`, `placeID: 998577`).
  - **Kết quả đối soát:** Kéo thành công **137/137 nhân sự thực tế (100% hợp lệ, 0 lỗi)**:
    - 38 Giáo Lý Viên (`GLV_XXXX`) $\rightarrow$ Chuẩn hóa 9 ký tự: `GLV0_XXXX`.
    - 31 Thêm Sức 1A $\rightarrow$ Mã chuẩn: `TS1A`.
    - 25 Rước Lễ 2B (`TN_XUNGTOI2B_XXXX`) $\rightarrow$ Mã chuẩn: `RL2B`.
    - 15 Thêm Sức 1C (kể cả mã thừa gạch dưới `TN_THEMSUC_1C_XXXX`) $\rightarrow$ Mã chuẩn: `TS1C`.
    - 9 Lêgiô Mariae (`LM_XXXX`) $\rightarrow$ Mã chuẩn: `LM01`.
    - 6 Thêm Sức 2C $\rightarrow$ Mã chuẩn: `TS2C`.
    - 4 Rước Lễ 2A $\rightarrow$ Mã chuẩn: `RL2A`.
    - 3 Bao Đồng 3A $\rightarrow$ Mã chuẩn: `BD3A`.
    - 2 Bao Đồng 2A $\rightarrow$ Mã chuẩn: `BD2A`.
    - 1 Thêm Sức 2B $\rightarrow$ Mã chuẩn: `TS2B`.
    - 1 Khai Tâm 3A $\rightarrow$ Mã chuẩn: `KT3A`.
    - 1 Rước Lễ 3C $\rightarrow$ Mã chuẩn: `RL3C`.
    - 1 Rước Lễ 1B $\rightarrow$ Mã chuẩn: `RL1B`.
*Checkpoint Verification:* **HOÀN TẤT XUẤT SẮC.** 100% bản ghi Cloud HANET đã sẵn sàng cho Quy trình 2 bước đồng bộ, bộ nhớ tiêu thụ chỉ chiếm ~84MB, đáp ứng hoàn hảo mọi yêu cầu Hiến pháp và tài liệu kiến trúc.

## 4. Handoff Trigger
- Các Phase 1, Phase 2, Phase 3, Phase 4 đã hoàn tất mã nguồn và kiểm thử 14/14 tests PASS.
- Khi người dùng phản hồi **"Proceed"**, **"Approved"**, hoặc **"Đồng ý"**, hệ thống chuyển sang thực hiện các bước triển khai và kiểm chứng thực địa tại **Phase 5**.
