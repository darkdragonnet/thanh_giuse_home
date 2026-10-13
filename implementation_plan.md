# Implementation Plan: Chuẩn Hóa Luồng Đăng Ký Khuôn Mặt Học Sinh, Tương Thích Zalo WebView, Camera Hybrid & Xác Thực Header PIN Giáo Viên

## 1. Architectural Context & Constraints
- **Hardware/VPS Limits:**
  - VPS Ubuntu: 3 vCPU, 3.0 GB RAM, 20 GB SSD, 2.0 GB Swap.
  - Giới hạn tổng RAM Docker Containers $\le$ 2.112 MB (`app_proxy`: 128 MB, `app_postgres`: 512 MB, `app_redis`: 192 MB, `app_api`: 512 MB, `app_worker`: 768 MB).
  - Toàn bộ giao diện Học sinh (`/l/:classCode`) được phục vụ tĩnh trực tiếp từ Nginx (`app_proxy`), **0 MB RAM Node.js phía client**, kết hợp nén ảnh Canvas tại trình duyệt (JPEG 0.85, cạnh dài $\le 1920\text{px}$) và `URL.revokeObjectURL()` chống rò rỉ bộ nhớ trên thiết bị di động.
  - BullMQ Worker: `concurrency = 1`, `lockDuration = 120000ms`, Nginx `client_max_body_size = 5M`.
- **Hiến Pháp Dự Án ([rules/00-constitution.md](file:///Users/dragonnet/Documents/thanh_Giuse/rules/00-constitution.md)):**
  - **Điều 3 & Điều 4:** Bảo toàn nguyên vẹn quy chuẩn `alias_id` 9 ký tự (`^[A-Za-z]{2}[A-Za-z0-9]{2}_[A-Za-z0-9]{4}$`), chiến lược 2-Phase AliasID và khóa nguyên tử (`Atomic Conditional Update`).
  - **Điều 5:** Mobile-first, tải dưới 2s trên 4G, không hiển thị lỗi HTTP 500 thô, phản hồi tiến trình xử lý qua HTTP Short Polling 3 giây/lần ([ADR-004](file:///Users/dragonnet/Documents/thanh_Giuse/knowledge/05-decisions/ADR-004-polling-over-websocket.md)).
- **Affected Files:**
  - [docker/nginx/default.conf](file:///Users/dragonnet/Documents/thanh_Giuse/docker/nginx/default.conf)
  - [docker/nginx/conf.d/default.conf](file:///Users/dragonnet/Documents/thanh_Giuse/docker/nginx/conf.d/default.conf)
  - [packages/shared-infra/src/repositories/studentRepository.ts](file:///Users/dragonnet/Documents/thanh_Giuse/packages/shared-infra/src/repositories/studentRepository.ts)
  - [apps/api/src/middleware/rateLimiter.ts](file:///Users/dragonnet/Documents/thanh_Giuse/apps/api/src/middleware/rateLimiter.ts)
  - [apps/api/src/index.ts](file:///Users/dragonnet/Documents/thanh_Giuse/apps/api/src/index.ts)
  - [apps/student/src/statusConfig.ts](file:///Users/dragonnet/Documents/thanh_Giuse/apps/student/src/statusConfig.ts)
  - [apps/student/index.html](file:///Users/dragonnet/Documents/thanh_Giuse/apps/student/index.html) (và đồng bộ sang [apps/student/dist/index.html](file:///Users/dragonnet/Documents/thanh_Giuse/apps/student/dist/index.html), [frontend/dist/index.html](file:///Users/dragonnet/Documents/thanh_Giuse/frontend/dist/index.html), [apps/api/public/index.html](file:///Users/dragonnet/Documents/thanh_Giuse/apps/api/public/index.html))
  - `tests/student-portal-edge-cases.spec.ts` (Tạo mới kiểm thử 7 kịch bản biên)

---

## 2. Technical Decisions & Implementation Notes

### 2.1. Các Quyết Định Kỹ Thuật Đã Thống Nhất
- **Database & Atomic Lock Layer:** PostgreSQL 16 + Raw SQL (`pg` Pool).
  - **Học sinh tự truy cập (Không có PIN hoặc PIN sai):** Chỉ cho phép nộp ảnh khi `status IN ('empty', 'error', 'manual_review')`. Khóa cứng khi `status = 'success'` (trả về `409 Conflict` nếu cố gửi API) để chống học sinh chọn nhầm tên bạn cùng lớp rồi chụp đè.
  - **Giáo viên hỗ trợ (Có `?token=PIN_...` hoặc header `x-teacher-pin` hợp lệ của lớp):** Cho phép Giáo viên bấm **"Cập nhật lại hình"** cho học sinh đã `status = 'success'`. Backend thực thi khóa nguyên tử `claimStudentForTeacherOverride` (`is_updating = TRUE`, giữ nguyên `status = 'success'` và `person_id`), đẩy Job `UPDATE_PHOTO` với **`priority: 1`** vào BullMQ để cập nhật trực tiếp lên `person_id` trên HANET Cloud.
- **API & Header RFC 7230 / CORS Safety:**
  - Hàm `safeHeaderEncode(text)` dùng `encodeURIComponent(text.trim())` cho header `X-Class-Name` nhằm triệt tiêu lỗi Node.js `TypeError [ERR_INVALID_CHAR]` khi tên lớp có dấu tiếng Việt/Emoji và ngăn chặn hoàn toàn lỗ hổng **CRLF Header Injection (`\r\n`)**.
  - Route `GET /api/classes/:classId/students` trả về 3 custom headers: `X-Class-Code`, `X-Class-Name`, `X-Teacher-Verified` (`"true" | "false"`) và hỗ trợ xử lý `OPTIONS` preflight.
  - Nginx cấu hình `proxy_pass_header` và `add_header 'Access-Control-Expose-Headers' 'X-Class-Code, X-Class-Name, X-Teacher-Verified' always;`.
- **Camera Mode trên mạng LAN (`http://192.168.1.51:8090`):**
  - Áp dụng **Phương án A (Hybrid Camera)**:
    - Nếu `window.isSecureContext === true` và có `navigator.mediaDevices.getUserMedia`: Hỗ trợ mở khung ngắm Live Camera trực tiếp (có khung Oval canh mặt, đổi cam trước/sau).
    - Nếu `window.isSecureContext === false` (HTTP IP LAN): Tự động dùng 2 nút độc lập:
      1. **Nút Chụp Máy Ảnh:** `<input type="file" accept="image/*" capture="user">` (tránh xung đột Intent Android).
      2. **Nút Chọn Thư Viện:** `<input type="file" accept="image/jpeg,image/png,image/webp">` (không có `capture`).
- **Chiến lược Tương thích Zalo In-App Browser (Soft Banner + Reactive Lock):**
  - **Cảnh báo chủ động (Soft Banner):** Khi phát hiện `User-Agent` là Zalo / Messenger WebView, hiển thị Banner vàng cam ở đầu trang kèm nút **"Mở bằng Trình duyệt ngoài"** (Android Intent URI sang Chrome / Hướng dẫn trực quan 2 bước `•••` $\rightarrow$ *Mở bằng Safari* trên iOS) và nút **"Sao chép Link"** (giữ nguyên `?token=PIN_...`). Vẫn cho phép thử chụp 1 lần.
  - **Khóa phản ứng khi lỗi (Reactive Camera Lock):** Nếu chụp ảnh trả về file rỗng (`0 byte`), rớt sự kiện khi quay lại từ app Camera (phát hiện qua `sessionStorage` + `visibilitychange`/`focus`), lỗi giải mã định dạng `.heic`/`.heif` (`img.onerror`), hoặc bị từ chối quyền Camera $\rightarrow$ Lập tức chuyển khu vực chụp trực tiếp sang **Trạng thái Khóa (Locked State)**, ẩn nút chụp Camera và hướng dẫn người dùng bấm **Mở trình duyệt ngoài** hoặc **Chọn ảnh đã chụp từ Thư viện**.
- **Queue Engine & Short Polling:**
  - BullMQ + Redis 7 AOF (`concurrency = 1`).
  - Frontend chạy vòng lặp Short Polling `3.000ms` (3 giây/lần) khi học sinh đang chọn ở trạng thái `pending` hoặc `is_updating = true`, tự động dừng khi chuyển sang `success`, `error`, hoặc `manual_review`.

### 2.2. Lưu Ý Kỹ Thuật Khi Thực Thi (Mandatory Implementation Notes)
1. **Khởi động lại Nginx sau khi sửa đồng thời 2 tệp cấu hình:**
   - Vì cấu trúc Docker của Nginx có thể tham chiếu tới cả hai tệp cấu hình, **BẮT BUỘC** cập nhật đồng thời cả [docker/nginx/default.conf](file:///Users/dragonnet/Documents/thanh_Giuse/docker/nginx/default.conf) và [docker/nginx/conf.d/default.conf](file:///Users/dragonnet/Documents/thanh_Giuse/docker/nginx/conf.d/default.conf) (xác nhận khớp 100% qua `diff`), sau đó chạy lệnh `docker compose -f docker/docker-compose.yml restart app_proxy` (hoặc rebuild/reload `app_proxy`) để Nginx nạp lại các chỉ thị `location /tmp-faces/`, `proxy_pass_header` và `Access-Control-Expose-Headers`.
2. **Quy trình đồng bộ nghiêm ngặt giữa 4 file HTML:**
   - Trong Phase 4, mọi chỉnh sửa giao diện được thực hiện trực tiếp trên file gốc duy nhất là [apps/student/index.html](file:///Users/dragonnet/Documents/thanh_Giuse/apps/student/index.html).
   - Ngay sau khi chỉnh sửa xong, **BẮT BUỘC** chạy lệnh sao chép đồng bộ sang cả 3 tệp đích:
     - [apps/student/dist/index.html](file:///Users/dragonnet/Documents/thanh_Giuse/apps/student/dist/index.html)
     - [frontend/dist/index.html](file:///Users/dragonnet/Documents/thanh_Giuse/frontend/dist/index.html)
     - [apps/api/public/index.html](file:///Users/dragonnet/Documents/thanh_Giuse/apps/api/public/index.html)
   - Kiểm chứng bằng checksum (`shasum -a 256`) đảm bảo cả 4 file HTML giống hệt nhau 100%, tránh tuyệt đối tình trạng lệch mã nguồn giữa môi trường dev (`3002`) và production (`8090`).

---

## 3. Phased Execution Checklist

### Phase 1: Chuẩn Hóa Cấu Hình Nginx Reverse Proxy (`docker/nginx/`)
- [x] Task 1.1: Cập nhật đồng thời cả 2 tệp [docker/nginx/default.conf](file:///Users/dragonnet/Documents/thanh_Giuse/docker/nginx/default.conf) và [docker/nginx/conf.d/default.conf](file:///Users/dragonnet/Documents/thanh_Giuse/docker/nginx/conf.d/default.conf):
  - Bổ sung khối `location /tmp-faces/` trỏ tới `/app/uploads/tmp-faces/` (`expires off; add_header Cache-Control "no-store, no-cache, must-revalidate";`) để Worker và HANET Cloud tải được ảnh cắt chuẩn.
  - Bổ sung khối `location /uploads/` trỏ tới `/app/uploads/` phục vụ xem lại ảnh vừa nộp.
  - Tại khối `location /api/`: Bổ sung các chỉ thị:
    - `proxy_pass_header X-Class-Code;`
    - `proxy_pass_header X-Class-Name;`
    - `proxy_pass_header X-Teacher-Verified;`
    - `add_header 'Access-Control-Expose-Headers' 'X-Class-Code, X-Class-Name, X-Teacher-Verified' always;`
- [x] Task 1.2: Kiểm tra `diff -u docker/nginx/default.conf docker/nginx/conf.d/default.conf` và khởi động lại `app_proxy` (`docker compose -f docker/docker-compose.yml restart app_proxy`) để Nginx nạp cấu hình mới.
*Checkpoint Verification:* Xác nhận 2 file cấu hình Nginx đồng nhất và `app_proxy` nạp thành công các chỉ thị `proxy_pass_header` cùng `Access-Control-Expose-Headers`.

### Phase 2: Nâng Cấp Tầng Repository & Khóa Nguyên Tử Cho Giáo Viên (`packages/shared-infra`)
- [x] Task 2.1: Cập nhật [packages/shared-infra/src/repositories/studentRepository.ts](file:///Users/dragonnet/Documents/thanh_Giuse/packages/shared-infra/src/repositories/studentRepository.ts):
  - Bổ sung phương thức `claimStudentForTeacherOverride(studentId: number, localImagePath: string)`:
    - Nếu học sinh đang ở `status = 'success'` và `COALESCE(is_updating, FALSE) = FALSE`: Cập nhật nguyên tử `is_updating = TRUE, local_image_path = $1, updated_at = NOW()` và trả về `{ student, mode: 'UPDATE_PHOTO' }` (bảo toàn `status = 'success'` và `person_id` cũ phòng trường hợp ảnh mới bị lỗi `-9006`).
    - Nếu học sinh đang ở `status IN ('empty', 'error', 'manual_review')`: Cập nhật nguyên tử sang `status = 'pending'` và trả về `{ student, mode: 'REGISTER' }`.
*Checkpoint Verification:* Chạy `npm run build:packages` thành công với 0 lỗi TypeScript.

### Phase 3: Nâng Cấp Backend API — Header RFC 7230, Rate Limit Bypass & Teacher Override (`apps/api`)
- [x] Task 3.1: Cập nhật [apps/api/src/middleware/rateLimiter.ts](file:///Users/dragonnet/Documents/thanh_Giuse/apps/api/src/middleware/rateLimiter.ts):
  - Hỗ trợ kiểm tra mã PIN giáo viên (`x-teacher-pin` hoặc query `token` / `teacher_pin`) cho cả tham số `classId` dạng số lẫn dạng mã lớp chữ cái (như `GLV0`, `TS1A`) thông qua `classRepo.findByCode`, cũng như khi truyền `studentId`.
- [x] Task 3.2: Cập nhật [apps/api/src/index.ts](file:///Users/dragonnet/Documents/thanh_Giuse/apps/api/src/index.ts):
  - Xây dựng hàm `safeHeaderEncode(text: string | null | undefined): string` dùng `encodeURIComponent(text.trim())` để mã hóa ASCII an toàn tuyệt đối (chống `ERR_INVALID_CHAR` và chống CRLF Injection `\r\n`).
  - Hỗ trợ CORS headers (`Access-Control-Allow-Origin`, `Access-Control-Allow-Headers: Content-Type, Authorization, x-teacher-pin`, `Access-Control-Expose-Headers: X-Class-Code, X-Class-Name, X-Teacher-Verified`) và xử lý request `OPTIONS` (`204 No Content`) cho `/api/classes/:classId/students`.
  - Tại `GET /api/classes/:classId/students`:
    - Tìm `classRecord` (theo ID số hoặc mã `code` chữ cái như `GLV0`).
    - Kiểm tra mã PIN từ `request.headers['x-teacher-pin']` hoặc `request.query.token` / `request.query.teacher_pin` qua `classRepo.verifyTeacherPin(classRecord.id, pin)`.
    - Đính kèm 3 response headers: `X-Class-Code`, `X-Class-Name` (qua `safeHeaderEncode`), `X-Teacher-Verified` (`'true' | 'false'`).
  - Tại `handleClassStudentPhotoUpload` (`POST /api/students/:studentId/photo` & `/register`):
    - Kiểm tra tính hợp lệ của `teacherPin` đối với lớp của học sinh.
    - Nếu `isTeacherVerified === true`: Gọi `studentRepo.claimStudentForTeacherOverride(studentId, filePath)`. Nếu `mode === 'UPDATE_PHOTO'` (học sinh đã `success`), đẩy job BullMQ với `actionType: 'UPDATE_PHOTO'`, `priority: 1` và `personId: claimed.person_id`.
    - Nếu `isTeacherVerified === false`: Giữ nguyên `studentRepo.claimStudentForClassRegister(studentId, filePath)` (chặn cứng `status = 'success'` với HTTP `409 Conflict`).
*Checkpoint Verification:* Build `@thanh-giuse/api` (`npm run build --workspace=@thanh-giuse/api`) thành công 100%.

### Phase 4: Thiết Kế Lại Giao Diện Cổng Học Sinh (`apps/student/index.html` & Đồng Bộ 4 File HTML)
- [x] Task 4.1: Cập nhật [apps/student/src/statusConfig.ts](file:///Users/dragonnet/Documents/thanh_Giuse/apps/student/src/statusConfig.ts) để phản ánh đúng ma trận trạng thái: cho phép thử lại khi `error` hoặc `manual_review`, và phân tách hành vi `success` theo quyền Giáo viên (`isTeacherVerified`).
- [x] Task 4.2: Chỉnh sửa trực tiếp trên file gốc [apps/student/index.html](file:///Users/dragonnet/Documents/thanh_Giuse/apps/student/index.html) theo thiết kế Mobile-First:
  1. **Trích xuất động URL & Khôi phục Phiên (`sessionStorage`):**
     - Tự động bóc tách `classCode` từ pathname `/l/:classCode` (hoặc query `?class=GLV0`, fallback `1`) và `teacherPin` từ `?token=...` / `?teacher_pin=...`.
     - Lưu & khôi phục `selectedStudentId` từ `sessionStorage` để không mất học sinh đang chọn nếu Zalo WebView bị hệ điều hành reload sau khi mở Camera.
  2. **Giải mã Header An toàn & Hiển thị Huy hiệu Giáo viên:**
     - Gửi header `x-teacher-pin` trong mọi lệnh `fetch`.
     - Đọc `X-Class-Code`, `X-Class-Name` (bọc `try { decodeURIComponent(...) } catch` fallback về `classCode` nếu chuỗi URI lỗi hoặc rỗng) và `X-Teacher-Verified`.
     - Hiển thị rõ tên lớp và huy hiệu `🛡️ Chế độ Giáo viên hỗ trợ` khi `X-Teacher-Verified === 'true'`.
  3. **Zalo WebView Compatibility Detector, Soft Banner & Reactive Camera Lock:**
     - Phát hiện `Zalo`, `FBAN`, `FBAV` qua `navigator.userAgent`. Hiển thị **Soft Banner** màu vàng cam ngay đầu trang kèm nút **[🌐 Mở trình duyệt ngoài]** (Android Intent URI sang Chrome / Modal hướng dẫn 2 bước `•••` $\rightarrow$ *Mở bằng Safari* cho iOS) và nút **[📋 Sao chép Link]**.
     - Thiết kế **Reactive Camera Lock (`triggerCameraLock`)**: Khi phát hiện lỗi chụp hình (file 0 byte, rớt sự kiện sau khi quay lại từ Camera qua bộ theo dõi `visibilitychange`/`focus`, lỗi đọc định dạng `.heic` qua `img.onerror`, hoặc lỗi quyền `getUserMedia`), tự động khóa nút chụp Camera trực tiếp, chuyển sang khung cảnh báo đỏ cam hướng dẫn mở trình duyệt ngoài hoặc chọn ảnh có sẵn từ Thư viện.
  4. **Khu vực Lấy ảnh Kép (Hybrid Camera + Thư viện) & Tiền nén Canvas Zero-Leak:**
     - Tách riêng 2 nút: **`📸 Chụp Ảnh Trực Tiếp`** (`<input type="file" accept="image/*" capture="user">` hoặc Live WebRTC Viewfinder nếu HTTPS) và **`🖼️ Chọn Từ Thư Viện`** (`<input type="file" accept="image/jpeg,image/png,image/webp">`).
     - Nén ảnh qua Canvas (`MAX_WIDTH = 1920`, JPEG `0.85`), gọi `URL.revokeObjectURL()` ngay trong `onload`/`onerror` để giải phóng RAM, tự động hiển thị ảnh `face_url` hiện có của học sinh khi chọn tên.
  5. **Phân quyền Nút bấm, Hiển thị Lỗi AI & Short Polling 3s/lần:**
     - Ô tìm kiếm nhanh (`#studentSearchInput`) lọc danh sách học sinh tức thì.
     - Hiển thị chi tiết `last_error_message` / `last_error_code` (`-9006`, `-9007`) để học sinh biết lý do cần chụp lại.
     - Nếu `status === 'success'`: Mở nút **"🔄 Cập nhật lại hình (Giáo viên)"** khi `isTeacherVerified === true`; khóa vùng chụp và chỉ hiện nút **"Yêu cầu đổi ảnh (Gửi Admin)"** khi `isTeacherVerified === false`.
     - Chuẩn hóa nút **"Gửi Admin"** gửi đầy đủ `student_id`, `qr_token`, `alias_id`, `student_name`, `note`.
     - Vòng lặp **Short Polling 3 giây/lần** (`setInterval(..., 3000)`) khi học sinh ở trạng thái `pending` hoặc `is_updating`, tự động dừng và thông báo kết quả ngay khi Worker xử lý xong.
- [x] Task 4.3: Chạy lệnh sao chép đồng bộ từ file gốc [apps/student/index.html](file:///Users/dragonnet/Documents/thanh_Giuse/apps/student/index.html) sang cả 3 tệp đích:
  ```bash
  cp apps/student/index.html apps/student/dist/index.html
  cp apps/student/index.html frontend/dist/index.html
  cp apps/student/index.html apps/api/public/index.html
  ```
*Checkpoint Verification:* Chạy `shasum -a 256 apps/student/index.html apps/student/dist/index.html frontend/dist/index.html apps/api/public/index.html` xác nhận cả 4 file có mã hash SHA-256 trùng khớp 100%.

### Phase 5: Kiểm Thử Tự Động 7 Kịch Bản Biên (Strict Edge-Case Test Suite) (`tests/`)
- [x] Task 5.1: Tạo file kiểm thử `tests/student-portal-edge-cases.spec.ts` thực thi đầy đủ **7 Test Cases nghiêm ngặt**:
  - **Test Case 1:** Tên lớp tiếng Việt có dấu, khoảng trắng & Emoji (`"Lớp Vào Đời 1A (Thứ 7 - 18h30) & Ban Giáo Lý Viên 🌟"`) $\rightarrow$ `200 OK`, không lỗi `ERR_INVALID_CHAR`, giải mã `decodeURIComponent(X-Class-Name)` khớp 100% bản gốc.
  - **Test Case 2:** Kiểm tra lộ diện đủ 3 custom headers (`X-Class-Code`, `X-Class-Name`, `X-Teacher-Verified`) cùng `Access-Control-Expose-Headers`.
  - **Test Case 3:** Xác thực Token PIN Giáo viên qua cả 4 kịch bản: Query `?token=PIN_GLV0` đúng (`true`), Header `x-teacher-pin: PIN_GLV0` đúng (`true`), PIN sai (`false`), và không truyền PIN (`false`).
  - **Test Case 4:** Chống lỗ hổng **CRLF Header Injection / HTTP Response Splitting** khi tên lớp chứa `"Lớp Test\r\nSet-Cookie: evil_token=123\r\nX-Injected: true"` $\rightarrow$ `\r\n` bị mã hóa thành `%0D%0A`, không xuất hiện header `Set-Cookie` hay `X-Injected`.
  - **Test Case 5:** Tên lớp mang giá trị `NULL`, rỗng `""` hoặc toàn khoảng trắng `"   "` $\rightarrow$ Backend trả `X-Class-Name: ""`, không crash, Frontend fallback an toàn về `classCode` (`"GLV0"`).
  - **Test Case 6:** Chuỗi URI bị cắt cụt / hỏng (`"%E1"`, `"L%E1%BB%9Bp%"`) tại bộ giải mã Frontend $\rightarrow$ Bắt gọn `URIError: URI malformed` trong `try/catch` và trả về fallback an toàn.
  - **Test Case 7:** Kiểm thử CORS Preflight (`OPTIONS /api/classes/GLV0/students` với `Origin` và `Access-Control-Request-Headers: x-teacher-pin`) & Kiểm thử phân quyền Giáo viên cập nhật ảnh học sinh đã `success` (`200 OK` với PIN đúng vs `409 Conflict` khi không có PIN).
- [x] Task 5.2: Chạy toàn bộ test suite (`npx vitest run`) xác nhận PASS 100%.
*Checkpoint Verification:* Toàn bộ bài kiểm thử trong `tests/student-portal-edge-cases.spec.ts` và các test suite hiện có vượt qua 100%.

---

## 4. Handoff Trigger
- Khi người dùng phản hồi **"Proceed"**, **"Approved"** hoặc **"Đồng ý"**, Agent chuyển sang Code Mode và thực thi tuần tự từ Phase 1 đến Phase 5.
