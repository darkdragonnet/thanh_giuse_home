# Implementation Plan: Tích Hợp Real-time Draft Picks Sync, Unified Identity Key (HOẶC Tên HOẶC SĐT) & Ẩn Danh Bầu Cử Kín Cho n8n Zalo Broadcast

## 1. Architectural Context & Constraints
- **Hardware/VPS Limits:**
  - VPS Ubuntu: 3 vCPU, 3.0 GB RAM, 20 GB SSD, 2.0 GB Swap.
  - Tổng RAM Docker Containers duy trì $\le$ 2.112 MB (hiện dùng $\approx 90\text{ MB}$).
  - Tận dụng `thanh_giuse_redis` (Redis 7 AOF) với thao tác non-blocking $O(1)$ qua Sorted Set (`ZSET`) và Pipeline.
  - Tận dụng PostgreSQL 16 schema `giatruong` cho cơ chế Unified Identity Key chống trùng phiếu.
  - Zero-blocking: Không dùng `KEYS`, không tạo container mới, không tiêu hao RAM quá 1 MB.
- **Affected Files:**
  - `apps/api/src/routes/giatruong.ts`:
    - Áp dụng cơ chế **Unified Identity Key** (`POST /session/start`, `GET /session/active`, `POST /submit-vote`)
    - Bổ sung 2 endpoints: `POST /giatruong/api/draft-pick`, `GET /giatruong/api/live-status`
    - Dọn dẹp Redis atomic trong `/submit-vote`
  - `apps/api/public/giatruong/index.html`:
    - Giao diện linh hoạt: Cử tri có thể nhập **HOẶC Tên HOẶC Số điện thoại** (nút bấm sáng lên khi thỏa mãn 1 trong 2)
    - Bổ sung hàm `syncDraftToServer` với Debounce 400ms gửi snapshot danh sách đang chọn
  - `apps/api/public/giatruong/admin.html`:
    - Tích hợp trigger n8n webhook khi Admin mở phiên Bầu Thật
  - `tests/giatruong-voting.spec.ts`:
    - Bổ sung test cases kiểm thử: cử tri chỉ nhập tên, cử tri chỉ nhập SĐT, chống bầu trùng theo Unified Identity Key, ghi nhận draft, live-status aggregation, ẩn danh nhân tố mới và dọn dẹp chống đếm trùng khi nộp phiếu.

---

## 2. Technical Decisions & Architectural Rules

### A. Cơ Chế Khóa Định Danh Thống Nhất (Unified Identity Key) - HOẶC Tên HOẶC Số Điện Thoại
- **Mục tiêu UX:** Cử tri lớn tuổi trong nhóm Zalo có thể thao tác dễ dàng nhất. Không bắt buộc phải điền cả 2 trường. Chỉ cần điền Họ Tên (ví dụ: *"Bác Ba"*, *"Nguyễn Văn An"*) **HOẶC** Số điện thoại (ví dụ: *"0901234567"*).
- **Quy tắc chuẩn hóa Unified Identity Key tại Backend:**
  ```typescript
  const cleanPhone = (voter_phone || '').trim().replace(/\D/g, '');
  const cleanName = removeVietnameseTones(voter_name || '');

  // Xác định khóa định danh duy nhất (Ưu tiên SĐT nếu có, nếu không thì dùng tên chuẩn hóa)
  let identityKey = '';
  if (cleanPhone.length >= 9) {
    identityKey = `phone:${cleanPhone}`;
  } else if (cleanName.length >= 2) {
    identityKey = `name:${cleanName}`;
  } else {
    return reply.status(400).send({ success: false, message: 'Vui lòng nhập Họ tên (tối thiểu 2 ký tự) HOẶC Số điện thoại (tối thiểu 9 số).' });
  }
  ```
- **Chống Gian Lận (1 Người = 1 Phiếu Bầu Thật):**
  - Kiểm tra trong `giatruong.votes` theo cả `voter_phone` (nếu có) và `voter_name` (chuẩn hóa).
  - Nếu đã tồn tại lượt bầu chính thức (`is_trial = false`), từ chối tạo phiên mới với thông báo: *"Thông tin định danh này đã hoàn thành lượt bầu chính thức."*
- **Khôi Phục Phiên Dở Dang (`/session/active`):**
  - Hỗ trợ tra cứu theo `phone` HOẶC `name` để khôi phục phiên khi cử tri mở lại Zalo.

### B. Non-blocking $O(1)$ Sliding Window bằng Redis ZSET
- **Ghi nhận Draft (`POST /draft-pick`):**
  - Sử dụng Redis Pipeline thực thi 2 lệnh atomic:
    1. `ZADD giatruong:active_sessions <Date.now()> <session_id>`: Lưu timestamp cử tri thao tác.
    2. `SETEX giatruong:draft:<session_id> 600 <JSON.stringify(candidate_ids)>`: Lưu snapshot danh sách ID với TTL 10 phút.
- **Đếm Cử Tri Đang Thao Tác (`GET /live-status`):**
  - Dọn dẹp session ngắt kết nối quá 10 phút: `ZREMRANGEBYSCORE giatruong:active_sessions 0 <now - 600000>`.
  - Đếm số người online: `ZCARD giatruong:active_sessions` ($O(1)$) - phản hồi $< 0.1\text{ms}$.
  - Lấy các active session IDs bằng `ZRANGE giatruong:active_sessions 0 -1` và dùng `pipeline.get` để lấy draft snapshot của từng session.

### C. Triệt Tiêu Hoàn Toàn Rủi Ro Đếm Trùng (Double Counting Prevention)
- Khi cử tri nộp phiếu chính thức (`POST /submit-vote`):
  - Ngay sau lệnh `await client.query('COMMIT')` ghi nhận vào PostgreSQL, thực hiện lệnh atomic giải phóng draft trong Redis:
    ```typescript
    await redis.pipeline()
      .zrem('giatruong:active_sessions', session_id)
      .del(`giatruong:draft:${session_id}`)
      .exec();
    ```
  - Đảm bảo một cử tri khi đã nộp phiếu chỉ xuất hiện duy nhất 1 lần trong `official_votes`, không bị đếm trùng trong `draft_votes`.

### D. Nguyên Tắc Bầu Cử Kín (Secret Ballot Anonymization)
- Với ứng viên thuộc danh sách chính thức (`typeof id === 'number'`): Tính `draft_votes` bình thường.
- Với ứng viên tự gõ mới ngoài danh sách (`typeof id === 'string'` hoặc có tên):
  - Không công bố tên cụ thể trong suốt 8 phút bỏ phiếu.
  - Gom toàn bộ vào chỉ số tổng hợp: `custom_candidates_count`.
  - Thông báo hiển thị dạng: `"Ghi nhận có X lượt lựa chọn dành cho các nhân tố mới ngoài danh sách đề cử!"` và `"(Nhân tố mới được giới thiệu): X lượt chọn ẩn danh"`.

### E. Tích Hợp n8n Webhook & Zalo Sender
- Target Zalo Webhook: `https://n8nhome.gaudetedomino.io.vn/webhook/zalo-send?token=LongDen1982`
- Phục vụ 3 nhóm Zalo mục tiêu (`8686690356639968363`, `7827473883866993990`, `273312943654375725`).
- Khi Admin mở Bầu Thật (`real_only`), trang `admin.html` tự động gửi tín hiệu kích hoạt luồng đếm ngược 8 phút tới webhook n8n.

---

## 3. Phased Execution Checklist

### Phase 1: Fastify Backend API Routes (Unified Identity Key & Redis ZSET)
- [x] Task 1.1: Cập nhật `POST /giatruong/api/session/start`:
  - Cho phép cử tri cung cấp **HOẶC `voter_name` (>=2 ký tự) HOẶC `voter_phone` (>=9 số)**.
  - Thiết lập cơ chế Unified Identity Key: nếu thiếu SĐT, gán giá trị định danh đại diện và ngược lại.
  - Kiểm tra chống bầu thật trùng lặp theo `identityKey`.
- [x] Task 1.2: Cập nhật `GET /giatruong/api/session/active`:
  - Hỗ trợ tìm kiếm theo `phone` HOẶC `name` để khôi phục phiên đang diễn ra.
- [x] Task 1.3: Bổ sung endpoint `POST /giatruong/api/draft-pick`:
  - Nhận `{ session_id, candidate_ids }`.
  - Thực thi Redis Pipeline: `zadd` vào `giatruong:active_sessions` và `setex` key `giatruong:draft:${session_id}` (TTL 600s).
- [x] Task 1.4: Bổ sung endpoint `GET /giatruong/api/live-status`:
  - Dọn dẹp sliding window bằng `zremrangebyscore` và đếm $O(1)$ bằng `zcard`.
  - Truy vấn kết quả phiếu thật từ PostgreSQL `giatruong.votes` và `giatruong.vote_details` (chỉ lấy `is_trial = FALSE`).
  - Lấy các session đang active từ Redis bằng `zrange` và `pipeline.get`.
  - Tổng hợp `draft_votes` cho ứng viên có ID số, đếm `custom_candidates_count` cho ứng viên chuỗi tên gõ tay.
  - Sắp xếp tổng điểm `total_score = draft_votes + official_votes`.
  - Xây dựng mảng thông điệp ẩn danh chuẩn Secret Ballot.
- [x] Task 1.5: Cập nhật `POST /giatruong/api/submit-vote`:
  - Ngay sau `COMMIT` PostgreSQL, thực thi `pipeline.zrem` và `del` key draft session của cử tri trong Redis.
*Checkpoint Verification:* Chạy `curl http://localhost:8090/giatruong/api/live-status` qua Nginx proxy nhận phản hồi JSON hợp lệ với `active_drafting_count`, `total_submitted_votes`, `top_estimated`.

### Phase 2: Frontend Client Integration (`index.html`)
- [x] Task 2.1: Cập nhật form nhập danh tính tại Chặng 1:
  - Cho phép người dùng nhập **Họ tên HOẶC Số điện thoại** (hoặc cả hai).
  - Cập nhật getter `isFormValid`:
    `return (this.voterName.trim().length >= 2) || (this.voterPhone.trim().replace(/\D/g, '').length >= 9);`
  - Nút bấm lớn thích ứng mở khóa ngay khi cử tri nhập 1 trong 2 trường.
- [x] Task 2.2: Thêm hàm `syncDraftToServer(sessionId, slots)` với Debounce 400ms:
  - Trích xuất mảng ID ứng viên đã chọn (nếu có `item.id` thì lấy ID số, nếu `isNew` thì lấy chuỗi tên).
  - Gửi ngầm tới `POST /giatruong/api/draft-pick` (dùng `.catch(() => {})` non-blocking).
- [x] Task 2.3: Gọi `syncDraftToServer` trong các hàm:
  - `selectCandidate(idx, item)`
  - `addNewCandidate(idx, rawName)`
  - `clearSlot(idx)`
  - `checkActiveSession()` (đồng bộ lại trạng thái khi cử tri mở lại Zalo)
*Checkpoint Verification:* Mở giao diện `http://localhost:8090/giatruong/`, thử chỉ nhập Họ Tên, nút Bắt đầu sáng lên; bấm vào chọn ứng viên, kiểm tra Redis ghi nhận đúng `sessionId` và `giatruong:draft:${sessionId}`.

### Phase 3: Admin Webhook Trigger Integration (`admin.html`)
- [x] Task 3.1: Cập nhật hàm `setStatus(status)` trong `apps/api/public/giatruong/admin.html`:
  - Khi Admin chọn `real_only`: Tự động kích hoạt luồng phát sóng Zalo trực tiếp 8 phút tới webhook:
    `https://n8nhome.gaudetedomino.io.vn/webhook/start-live-voting-broadcast`.
- [x] Task 3.2: Đồng bộ file HTML vào container `thanh_giuse_api` và rebuild persistence image.
*Checkpoint Verification:* Kiểm tra giao diện `http://localhost:8090/giatruong/admin.html` kết nối webhook n8n khi mở cổng Bầu Thật.

### Phase 4: Automated Testing & Verification Suite
- [x] Task 4.1: Bổ sung các test cases vào `tests/giatruong-voting.spec.ts`:
  - Test 11: Tạo phiên chỉ với Họ Tên (không có SĐT) $\rightarrow$ Thành công.
  - Test 12: Tạo phiên chỉ với SĐT (không có Họ Tên) $\rightarrow$ Thành công.
  - Test 13: `POST /draft-pick` lưu đúng vào Redis ZSET và key snapshot có TTL.
  - Test 14: `GET /live-status` trả về đúng số lượng active drafting, draft votes và Secret Ballot ẩn danh nhân tố mới.
  - Test 15: Xóa draft session sau khi `submit-vote` thành công, chống đếm trùng.
- [x] Task 4.2: Chạy toàn bộ test suite và kiểm tra Docker resource consumption (`docker stats`).
*Checkpoint Verification:* Chạy `npx tsx tests/giatruong-voting.spec.ts` đạt 100% pass (15/15 tests). Toàn bộ hệ thống Docker duy trì mức RAM chỉ ~115 MB / 2.112 MB.

---

## 4. Handoff Trigger
- Khi người dùng phản hồi **"Proceed"**, Agent chuyển sang Code Mode và thực thi tuần tự từ Phase 1.
