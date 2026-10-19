# Implementation Plan: Khắc phục lỗi HTTP 400 Bad Request, Chống Tắc Nghẽn Circuit Breaker & Bảo Toàn Ảnh Phục Vụ Cập Nhật Thủ Công

## 1. Architectural Context & Verified Root Cause
- **Hardware/VPS Limits:** VPS Ubuntu 3 vCPU, 3.0 GB RAM, 20 GB SSD, 2.0 GB Swap. Giới hạn bộ nhớ Docker Container tối đa 2.1 GB.
- **Hạ tầng Worker & Queue:** BullMQ `concurrency: 1`, Redis 7 AOF, PostgreSQL 16.
- **XÁC MINH NGUYÊN NHÂN GỐC RỄ (ROOT CAUSE VERIFIED 100%):**
  - Trong `.env` trên VPS, biến `STATIC_BASE_URL` đang cấu hình trỏ vào IP trực tiếp: `http://161.248.146.115:8090/tmp-faces`.
  - Khi bot của HANET Cloud thực hiện cào ảnh từ URL này, Cloudflare/Nginx lập tức chặn với thông báo: `Direct IP access is not allowed (HTTP 400)`.
  - Không tải được ảnh, HANET Cloud trả về `HTTP Error: 400 Bad Request` cho Worker.
  - Do lỗi phân loại trong code, `HanetClient` ép mã này thành `-503` và gọi `recordFailure()` làm sập Circuit Breaker (`OPEN`), khiến toàn bộ hàng đợi của các học sinh khác bị delay 300s liên hoàn.
- **Biện pháp xử lý kép (Two-Pronged Solution):**
  1. **Tầng Cấu hình Hạ tầng (DevOps/VPS):** Đổi `STATIC_BASE_URL=https://thanhgiuse.gaudetedomino.io.vn/tmp-faces` trong `.env` trên VPS.
  2. **Tầng Ứng dụng (App/Code):** Sửa lỗi kiến trúc trong `HanetClient` và `Worker` để nếu trong tương lai có bất kỳ học sinh nào gặp lỗi ảnh/4xx, Circuit Breaker vẫn vững vàng, không làm nghẽn 1.200 học sinh khác, và file ảnh luôn được bảo toàn trên máy chủ.
- **Affected Files:**
  - `packages/hanet-client/src/index.ts`
  - `packages/error-mapping/src/index.ts`
  - `apps/worker/src/processor.ts`
  - `scripts/admin/recover-stuck-queue.ts`
  - `.env` (trên VPS production)

---

## 2. Technical Decisions & Edge Cases Resolution

### A. Xử lý Phân nhánh Ngoại lệ trong nhóm HTTP 4xx (Tránh Quarantine nhầm)
1. **Ưu tiên Bóc tách `returnCode` nội bộ từ JSON Body của HANET:**
   - Dù HTTP status là 400 hay bất kỳ mã nào, trước tiên parse body JSON. Nếu có `returnCode` (ví dụ `-9006` mặt mờ, `-9007` trùng mặt, `-9005` đã tồn tại, `-9008` hết quota, `-103` hết hạn token...), hệ thống **bắt buộc dùng `returnCode` này** để định tuyến qua `evaluateHanetError(returnCode, returnMessage)`.
2. **Ngoại lệ HTTP 401 / Mã `-103` (Token hết hạn):**
   - **Tuyệt đối không đưa vào `manual_review`** (tránh làm oan hàng loạt học sinh).
   - Kích hoạt cơ chế an toàn: Bật Kill Switch bảo trì toàn hệ thống, tạm dừng hàng đợi `queue.pause()`, phát cảnh báo đỏ lên Admin Dashboard để Admin nạp token mới vào `.env`.
3. **Ngoại lệ HTTP 429 (Too Many Requests / Rate Limit):**
   - Không đưa vào `manual_review` và **không làm nhảy Circuit Breaker**.
   - Áp dụng Fixed/Exponential Backoff ngắn (ví dụ delay 15s–30s) để BullMQ tự động thử lại sau khi giãn cách tần suất.
4. **Lỗi HTTP 400 thực sự (Sau khi loại trừ mã nghiệp vụ):**
   - Không gọi `circuitBreaker.recordFailure()`.
   - Ánh xạ thành `QUARANTINE_MANUAL` (hoặc `FATAL_INVALID_DATA`), ghi rõ chi tiết body lỗi vào `last_error_message` và chuyển học sinh sang `manual_review`.

### B. Chiến lược Lưu trữ & Bảo Toàn Ảnh khi Đưa vào `manual_review`
- **Bảo toàn ảnh phục vụ kiểm tra thủ công:**
  - File ảnh gốc tại `UPLOAD_DIR` (`students.local_image_path`) và file đã resize tại `tmp-faces/` **được giữ nguyên vẹn trên disk**.
  - Không gọi lệnh `fs.promises.unlink` khi kết thúc job ở trạng thái lỗi/quarantine.
  - Sau khi Admin cập nhật đúng `STATIC_BASE_URL` hoặc điều chỉnh thông tin, có thể bấm duyệt/thử lại trực tiếp từ ảnh đã lưu.

### C. Cơ chế Reset Circuit Breaker & Thứ tự Vận hành Chuẩn (Deployment Sequence)
- **Thứ tự thực thi chuẩn trên VPS:**
  1. **Cập nhật `.env`:** Đổi `STATIC_BASE_URL=https://thanhgiuse.gaudetedomino.io.vn/tmp-faces`.
  2. **Deploy code mới:** Triển khai code đã fix của `HanetClient` và `Worker`.
  3. **Restart Worker Container:** Lệnh `docker compose restart queue-worker` sẽ nạp biến môi trường mới và tự động reset Circuit Breaker về `CLOSED`.
  4. **Chạy script giải cứu Queue (`recover-stuck-queue.ts`):** Duyệt qua các job `delayed` và gọi `job.promote()` đưa về `waiting` để xử lý thông suốt.

---

## 3. Implementation Gotchas & Phòng Ngừa Rủi Ro Kỹ Thuật

1. **Tránh lỗi "Body Stream Already Read" trong Fetch API:**
   - Đọc qua `const rawText = await response.text();` trước, sau đó `JSON.parse(rawText)` trong `try/catch`.
2. **Chuẩn hóa URL ảnh an toàn (Trim Trailing & Leading Slashes):**
   - Ghép URL bằng logic an toàn chống lỗi double slash:
     ```typescript
     const baseUrl = (workerEnv.staticBaseUrl || '').replace(/\/+$/, '');
     const cleanFilename = processed.filename.replace(/^\/+/, '');
     const imageUrl = `${baseUrl}/${cleanFilename}`;
     ```
3. **Giới hạn Độ Dài Thông Báo Lỗi (Tránh Tràn Log & Database):**
   - Khi HANET hoặc Cloudflare trả về HTML lỗi dài hàng chục KB, cắt ngắn trước khi ghi vào database và log:
     ```typescript
     const safeErrorMessage = rawText.slice(0, 1000);
     ```
4. **Đóng Kết Nối Đúng Cách trong Script Quản Trị:**
   - Trong `scripts/admin/recover-stuck-queue.ts`, đóng kết nối BullMQ và Redis để tiến trình tự động thoát sạch sẽ:
     ```typescript
     await registrationQueue.close();
     await redisClient.quit();
     process.exit(0);
     ```
5. **Bảo toàn Nhất quán Đường Dẫn Ảnh trên Shared Volume:**
   - Lưu chuẩn xác đường dẫn trên volume `/app/uploads` vào PostgreSQL.

---

## 4. Phased Execution Checklist

### Phase 1: Nâng cấp `HanetClient` & Trích xuất Toàn diện Mã Lỗi
- [x] Task 1.1: Cải tiến `executePost` trong `packages/hanet-client/src/index.ts`:
  - Đọc an toàn response body qua `const rawText = await response.text()`, parse JSON trong khối `try/catch`.
  - Cắt ngắn `safeErrorMessage` tối đa 1.000 ký tự khi in log hoặc ghi nhận lỗi.
  - In log chi tiết chẩn đoán: URL, Status, Request Payload (che token), Raw Response Text (rút gọn an toàn).
  - Phân tích `returnCode` nghiệp vụ từ JSON body trước tiên.
  - Phân loại:
    - Nếu `status === 401` hoặc `returnCode === -103`: Trả về lỗi token, không đếm lỗi Circuit Breaker.
    - Nếu `status === 429`: Trả về action retry với backoff, không đếm lỗi Circuit Breaker.
    - Nếu `status >= 400 && status < 500`: Không đếm lỗi Circuit Breaker. Trả về mã lỗi nghiệp vụ hoặc `-400`.
    - Nếu `status >= 500` hoặc rớt mạng/timeout: Đếm lỗi Circuit Breaker (`recordFailure()`), trả về `-503`.
- [x] Task 1.2: Bổ sung mã lỗi `-400` và `-429` vào `packages/error-mapping/src/index.ts`.
- [x] Task 1.3: Build các package `@thanh-giuse/error-mapping` và `@thanh-giuse/hanet-client`.
*Checkpoint Verification:* Chạy unit test kiểm tra các kịch bản 400, 401, 429, 503: Circuit Breaker giữ trạng thái `CLOSED` và các test pass 100%.

### Phase 2: Nâng cấp Worker Processor & Chính sách Bảo toàn Ảnh
- [x] Task 2.1: Cập nhật `apps/worker/src/processor.ts`:
  - Chuẩn hóa URL ảnh chống double slash: `const imageUrl = `${baseUrl}/${cleanFilename}``.
  - Định tuyến đúng nhánh 401 (Kill Switch), 429 (Delay ngắn), 400 (Fast Isolation).
  - Khi gặp lỗi và chuyển sang `manual_review`: **Giữ nguyên cả 2 tệp ảnh** (ảnh gốc trong `UPLOAD_DIR` và ảnh trong `tmp-faces/`), cập nhật `last_error_message` chứa `safeErrorMessage` (tối đa 1.000 ký tự).
  - Kết thúc job gỡ khỏi hàng đợi mà không ném ngoại lệ delay 300s.
- [x] Task 2.2: Đảm bảo giao diện/API Admin có thể truy cập ảnh của học sinh ở trạng thái `manual_review` thông qua `local_image_path`.
*Checkpoint Verification:* Đã tích hợp chốt chặn bảo toàn ảnh và biên dịch toàn bộ TypeScript của worker thành công.

### Phase 3: Script Quản trị Phục hồi Queue & Cập Nhật Cấu Hình VPS
- [x] Task 3.1: Viết script `scripts/admin/recover-stuck-queue.ts`:
  - Quét và `promote()` toàn bộ các job đang bị kẹt delay trong BullMQ.
  - Tự động đóng connection `await registrationQueue.close()` và `await redisClient.quit()`, thoát tiến trình `process.exit(0)`.
- [x] Task 3.2: Soạn tài liệu hướng dẫn vận hành và cập nhật `.env`:
  - Đổi `STATIC_BASE_URL=https://thanhgiuse.gaudetedomino.io.vn/tmp-faces` trong `.env` trên VPS.
  - Quy trình deploy code mới và restart worker.
  - Lệnh chạy script giải cứu queue.
*Checkpoint Verification:* Chạy build toàn monorepo (`npm run build`) thành công 100% với 0 lỗi.

---

## 5. Handoff Trigger
- Khi người dùng phản hồi **"Proceed"**, Agent chuyển sang Code Mode và thực thi tuần tự từ Phase 1.
