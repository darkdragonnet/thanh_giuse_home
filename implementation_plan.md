# Implementation Plan: Chuẩn Hóa AliasID Hậu Tố 4 Ký Tự Hash Bất Biến & Điều Khiển 3 Cấp Độ (1 Người / Chọn Lọc / Toàn Bộ)

## 1. Architectural Context & Constraints
- **Hardware/VPS Limits:**
  - Cấu hình VPS: Ubuntu 3 vCPU, 3.0 GB RAM, 20 GB SSD, 2.0 GB Swap.
  - Trần RAM Docker Containers $\le$ 2.112 MB (`app_api`: 512 MB, `app_worker`: 768 MB, `app_redis`: 192 MB, `app_postgres`: 512 MB).
- **Hiến Pháp Dự Án (`rules/00-constitution.md` Điều 3.2 & 4.1):**
  - **Định danh cố định đúng 9 ký tự:** Khớp tuyệt đối Regex `^[A-Za-z]{2}[A-Za-z0-9]{2}_[A-Za-z0-9]{4}$`.
  - **Cấu trúc mã 9 ký tự:** $\text{Alias} = \text{Prefix}_4 + \text{"\_"} + \text{Suffix}_4$.
  - **Bảo toàn định danh học sinh khi chuyển lớp:**
    - $\text{Suffix}_4$ (4 ký tự chữ và số) là **mã định danh duy nhất của cá nhân học sinh**, sinh mới 100% từ `personID` qua thuật toán FNV-1a Pure JS Base36 $\pmod{36^4}$.
    - Khi học sinh chuyển từ lớp này sang lớp khác (ví dụ: `TS1A` sang `TS2A`), chỉ có $\text{Prefix}_4$ thay đổi, còn $\text{Suffix}_4$ giữ nguyên bất biến $\rightarrow$ Triệt tiêu hoàn toàn nguy cơ trùng lặp mã khi gom học sinh về chung một lớp.
- **Affected Files:**
  - `packages/shared-types/src/hanet-cloud.ts`:
    - Thuật toán `generateDeterministicSuffix4(personID)`: FNV-1a 32-bit Pure JS Base36 $\pmod{36^4}$ (chi phí $O(n)$, $< 1\mu s$, 0 I/O, hoàn toàn thân thiện với RAM 512MB).
    - Hàm chuẩn hóa tiền tố `normalizePrefix4(rawPrefix)`: Ánh xạ 2 chữ cái đầu khối + Số/Lớp (VD: `GL1A`, `TS1A`, `RL2A`, `BD03`), đệm `0` nếu $< 4$ (`GLV` $\rightarrow$ `GLV0`), cắt 4 ký tự nếu fallback.
  - `apps/api/src/routes/admin.ts`:
    - Endpoint `POST /api/admin/hanet/sync-cloud-aliases`: Hỗ trợ tham số `person_ids?: string[]`. Khi không truyền `person_ids`, tự động đồng bộ toàn bộ mà không cần truyền payload mảng lớn qua mạng.
  - `apps/admin/src/components/hanet/CloudFaceInspectorTab.tsx`:
    - Tách biệt state `selectedPersonIds` (Set<string>) khỏi re-render bảng dữ liệu.
    - Checkbox chọn từng dòng + Checkbox chọn tất cả theo nhóm lớp hiện tại.
    - Nút icon **"Đồng bộ ngay"** tại từng hàng (Cấp độ 1: 1 người).
    - Nút **"Cập nhật đã chọn (X học sinh)"** trên thanh tác vụ khi có $\ge 1$ người được tick (Cấp độ 2: Chọn lọc).
    - Nút **"Đồng bộ Chuẩn Hóa Toàn Bộ (137 người)"** hoạt động độc lập, gửi body `{}` rỗng để tối ưu băng thông (Cấp độ 3: Toàn bộ).
  - `tests/sync-alias-reconciliation.spec.ts`:
    - Bộ kiểm thử hồi quy cho thuật toán hash $\text{Suffix}_4$, quy tắc tiền tố $\text{Prefix}_4$ và điều phối 3 cấp độ.

---

## 2. Technical Decisions & Algorithm Specifications

### A. Thuật Toán Sinh Tiền Tố 4 Ký Tự (`normalizePrefix4`):
1. **Tra cứu từ điển `CLOUD_CLASS_DICTIONARY`:**
   - Thêm Sức $\rightarrow$ `TS1A`, `TS1B`, `TS1C`, `TS2A`,...
   - Rước Lễ / Xưng Tội $\rightarrow$ `RL1A`, `RL2A`, `XT1A`,...
   - Bao Đồng $\rightarrow$ `BD1A`, `BD2A`, `BD3A`, `BD03`,...
   - Vào Đời $\rightarrow$ `VD1A`, `VD2A`,...
   - Sống Đạo $\rightarrow$ `SD1A`, `SD2A`,...
   - Ban Giáo Lý Viên $\rightarrow$ `GLV0`.
   - Lêgiô Mariae / DMHCCC $\rightarrow$ `DM01`, `LM01`.
2. **Quy tắc Trích xuất Thông minh & Fallback:**
   - Nếu độ dài $< 4$: Đệm thêm số `0` vào sau cho đủ 4 ký tự (ví dụ: `GLV` $\rightarrow$ `GLV0`, `LM` $\rightarrow$ `LM01`, `TN` $\rightarrow$ `TN00`).
   - Nếu độ dài $> 4$:
     - Ưu tiên: Lấy 2 chữ cái đầu khối + 2 ký tự số/lớp ở đuôi (ví dụ: `GIAOLY1A` $\rightarrow$ `GL1A`, `BAODONG3` $\rightarrow$ `BD03`, `THEMSUC1A` $\rightarrow$ `TS1A`, `XUNGTOI2A` $\rightarrow$ `XT2A` / `RL2A`).
     - Fallback: Cắt lấy 4 ký tự đầu tiên nếu không nhận diện được đuôi lớp.

### B. Thuật Toán Sinh Hậu Tố 4 Ký Tự Xác Định (`generateDeterministicSuffix4`):
- **Công thức:**
  $$\text{Suffix}_4 = \text{FNV1aBase36}(\text{personID}) \pmod{36^4}$$
- **Đặc tính kỹ thuật:**
  - Pure JS, độ phức tạp $O(n)$ với $n$ là chiều dài chuỗi personID, tiêu tốn chưa tới 1 microsecond, 0 I/O overhead, hoàn toàn thân thiện với giới hạn RAM 512MB container.
  - Tính lũy đẳng (Idempotency): Cùng 1 `personID`, dù chạy lại bao nhiêu lần vẫn cho ra cùng 1 chuỗi 4 ký tự in hoa.
  - Phân tán đều trong $36^4 = 1.679.616$ tổ hợp chữ số.

### C. Cơ Chế Điều Phối 3 Cấp Độ Cập Nhật (Worker & Queue):
1. **Cấp độ 1 (`SINGLE` - 1 người):**
   - Bấm icon "Đồng bộ" tại dòng học sinh $\rightarrow$ API nhận `{ person_ids: [personID] }`.
   - BullMQ đưa vào hàng đợi `priority = 1`.
   - Hoàn tất trong $\approx 3$ giây, Drawer hiển thị thành công.
2. **Cấp độ 2 (`SELECTED` - Nhóm chọn lọc qua checkbox):**
   - Tick chọn 2 hoặc nhiều học sinh $\rightarrow$ Bấm nút "Cập nhật đã chọn (X học sinh)".
   - State `selectedPersonIds` tách biệt, thao tác "Chọn tất cả" áp dụng theo nhóm lớp đang mở.
   - Worker chạy tuần tự: Job 1 $\rightarrow$ Cooldown 3.000ms $\rightarrow$ Job 2 $\rightarrow$ ...
   - Short Polling 3s hiển thị tiến độ % từng người.
3. **Cấp độ 3 (`ALL` - Toàn bộ 137 người):**
   - Nút "Đồng bộ Chuẩn Hóa Toàn Bộ (137 người)" gửi body `{}` rỗng độc lập với state `selectedPersonIds` $\rightarrow$ Tránh gửi mảng payload lớn qua mạng.
   - Xử lý tuần tự trong $\approx 7.5 - 8$ phút, tự động xóa cache Redis khi kết thúc.

---

## 3. Phased Execution Checklist

### Phase 1: Nâng Cấp Bộ Bóc Tách & Sinh Mã 9 Ký Tự (`packages/shared-types`)
- [ ] Task 1.1: Triển khai hàm `generateDeterministicSuffix4(personID: string): string` (FNV-1a 32-bit Pure JS Base36 $\pmod{36^4}$).
- [ ] Task 1.2: Triển khai hàm `normalizePrefix4(rawPrefix: string): string` (2 chữ cái đầu khối + 2 ký tự số/lớp ở đuôi, đệm `0` nếu $< 4$).
- [ ] Task 1.3: Cập nhật `parseAndClassifyAlias` tích hợp hai hàm trên, đảm bảo `aliasChuanHoaDuKien` luôn đạt đúng 9 ký tự `Prefix4_Suffix4`.
- [ ] Task 1.4: Biên dịch gói dùng chung `npm run build:packages`.
*Checkpoint Verification:* Test case `TN_Themsuc1a_01` (PersonID `18897244400810101`) sinh ra `TS1A_BBC1`, `GLV_FK2S` sinh ra `GLV0_PSA9`, đạt đúng 9 ký tự.

### Phase 2: Nâng Cấp API Tuyển Chọn Theo PersonID (`apps/api`)
- [ ] Task 2.1: Cập nhật `POST /api/admin/hanet/sync-cloud-aliases`:
  - Tiếp nhận body `{ person_ids?: string[] }`.
  - Nếu `person_ids` có dữ liệu: Lọc đúng các khuôn mặt được chỉ định (`validItems.filter(i => person_ids.includes(i.personID))`).
  - Nếu không có: Xử lý toàn bộ danh sách hợp lệ mà không phụ thuộc vào payload mạng.
- [ ] Task 2.2: Biên dịch `npm run build --workspace=@thanh-giuse/api`.
*Checkpoint Verification:* API hỗ trợ cả 3 kịch bản payload (1 ID, mảng nhiều ID, và payload rỗng).

### Phase 3: Nâng Cấp Giao Diện Admin SPA (`apps/admin`)
- [ ] Task 3.1: Quản lý state `selectedPersonIds: Set<string>` trong `CloudFaceInspectorTab.tsx` tách biệt vòng đời re-render bảng.
- [ ] Task 3.2: Thêm Checkbox chọn từng dòng + Checkbox chọn tất cả theo nhóm lớp hiện tại.
- [ ] Task 3.3: Thêm nút icon **"Đồng bộ"** tại cột Thao tác của từng hàng.
- [ ] Task 3.4: Thêm nút **"Cập nhật đã chọn (X học sinh)"** khi `selectedPersonIds.size > 0`.
- [ ] Task 3.5: Nút "Đồng bộ Chuẩn Hóa Toàn Bộ" độc lập, gửi body rỗng.
- [ ] Task 3.6: Biên dịch `npm run build --workspace=@thanh-giuse/admin`.
*Checkpoint Verification:* Vite build admin SPA thành công 100%.

### Phase 4: Kiểm Thử Tự Động & Hồi Quy (`tests/`)
- [ ] Task 4.1: Bổ sung test kiểm tra tính xác định và duy nhất của `generateDeterministicSuffix4`.
- [ ] Task 4.2: Bổ sung test kiểm tra quy tắc trích xuất tiền tố `normalizePrefix4`.
- [ ] Task 4.3: Chạy `npx vitest run tests/sync-alias-reconciliation.spec.ts` đạt 100% PASS.
*Checkpoint Verification:* Toàn bộ test suite Vitest vượt qua 100%.

### Phase 5: Đóng Gói, Triển Khai VPS & Quy Trình Test-Drive Thực Tế
- [ ] Task 5.1: Build lại các image Docker (`app_api`, `app_worker`, `app_proxy`).
- [ ] Task 5.2: Git push lên nhánh `feature/hanet-mock-server`.
- [ ] Task 5.3: Hướng dẫn kéo về VPS và test-drive theo 3 bước:
  - Test 1: Đồng bộ lẻ 1 người.
  - Test 2: Tick chọn 2 người và bấm "Cập nhật đã chọn".
  - Test 3: Kích hoạt toàn bộ danh sách.
*Checkpoint Verification:* Nghiệm thu toàn bộ Face ID trên Cloud mang mã chuẩn 9 ký tự, không trùng lặp khi chuyển lớp.

---

## 4. Handoff Trigger
- Khi người dùng phản hồi **"Proceed"**, **"Approved"** hoặc **"Đồng ý"**, Agent chuyển sang Code Mode và tiến hành thực thi tuần tự từ Phase 1.
