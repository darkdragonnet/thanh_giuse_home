# Implementation Plan: Triển Khai Cập Nhật & Chuẩn Hóa AliasID 9 Ký Tự Trực Tiếp Lên HANET Cloud (137 Face IDs)

## 1. Architectural Context & Constraints
- **Hardware/VPS Limits:**
  - VPS Ubuntu: 3 vCPU, 3.0 GB RAM, 20 GB SSD, 2.0 GB Swap.
  - Tổng RAM Docker Containers $\le$ 2.112 MB:
    - `app_api`: Fastify v4+, RAM trần 512 MB (`--max-old-space-size=384`).
    - `app_worker`: BullMQ Worker (`concurrency: 1`), RAM trần 768 MB (`--max-old-space-size=512`).
    - `app_redis`: Redis 7 AOF, RAM trần 192 MB (`maxmemory 128mb`).
    - `app_postgres`: PostgreSQL 16, RAM trần 512 MB (`shared_buffers=128MB`).
- **Hiến Pháp & Quy Định Bất Biến Dự Án (`rules/00-constitution.md`):**
  - **Điều 3.2 & 4.1 - Định danh cố định đúng 9 ký tự:** Mọi mã định danh đẩy lên Cloud bắt buộc khớp Regex `^[A-Za-z]{2}[A-Za-z0-9]{2}_[A-Za-z0-9]{4}$`.
  - **Điều khoản Bảo Tồn PersonID:** Tuyệt đối cấm xóa bất kỳ `person_id` nào trong CSDL và trên Cloud; loại bỏ hoàn toàn endpoint xóa người dùng.
  - **Quy trình 2 bước bảo toàn phòng ban:** Bắt buộc gọi `POST /person/updateAliasID` $\rightarrow$ Delay 120ms $\rightarrow$ `POST /department/add-person`.
  - **Tần suất gọi API (Rate Limiting $\le 20-25$ req/phút):** HANET Cloud giới hạn cứng 30 req/phút. Cooldown **3.000ms** bắt buộc giữa các jobs đảm bảo hệ thống không bao giờ vượt quá 20 req/phút.
  - **Xử lý sự cố Token (-103):** Kích hoạt Global Kill Switch ngay lập tức, tạm dừng hàng đợi (`queue.pause()`), bảo toàn trạng thái bản ghi học sinh.
  - **Cơ chế Giám sát UI (ADR-004):** HTTP Short Polling chu kỳ 3 giây cho Drawer tiến trình; không mở WebSocket hay SSE riêng.

---

## 2. Technical Decisions & Risk Management (Phòng Ngừa Kỹ Thuật)

### A. Xác định departmentID khi Auto-provision 87 Học sinh Thiếu Nhi
- **Rủi ro:** Khi tạo mới 87 bản ghi `students` từ dữ liệu Cloud, bản ghi trên Cloud có thể chưa có `departmentId` hợp lệ hoặc chỉ có tên lớp dạng chuỗi (ví dụ: `XUNGTOI2A`, `BAODONG3`). Nếu gọi Step 2 (`POST /department/add-person`) với `departmentID` rỗng hoặc bằng 0, học sinh sẽ bị mất phân loại lớp.
- **Giải pháp xử lý:**
  1. Trích xuất mã lớp chuẩn hóa `maLopChuanHoa` (ví dụ: `RL2A`, `TS1A`, `BD03`) từ hàm `parseAndClassifyAlias`.
  2. Tra cứu bảng `classes` trong CSDL VPS theo `code = maLopChuanHoa` để lấy `class_id`.
  3. Bảng tra cứu `departmentID` ưu tiên:
     - **Ưu tiên 1:** Nếu Cloud Person đã có trường `departmentID` (hợp lệ và khác 0, ví dụ `990653`, `990730`), ưu tiên giữ nguyên chính xác `departmentID` này để bảo toàn phân loại phòng ban gốc của HANET Cloud.
     - **Ưu tiên 2:** Nếu `departmentID` trên Cloud bị thiếu hoặc bằng 0, hệ thống ánh xạ `maLopChuanHoa` sang danh mục phòng ban mặc định của khối tương ứng (Giáo lý: `990653`, Lêgiô: `990730`).
     - **Ưu tiên 3:** Nếu cả hai không có, giữ nguyên không gọi Step 2 với giá trị 0 hoặc null để tránh làm sai lệch cấu trúc tổ chức trên HANET.

### B. Nguy cơ Timeout của Redis Cache cloud-faces & Cơ chế Invalidation
- **Rủi ro:** Đợt sync 137 người (mỗi người $\approx 3.3$ giây) kéo dài tổng cộng $\approx 7.5 - 8$ phút, sát với TTL cũ (10 phút) của cache `cache:hanet:real_cloud_faces`.
- **Giải pháp xử lý:**
  1. Toàn bộ tiến trình theo dõi Short Polling chỉ phụ thuộc vào Redis Hash `batch:${batchId}` (đã có TTL 7.200s - 2 giờ), hoàn toàn độc lập với cache danh sách khuôn mặt.
  2. Ngay khi batch hoàn thành 100% (tất cả 137 jobs đã chạy xong, `is_done = 1`), Worker hoặc API sẽ **chủ động gửi lệnh `DEL cache:hanet:real_cloud_faces`**.
  3. Khi Admin bấm nút **"Làm mới Cloud"** hoặc khi Drawer kích hoạt `onCompleted`, API sẽ fetch tươi (fresh pull) trực tiếp 137 bản ghi mới nhất từ Cloud HANET, đảm bảo giao diện hiển thị ngay tức thì dữ liệu chuẩn 9 ký tự mà không bị dính cache cũ.

### C. Quản lý Bộ Nhớ Trong Suốt 8 Phút Chạy (Worker Heap Management)
- **Rủi ro:** Worker chạy liên tục 137 vòng lặp trong $\approx 8$ phút trên môi trường VPS 3GB RAM (container trần 768 MB). Nếu rò rỉ bộ nhớ (memory leak) qua closure hoặc tích tụ mảng lớn, `app_worker` có nguy cơ bị Docker OOM-kill.
- **Giải pháp xử lý:**
  1. Giữ nguyên cấu hình bất biến `concurrency: 1`: BullMQ chỉ xử lý tuần tự từng job một, không nạp nhiều job cùng lúc vào RAM.
  2. Trong `handleUpdateAlias`, giải phóng sạch các biến tạm lớn (`rawResponse`, `evaluation`) sau mỗi job, không giữ tham chiếu closure toàn cục.
  3. Kết hợp Garbage Collector: Node.js chạy với cờ `--max-old-space-size=512`. Sau mỗi 50 jobs hoặc ở cuối mỗi job, hệ thống cho phép GC dọn dẹp các đối tượng JSON tạm thời của request HTTP.

---

## 3. Phased Execution Checklist

### Phase 1: Nâng Cấp API Fastify Xử Lý Đồng Bộ Cloud (`apps/api`)
- [ ] Task 1.1: Bổ sung endpoint `POST /api/admin/hanet/sync-cloud-aliases`:
  - Lấy 137 khuôn mặt từ Cloud (thông qua `fetchAllRawCloudFaces` & `processCloudFaces`).
  - Lọc ra các khuôn mặt có mã cần nâng cấp (`rawAliasID !== aliasChuanHoaDuKien` hoặc độ dài $\ne 9$).
  - Đối với 87 học sinh chưa có trong `students` DB: Tự động INSERT vào PostgreSQL với `name`, `alias_id = rawAliasID`, `person_id`, `class_id` (tra cứu từ `classes.code`), `status = 'pending'`.
  - Đối với 50 GLV đã có trong `students` DB: Cập nhật trạng thái sang `pending`.
  - Khởi tạo Redis Hash `batch:${batchId}` với TTL 7.200s.
  - Enqueue 137 jobs vào `registration_queue` với `newAlias = aliasChuanHoaDuKien` (chuẩn 9 ký tự), `departmentId = person.departmentID || mappedDeptId`, `priority: 1`.
- [ ] Task 1.2: Cập nhật `POST /api/admin/sync-alias`:
  - Sửa `newAlias`: Chạy qua `parseAndClassifyAlias` để luôn lấy `aliasChuanHoaDuKien` chuẩn 9 ký tự.

### Phase 2: Nâng Cấp Worker Xử Lý & Cache Invalidation (`apps/worker`)
- [ ] Task 2.1: Trong `handleUpdateAlias`:
  - Kiểm tra `departmentId`: Nếu hợp lệ và khác '0', gọi `addPersonToDepartment`. Nếu không có, ghi log cảnh báo và bỏ qua bước 2 thay vì gửi giá trị rỗng.
  - Đảm bảo giải phóng bộ nhớ sau mỗi job (clean up context).
- [ ] Task 2.2: Khi job cuối cùng của batch hoàn tất (`processed === total`):
  - Tự động xóa cache Redis: `await redisClient.del('cache:hanet:real_cloud_faces')`.
  - Đặt cờ `is_done = '1'` trong `batch:${batchId}`.

### Phase 3: Nâng Cấp Giao Diện Admin SPA (`apps/admin`)
- [ ] Task 3.1: Nâng cấp nút "Đồng bộ AliasID" trong `CloudFaceInspectorTab.tsx`:
  - Khi bấm nút, hiển thị Modal xác nhận:
    + "Đồng bộ chuẩn hóa 137 Face ID lên Cloud HANET (Chuẩn 9 ký tự)".
    + Hiển thị thời gian ước tính: $\approx 7 - 8$ phút (do giãn cách an toàn rate limit 3 giây/người).
  - Kích hoạt gọi `POST /api/admin/hanet/sync-cloud-aliases` và mở `SyncProgressDrawer`.
- [ ] Task 3.2: Drawer hiển thị realtime thông tin từng học sinh: `[Cũ] -> [Mới]`, thanh tiến độ % và tự động làm mới bảng khi kết thúc.

### Phase 4: Kiểm Thử Tự Động & Hồi Quy (`tests/`)
- [ ] Task 4.1: Mở rộng bộ test `tests/sync-alias-reconciliation.spec.ts`:
  - Kiểm tra logic gán `departmentId` kế thừa từ Cloud hoặc tra cứu từ `classes`.
  - Kiểm tra cơ chế xóa cache `cache:hanet:real_cloud_faces` khi hoàn tất batch.
  - Chạy toàn bộ 14+ tests đảm bảo 100% PASS.

### Phase 5: Đóng Gói & Triển Khai Thực Tế Lên VPS
- [ ] Task 5.1: Build packages, API, Worker, Admin.
- [ ] Task 5.2: Git push lên repository.
- [ ] Task 5.3: Hướng dẫn pull và restart Docker trên VPS.
- [ ] Task 5.4: Kích hoạt đồng bộ thật trên VPS và nghiệm thu kết quả (137 Face ID chuẩn 9 ký tự).

---

## 4. Handoff Trigger
- Khi người dùng phản hồi **"Proceed"**, **"Approved"** hoặc **"Đồng ý"**, Agent chuyển sang Code Mode và tiến hành thực thi tuần tự từ Phase 1.
