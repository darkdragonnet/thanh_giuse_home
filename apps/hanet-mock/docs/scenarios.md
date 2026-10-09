# HƯỚNG DẪN KỊCH BẢN (SCENARIOS) & CƠ CHẾ KÍCH HOẠT

## 1. Danh sách 9 Kịch bản (Scenarios)

1. **`success` (Mặc định):**
   * Mô phỏng đăng ký thành công.
   * Sinh `personID` theo quy tắc `mock_${aliasID}_${Date.now()}`.
   * Lưu vào in-memory store để các lệnh sau (`getListByPlace`, `removePersonByID`) có thể đọc/xóa được.

2. **`-503` (HANET Quá Tải / System Error):**
   * Trả về ngay: `{ "returnCode": -503, "returnMessage": "SYSTEM_ERROR" }`.
   * Mục đích: Test logic Retry backoff 300s và Circuit Breaker của BullMQ Worker.

3. **`-103` (Access Token Hết Hạn):**
   * Trả về ngay: `{ "returnCode": -103, "returnMessage": "ACCESS_TOKEN_EXPIRE" }`.
   * Mục đích: Test cơ chế tự động refresh token trong DB của Worker.

4. **`-9006` (Ảnh Không Hợp Lệ):**
   * Trả về ngay: `{ "returnCode": -9006, "returnMessage": "EMPLOYEE_REGISTER_IMG_INVALID_ERROR" }`.
   * Mục đích: Test logic chuyển trạng thái `manual_review` ngay lập tức (không retry lãng phí).

5. **`-9007` (Khuôn Mặt Trùng Lặp):**
   * Trả về ngay: `{ "returnCode": -9007, "returnMessage": "EMPLOYEE_REGISTER_IMG_DUPLICATE_ERROR" }`.
   * Mục đích: Test logic phát hiện gian lận nộp ảnh người khác.

6. **`-9008` (Hết Hạn Ngạch Face ID):**
   * Trả về ngay: `{ "returnCode": -9008, "returnMessage": "FACE_ID_NOT_ENOUGH_ERROR" }`.
   * Mục đích: Test cơ chế gửi cảnh báo Telegram khẩn cấp cho Quản trị viên.

7. **`-5011` (Không Tìm Thấy Người):**
   * Trả về ngay: `{ "returnCode": -5011, "returnMessage": "PERSON_NOT_FOUND" }`.

8. **`slow` (Mạng Chậm / AI Xử Lý Lâu):**
   * Trì hoãn 30 giây (delay 30.000 ms), sau đó trả về kết quả thành công.

9. **`timeout` (Mất Kết Nối Hoàn Toàn):**
   * Không bao giờ trả về phản hồi (Unresolved Promise).
   * Mục đích: Kiểm tra `AbortSignal.timeout(120000)` của Worker có tự ngắt kết nối đúng 120s không.

---

## 2. Cách Điều Khiển Kịch Bản Khi Gửi Request

### Cách 1: Gửi qua Header (Khuyên dùng khi viết kịch bản test tự động)
```bash
curl -X POST http://localhost:4000/person/registerByUrl \
  -H "x-mock-scenario: -503" \
  --data "token=mock&name=Test&aliasID=HS01&placeID=196&file_url=https://..."
```

### Cách 2: Gửi qua Query Parameter
```bash
curl -X POST "http://localhost:4000/person/registerByUrl?mock_scenario=-9006" \
  --data "token=mock&name=Test&aliasID=HS01&placeID=196&file_url=https://..."
```

### Cách 3: Gửi qua Body Field
```bash
curl -X POST http://localhost:4000/person/registerByUrl \
  --data "token=mock&mock_scenario=-103&name=Test&aliasID=HS01&placeID=196&file_url=https://..."
```

### Cách 4: Ép Kịch bản Toàn Cục (Global Override)
```bash
# Ép mọi request trong 30s đều bị lỗi quá tải -503
curl -X POST http://localhost:4000/mock/scenario \
  -H "Content-Type: application/json" \
  -d '{"scenario": "-503", "ttl_seconds": 30}'
```
