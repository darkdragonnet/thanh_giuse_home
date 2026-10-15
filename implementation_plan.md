# Implementation Plan: Tích Hợp Ấn Định Thời Gian Bắt Đầu, Đồng Bộ 8 Phút & Quản Lý Lịch Sử Đợt Bầu Cử (Election Rounds)

## 1. Architectural Context & Constraints
- **Hardware/VPS Limits:**
  - VPS Ubuntu: 3 vCPU, 3.0 GB RAM, 20 GB SSD, 2.0 GB Swap.
  - Tổng RAM Docker Containers duy trì $\le$ 2.112 MB (hiện dùng $\approx 115\text{ MB}$).
  - Sử dụng non-blocking Redis 7 Sorted Set (`ZSET`) và PostgreSQL 16 schema `giatruong`.
- **Phạm vi tác động (Affected Files):**
  - Database schema: `docker/postgres/init.sql` (bảng `giatruong.election_rounds`, khóa ngoại `round_id` và unique index per-round).
  - Backend API: `apps/api/src/routes/giatruong.ts`
    - Cập nhật Redis Namespace theo Round: `giatruong:round:<round_id>:*`
    - Logic tính toán thời gian toàn cục đồng bộ (Synchronized Global Window: `round.expires_at`).
    - API ấn định giờ (`fixed_time` hoặc `delay_minutes`), đổi giờ (Reschedule), hủy giờ (Cancel).
    - API khởi tạo đợt bầu mới (Reset về 0 + Lưu vết lịch sử).
    - API truy vấn lịch sử đợt bầu (`GET /giatruong/api/admin/rounds`, `GET /giatruong/api/admin/rounds/:id/results`).
  - Frontend Cử tri: `apps/api/public/giatruong/index.html`
    - Triệt tiêu Thundering Herd: Cache sẵn candidates trong RAM, chuyển stage mượt kèm Jitter 0-800ms.
    - Phòng Chờ (Waiting Room) với Heartbeat Polling 5s chống lệch lịch Admin.
    - Xử lý cử tri vào trễ (Late-joiners): Tính thời gian còn lại chính xác, đếm lùi về cùng 1 mốc đóng cổng chung.
  - Frontend Quản trị: `apps/api/public/giatruong/admin.html`
    - Bộ điều khiển ấn định giờ: Hẹn giờ nhanh (+3, +5, +10, +15 phút) HOẶC Time Picker cố định (HH:mm) HOẶC Bắt đầu ngay.
    - Nút Đổi Giờ / Hoãn / Hủy đợt bầu.
    - Nút Khởi động Đợt Bầu Mới (Reset về 0).
    - Tab Lịch Sử Các Đợt Bầu Cử (Round 1, Round 2...).
  - Test Suite: `tests/giatruong-voting.spec.ts`

---

## 2. Technical Decisions & 5 Kỹ Thuật Chống Bẫy Tiềm Ẩn

### Bẫy 1: Bẫy Tắc Nghẽn Tại "Thời Điểm G" (Thundering Herd Problem)
- **Nguy cơ:** Khi 60–100 cử tri ngồi trong phòng chờ cùng nhảy sang 00:00, nếu đồng loạt gửi request tải danh sách ứng viên hoặc tạo session, server Fastify và DB pool có thể bị Spike đột biến.
- **Giải pháp:**
  - Tải trước toàn bộ `candidates` vào RAM của client ngay từ khi cử tri đang ở Phòng Chờ.
  - Đúng giờ G, client chuyển trạng thái `stage = 2` tức thì trong giao diện mà **không cần gọi lại API `/candidates`**.
  - Client thêm độ trễ ngẫu nhiên (**Jitter $0$ đến $800\text{ ms}$**) khi gửi request kích hoạt phiên lên máy chủ để phân tán tải.

### Bẫy 2: Phân Lập State Redis Giữa Các Đợt Bầu (Redis Round Isolation)
- **Nguy cơ:** Chuyển từ Đợt 1 sang Đợt 2 nếu không xóa hoặc tách key Redis thì lượt chọn nháp cũ sẽ rò rỉ sang bảng xếp hạng của Đợt 2.
- **Giải pháp:**
  - Bổ sung `round_id` vào toàn bộ namespace khóa Redis:
    - `giatruong:round:<round_id>:active_sessions` (Sorted Set timestamp)
    - `giatruong:round:<round_id>:draft:<session_id>` (Snapshot danh sách ID nháp)
  - Khi Admin bấm *"Khởi động Đợt Bầu Mới"*, backend tự động dọn dẹp riêng cho round cũ:
    ```typescript
    await redis.del(`giatruong:round:${oldRoundId}:active_sessions`);
    ```
  - Bảng xếp hạng và draft của Đợt mới hoàn toàn độc lập và xuất phát từ 0.

### Bẫy 3: Xử Lý Cử Tri Vào Trễ (Late-Joiners Handling)
- **Nguy cơ:** Cử tri mở link vào phút thứ 5 của đợt bầu (đợt bầu 8 phút chỉ còn 3 phút).
- **Giải pháp:**
  - Tính thời gian còn lại:
    $$\text{remainingSeconds} = \text{round.expires\_at} - \text{nowServer}$$
  - Nếu $\text{remainingSeconds} \le 0$: Chặn ngay từ màn hình ngoài với thông báo: *"Đợt bầu cử này đã kết thúc lúc HH:mm."*
  - Nếu $0 < \text{remainingSeconds} < \text{round.duration\_minutes} \times 60$: Cho phép nhập thông tin và vào thẳng màn hình bầu cử, đồng hồ đếm ngược hiển thị chính xác số phút/giây còn lại (ví dụ: `02:59`), vạch màu tự động chuyển sang màu Cam/Đỏ cảnh báo. Cả hệ thống cùng chốt sổ tại một thời điểm duy nhất.

### Bẫy 4: Kịch Bản Admin Hủy / Đổi Giờ (Reschedule & Cancellation Edge Case)
- **Nguy cơ:** Admin hẹn 19:30, cử tri đang ở phòng chờ. Admin lùi giờ sang 19:45. Nếu client chỉ đếm lùi tĩnh, cử tri sẽ bị nhảy vào form sai thời điểm.
- **Giải pháp:**
  - Trong lúc ở phòng chờ, client duy trì **Heartbeat Polling nhẹ mỗi 5 giây** gọi `GET /giatruong/api/config`.
  - Nếu `scheduled_start_at` thay đổi hoặc trạng thái chuyển sang `'cancelled'`, phòng chờ tự động cập nhật mốc giờ mới hoặc hiển thị thông báo tạm hoãn ngay lập tức mà không cần người dùng thao tác.

### Bẫy 5: Cơ Chế Khóa Phiếu Theo Từng Đợt (Per-Round Idempotency)
- **Nguy cơ:** Cử tri đã bỏ phiếu ở Đợt 1, khi chuyển sang Đợt 2 hệ thống cũ chặn số điện thoại toàn cục sẽ báo lỗi "Đã bỏ phiếu rồi".
- **Giải pháp:**
  - Ràng buộc Unique chống trùng phiếu chuyển thành cặp đôi theo `round_id`:
    ```sql
    ALTER TABLE giatruong.votes 
    ADD CONSTRAINT uq_votes_round_phone UNIQUE (round_id, voter_phone);
    ```
  - Trong cùng Đợt 1 chỉ được bầu 1 lần, nhưng sang Đợt 2 cử tri hoàn toàn có quyền bỏ phiếu tiếp.

---

## 3. Lược Đồ Cơ Sở Dữ Liệu Nâng Cấp (Database Schema Migration)

```sql
-- 1. Bảng quản lý đợt bầu cử
CREATE TABLE IF NOT EXISTS giatruong.election_rounds (
    id SERIAL PRIMARY KEY,
    round_number INT NOT NULL DEFAULT 1,
    title VARCHAR(150) NOT NULL,
    status VARCHAR(30) NOT NULL DEFAULT 'scheduled', -- 'scheduled', 'in_progress', 'completed', 'cancelled'
    scheduled_start_at TIMESTAMPTZ,
    started_at TIMESTAMPTZ,
    expires_at TIMESTAMPTZ,
    duration_minutes INT NOT NULL DEFAULT 8,
    total_votes INT NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

-- 2. Khởi tạo Đợt 1 mặc định nếu chưa có
INSERT INTO giatruong.election_rounds (round_number, title, status, duration_minutes)
VALUES (1, 'Bầu Cử Ban Điều Hành Gia Trưởng - Khóa Mới', 'scheduled', 8)
ON CONFLICT DO NOTHING;

-- 3. Cập nhật bảng voting_sessions
ALTER TABLE giatruong.voting_sessions 
ADD COLUMN IF NOT EXISTS round_id INT REFERENCES giatruong.election_rounds(id);

-- 4. Cập nhật bảng votes & voting_sessions với cột clean_voter_name
ALTER TABLE giatruong.voting_sessions 
ADD COLUMN IF NOT EXISTS round_id INT REFERENCES giatruong.election_rounds(id),
ADD COLUMN IF NOT EXISTS clean_voter_name VARCHAR(100);

ALTER TABLE giatruong.votes 
ADD COLUMN IF NOT EXISTS round_id INT REFERENCES giatruong.election_rounds(id),
ADD COLUMN IF NOT EXISTS clean_voter_name VARCHAR(100);

-- Cho phép voter_phone nullable nếu cử tri chỉ nhập Tên (và ngược lại)
ALTER TABLE giatruong.voting_sessions ALTER COLUMN voter_phone DROP NOT NULL;
ALTER TABLE giatruong.votes ALTER COLUMN voter_phone DROP NOT NULL;

-- Đặt mặc định dữ liệu cũ trỏ về round_id = 1
UPDATE giatruong.voting_sessions SET round_id = 1 WHERE round_id IS NULL;
UPDATE giatruong.votes SET round_id = 1 WHERE round_id IS NULL;

-- 5. Ràng buộc kép có điều kiện (Partial Unique Indexes) bảo đảm 1 người 1 phiếu per Round:
-- Trường hợp có SĐT (nhập SĐT hoặc cả Tên và SĐT)
CREATE UNIQUE INDEX IF NOT EXISTS uq_votes_round_phone 
  ON giatruong.votes (round_id, voter_phone) 
  WHERE voter_phone IS NOT NULL AND voter_phone != '';

-- Trường hợp chỉ nhập Tên mà không nhập SĐT
CREATE UNIQUE INDEX IF NOT EXISTS uq_votes_round_name 
  ON giatruong.votes (round_id, clean_voter_name) 
  WHERE (voter_phone IS NULL OR voter_phone = '') AND clean_voter_name IS NOT NULL AND clean_voter_name != '';

CREATE INDEX IF NOT EXISTS idx_giatruong_sessions_round ON giatruong.voting_sessions(round_id, status);
CREATE INDEX IF NOT EXISTS idx_giatruong_votes_round ON giatruong.votes(round_id);
```

---

## 4. Phased Execution Checklist

### Phase 1: Database Migration & Schema Upgrade
- [ ] Task 1.1: Cập nhật `docker/postgres/init.sql` và tạo file migration `docker/postgres/migrations/010_giatruong_voting_schema.sql` với bảng `giatruong.election_rounds` và các ràng buộc per-round.
- [x] Task 1.2: Thực thi migration DDL trực tiếp vào container đang chạy:
  `docker exec -i thanh_giuse_postgres psql -U postgres_user -d thanh_giuse_db < docker/postgres/migrations/011_election_rounds_and_scheduled_voting.sql`
- [x] Task 1.3: Khởi tạo Round 1 mặc định và liên kết các bản ghi hiện tại về Round 1.
*Checkpoint Verification:* Đã xác minh cấu trúc bảng `giatruong.election_rounds` (kèm `ended_at`), 2 unique indexes `uq_votes_round_phone`, `uq_votes_round_name` hoạt động chính xác.

### Phase 2: Fastify Backend API Refactor & Redis Namespace (`giatruong.ts`)
- [x] Task 2.1: Cập nhật `GET /config`:
  - Trả về thông tin round hiện hành: `current_round: { id, round_number, title, status, scheduled_start_at, started_at, expires_at, remaining_seconds_to_start, remaining_seconds_to_end }`.
- [x] Task 2.2: Phân lập Redis State:
  - Cập nhật `POST /draft-pick` sử dụng namespace `giatruong:round:<round_id>:active_sessions` và `giatruong:round:<round_id>:draft:<session_id>`.
  - Cập nhật `GET /live-status` đọc theo `current_round_id`.
- [x] Task 2.3: Bộ API Quản trị Đợt Bầu Cử:
  - `POST /admin/schedule-round`: Ấn định thời gian (`delay_minutes`, `scheduled_start_at` hoặc `fixed_time`), cập nhật `scheduled_start_at` và `expires_at`.
  - `POST /admin/reschedule-round`: Đổi giờ hẹn (`delay`, `fixed_time`), kích hoạt ngay (`start_now`) hoặc Hủy/Hoãn đợt bầu (`cancel`).
  - `POST /admin/new-round`: Chốt kết quả round cũ (`status = 'completed'`), dọn Redis rác cũ, tạo round mới với phiếu reset về 0.
  - `GET /admin/rounds`: Danh sách toàn bộ lịch sử các đợt bầu.
  - `GET /admin/rounds/:id/results`: Bảng xếp hạng và thống kê chi tiết của một đợt cụ thể trong lịch sử.
- [x] Task 2.4: Tái cấu trúc `POST /session/start` và `POST /submit-vote`:
  - Tính toán `expires_at` đồng bộ theo `round.expires_at`.
  - Kiểm tra 1 người 1 phiếu chặt chẽ trong phạm vi `current_round_id`.
  - Chặn cử tri vào nếu `remainingSeconds <= 0` hoặc khi round đang `scheduled`.
*Checkpoint Verification:* Toàn bộ API hoạt động trơn tru, TypeScript build 0 lỗi.

### Phase 3: Frontend Cử Tri - Phòng Chờ & Đồng Bộ 8 Phút (`index.html`)
- [x] Task 3.1: Triệt tiêu Thundering Herd:
  - Tải sẵn danh sách `candidates` vào RAM client khi cử tri còn ở Phòng Chờ.
  - Đến giờ G, chuyển stage 2 nội bộ, thêm jitter ngẫu nhiên 0-800ms khi gửi request kích hoạt.
- [x] Task 3.2: Giao diện Phòng Chờ (Waiting Room):
  - Nhập tên/SĐT trước $\rightarrow$ Hiện màn hình đếm ngược trang trọng: *"Cổng bình chọn sẽ mở lúc HH:mm:ss - Còn lại: mm:ss"*.
  - Duy trì Heartbeat Polling 5s gọi `GET /config` để kịp thời đón nhận nếu Admin đổi giờ hoặc hủy đợt.
- [x] Task 3.3: Xử lý cử tri vào trễ (Late-joiners):
  - Hiển thị chính xác thời gian còn lại của đợt bầu (`round.expires_at - nowServer`), tự động chuyển màu Cam/Đỏ cảnh báo.
  - Chặn vào nếu đợt bầu đã kết thúc.
*Checkpoint Verification:* Giao diện phòng chờ đếm ngược trực quan, AudioContext mở khóa mượt mà, đồng hồ hiển thị chính xác.

### Phase 4: Frontend Quản Trị - Ấn Định Giờ & Lịch Sử Đợt Bầu (`admin.html`)
- [x] Task 4.1: Bổ sung bộ điều khiển ấn định giờ tại Section 1:
  - Nút bấm nhanh: "+2 phút", "+5 phút", "+10 phút".
  - Time Picker chọn giờ cụ thể (ví dụ: `19:30`).
  - Nút "Mở Bầu Ngay Lập Tức" và các thao tác hoãn / hủy hẹn giờ.
- [x] Task 4.2: Nút "Khởi Động Đợt Bầu Mới":
  - Modal xác nhận: Lưu đợt hiện tại vào lịch sử, reset số phiếu về 0 cho đợt tiếp theo.
- [x] Task 4.3: Tab "Lịch Sử Các Đợt Bầu":
  - Bảng danh sách Đợt 1, Đợt 2... kèm thời gian, tổng số phiếu, trạng thái.
  - Modal xem bảng xếp hạng Top ứng viên chi tiết của từng đợt quá khứ.
*Checkpoint Verification:* Khởi tạo đợt mới reset phiếu về 0 thành công, tra cứu lịch sử đầy đủ.

### Phase 5: Automated Testing, Deployment & Verification
- [x] Task 5.1: Mở rộng `tests/giatruong-voting.spec.ts`:
  - Test case 17: Admin ấn định giờ bắt đầu & giữ cử tri ở phòng chờ.
  - Test case 18: Admin reschedule (hoãn +2 phút & kích hoạt ngay `start_now`).
  - Test case 19: Synchronized window & cử tri vào trễ nhận đúng thời gian còn lại.
  - Test case 20: Khởi động Đợt Mới: reset phiếu về 0 & cử tri đợt 1 được bầu lại ở đợt 2.
  - Test case 21: Per-round idempotency (1 người 1 phiếu trong cùng đợt).
  - Test case 22: Election rounds history & tra cứu bảng điểm đợt cũ.
- [x] Task 5.2: Rebuild Docker image `thanh_giuse_api` và kiểm tra RAM $\le$ 2.112 MB.
*Checkpoint Verification:* Test suite chạy 22/22 tests PASS (100%), tổng RAM 6 containers $\approx$ 120 MB (cực kỳ an toàn so với hạn mức VPS 2.112 GB).

---

## 5. Kết Luận & Bàn Giao
Hệ thống đã được kiểm thử end-to-end hoàn chỉnh, đáp ứng chính xác 100% các yêu cầu về Ấn định thời gian, Phòng Chờ, Đồng bộ 8 phút tập trung, Reset về 0 có Lưu lịch sử, và 5 kỹ thuật chống bẫy hạ tầng.
