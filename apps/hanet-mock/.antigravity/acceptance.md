# ACCEPTANCE CRITERIA — TIÊU CHÍ NGHIỆM THU

## AC1. Cung cấp đủ 11 Endpoint HANET
1. `POST /person/registerByUrl` (Đăng ký người mới bằng URL ảnh)
2. `POST /person/updateByFaceImage` (Cập nhật ảnh qua file multipart)
3. `POST /person/updateByFaceImageByPersonID`
4. `POST /person/updateByFaceUrl`
5. `POST /person/updateByFaceUrlByAliasID`
6. `POST /person/updateByFaceUrlByPersonID`
7. `POST /person/getListByPlace` (Lấy danh sách người tại địa điểm)
8. `POST /person/removePersonByID` (Xóa người theo ID)
9. `POST /person/getCheckinByPlaceIdInDay`
10. `POST /person/getCheckinByPlaceIdInTimestamp`
11. `POST /device/getConnectionStatus` (Kiểm tra trạng thái thiết bị)

## AC2. Hỗ trợ tối thiểu 9 Kịch bản (Scenarios)
* `success`: Trả về `returnCode: 1`, `returnMessage: "SUCCESS"`, kèm dữ liệu giả lập.
* `-503`: Trả về `returnCode: -503`, `returnMessage: "SYSTEM_ERROR"`.
* `-103`: Trả về `returnCode: -103`, `returnMessage: "ACCESS_TOKEN_EXPIRE"`.
* `-9006`: Trả về `returnCode: -9006`, `returnMessage: "EMPLOYEE_REGISTER_IMG_INVALID_ERROR"`.
* `-9007`: Trả về `returnCode: -9007`, `returnMessage: "EMPLOYEE_REGISTER_IMG_DUPLICATE_ERROR"`.
* `-9008`: Trả về `returnCode: -9008`, `returnMessage: "FACE_ID_NOT_ENOUGH_ERROR"`.
* `-5011`: Trả về `returnCode: -5011`, `returnMessage: "PERSON_NOT_FOUND"`.
* `slow`: Trì hoãn phản hồi 30 giây trước khi trả về thành công (để test thanh tiến trình UI).
* `timeout`: Giữ kết nối vĩnh viễn (dùng Promise không resolve) để kiểm tra cơ chế `AbortSignal.timeout(120000)` của worker.

## AC3. Cơ chế kích hoạt Kịch bản (Thứ tự ưu tiên)
1. **Header:** `x-mock-scenario: <scenario>` (Ưu tiên cao nhất)
2. **Query Parameter:** `?mock_scenario=<scenario>`
3. **Body Field:** `mock_scenario=<scenario>`
4. **Global Override:** Được thiết lập qua API quản trị `/mock/scenario`.
5. **Mặc định:** `DEFAULT_SCENARIO=success`.

## AC4. Cơ chế Ép Kịch bản Toàn cục (Global Scenario Override)
* Gọi `POST /mock/scenario` với body: `{ "scenario": "-503", "ttl_seconds": 60 }`.
* Tự động ép tất cả request gửi đến trong 60 giây tiếp theo trả về `-503` (mô phỏng sự cố sập Cloud HANET).
* Sau khi hết TTL, tự động phục hồi về kịch bản bình thường.

## AC5. Kịch bản Kiểm thử Tự động bằng cURL (`tests/curl/verify.sh`)
* Tệp `tests/curl/verify.sh` phải chạy thành công 100% không có lỗi (`exit code 0`).

## AC6. Ghi log chuẩn JSON
* Mọi request phải ghi log ra stdout định dạng JSON gồm: `ts`, `endpoint`, `scenario`, `aliasID`/`personID`, và `latency_ms`.
