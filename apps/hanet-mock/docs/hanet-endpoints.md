# ĐẶC TẢ CHI TIẾT 11 ENDPOINT CỦA HANET CLOUD OPEN API

Tài liệu này mô tả chi tiết định dạng tham số đầu vào và payload phản hồi chuẩn của HANET Cloud:

---

## 1. POST `/person/registerByUrl`
* **Mục đích:** Đăng ký thành viên mới bằng đường dẫn ảnh trực tuyến.
* **Content-Type:** `application/x-www-form-urlencoded`
* **Tham số Body:**
  * `token` (string, bắt buộc): Access token của ứng dụng.
  * `name` (string, bắt buộc): Họ và tên người cần đăng ký.
  * `aliasID` (string, bắt buộc): Mã định danh duy nhất của học sinh (phía trường học).
  * `placeID` (string, bắt buộc): ID địa điểm quản lý trên HANET Cloud.
  * `file_url` (string, bắt buộc): Đường dẫn URL ảnh chân dung (Nginx serve).
  * `title` (string, tùy chọn): Chức danh (VD: "Học sinh").
  * `type` (number, tùy chọn): Loại thành viên (0: Nhân viên, 1: Khách).
* **Response Mẫu (Success):**
```json
{
  "statusCode": 0,
  "returnCode": 1,
  "returnMessage": "SUCCESS",
  "data": {
    "file": "https://static.hanet.ai/face/employee/mock/avatar_abc123.jpg",
    "aliasID": "HS001",
    "name": "Nguyễn Hoàng Long",
    "personID": "mock_HS001_1728470000000",
    "title": "Học sinh",
    "type": 0
  }
}
```

---

## 2. POST `/person/updateByFaceImage`
* **Mục đích:** Cập nhật ảnh khuôn mặt bằng file ảnh nhị phân (Upload trực tiếp).
* **Content-Type:** `multipart/form-data`
* **Tham số Fields:**
  * `token` (text): Access token.
  * `aliasID` (text): Mã học sinh.
  * `placeID` (text): ID địa điểm.
  * `file` (binary): Dữ liệu file ảnh (JPEG/PNG).
* **Response Mẫu:**
```json
{
  "statusCode": 0,
  "returnCode": 1,
  "returnMessage": "SUCCESS",
  "data": {
    "aliasID": "HS001",
    "file": "https://static.hanet.ai/face/employee/mock/updated_face.jpg"
  }
}
```

---

## 3. POST `/person/updateByFaceImageByPersonID`
* **Content-Type:** `multipart/form-data`
* **Tham số Fields:** `token`, `personID`, `file`
* **Response Mẫu:** Giống endpoint 2 nhưng định danh theo `personID`.

---

## 4. POST `/person/updateByFaceUrl`
* **Content-Type:** `application/x-www-form-urlencoded`
* **Tham số:** `token`, `aliasID`, `placeID`, `file_url`

---

## 5. POST `/person/updateByFaceUrlByAliasID`
* **Content-Type:** `application/x-www-form-urlencoded`
* **Tham số:** `token`, `aliasID`, `placeID`, `file_url`

---

## 6. POST `/person/updateByFaceUrlByPersonID`
* **Content-Type:** `application/x-www-form-urlencoded`
* **Tham số:** `token`, `personID`, `file_url`

---

## 7. POST `/person/getListByPlace`
* **Mục đích:** Lấy toàn bộ danh sách thành viên tại 1 địa điểm.
* **Content-Type:** `application/x-www-form-urlencoded`
* **Tham số:** `token`, `placeID`, `type`?
* **Response Mẫu:**
```json
{
  "statusCode": 0,
  "returnCode": 1,
  "returnMessage": "SUCCESS",
  "data": [
    {
      "personID": "mock_HS001_1728470000000",
      "aliasID": "HS001",
      "name": "Nguyễn Hoàng Long",
      "avatar": "https://static.hanet.ai/..."
    }
  ]
}
```

---

## 8. POST `/person/removePersonByID`
* **Mục đích:** Xóa học sinh khỏi địa điểm trên HANET.
* **Content-Type:** `application/x-www-form-urlencoded`
* **Tham số:** `token`, `personID`
* **Response Mẫu:**
```json
{
  "statusCode": 0,
  "returnCode": 1,
  "returnMessage": "SUCCESS",
  "data": { "personID": "mock_HS001_1728470000000" }
}
```

---

## 9. POST `/person/getCheckinByPlaceIdInDay` & `/person/getCheckinByPlaceIdInTimestamp`
* **Mục đích:** Lấy lịch sử điểm danh / nhận diện khuôn mặt.
* **Response Mẫu:**
```json
{
  "statusCode": 0,
  "returnCode": 1,
  "returnMessage": "SUCCESS",
  "data": []
}
```

---

## 11. POST `/device/getConnectionStatus`
* **Mục đích:** Kiểm tra camera tại trường học có đang kết nối mạng không.
* **Tham số:** `token`, `deviceID`
* **Response Mẫu:**
```json
{
  "statusCode": 0,
  "returnCode": 1,
  "returnMessage": "SUCCESS",
  "data": { "deviceID": "C20371B302", "status": 1 }
}
```
