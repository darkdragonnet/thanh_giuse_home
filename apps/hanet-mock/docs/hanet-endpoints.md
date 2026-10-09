# ĐẶC TẢ CHI TIẾT 11 ENDPOINT CỦA HANET CLOUD OPEN API

### POST /person/registerByUrl
**Content-Type:** application/x-www-form-urlencoded
**Auth:** token (form field)
**Params:**
| Name | Type | Required | Description |
|---|---|---|---|
| token | string | yes | Access token |
| name | string | yes | Họ tên học sinh |
| aliasID | string | yes | Mã học sinh duy nhất |
| placeID | string | yes | ID địa điểm |
| file_url | string | yes | URL ảnh chân dung |
| title | string | no | Chức danh |
| type | number | no | Loại đối tượng (0: member) |

**Request Example:**
```bash
curl -X POST http://localhost:4000/person/registerByUrl \
  -H "Content-Type: application/x-www-form-urlencoded" \
  --data "token=mock_token&name=Nguyen+Van+A&aliasID=HS001&placeID=196&file_url=https://example.com/a.jpg"
```

**Response Success (HTTP 200):**
```json
{
  "statusCode": 0,
  "returnCode": 1,
  "returnMessage": "SUCCESS",
  "data": {
    "file": "https://static.hanet.ai/face/employee/mock/avatar_hs001.jpg",
    "aliasID": "HS001",
    "name": "Nguyen Van A",
    "personID": "mock_HS001_1728470000000",
    "title": "Hoc sinh"
  }
}
```

**Response Error:**
- `-1`: INVALID_INPUT_ERROR
- `-103`: ACCESS_TOKEN_EXPIRE
- `-503`: SYSTEM_ERROR
- `-9006`: EMPLOYEE_REGISTER_IMG_INVALID_ERROR
- `-9007`: EMPLOYEE_REGISTER_IMG_DUPLICATE_ERROR
- `-9008`: FACE_ID_NOT_ENOUGH_ERROR

---

### POST /person/updateByFaceImage
**Content-Type:** multipart/form-data
**Auth:** token (form field)
**Params:**
| Name | Type | Required | Description |
|---|---|---|---|
| token | string | yes | Access token |
| aliasID | string | yes | Mã học sinh |
| placeID | string | yes | ID địa điểm |
| file | binary | yes | Dữ liệu file ảnh (≤ 5MB) |

**Request Example:**
```bash
curl -X POST http://localhost:4000/person/updateByFaceImage \
  -F "token=mock_token" -F "aliasID=HS001" -F "placeID=196" -F "file=@/tmp/face.jpg"
```

**Response Success (HTTP 200):**
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

**Response Error:**
- `-9002`: FILE_EXTENTION_ERROR
- `-9006`: EMPLOYEE_REGISTER_IMG_INVALID_ERROR
- `-5011`: PERSON_NOT_FOUND

---

### POST /person/updateByFaceImageByPersonID
**Content-Type:** multipart/form-data
**Auth:** token (form field)
**Params:**
| Name | Type | Required | Description |
|---|---|---|---|
| token | string | yes | Access token |
| personID | string | yes | ID do HANET cấp |
| file | binary | yes | Dữ liệu file ảnh (≤ 5MB) |

**Response Success (HTTP 200):**
```json
{
  "statusCode": 0,
  "returnCode": 1,
  "returnMessage": "SUCCESS",
  "data": {
    "personID": "mock_HS001_1728470000000",
    "file": "https://static.hanet.ai/face/employee/mock/updated_face.jpg"
  }
}
```

**Response Error:**
- `-9006`: EMPLOYEE_REGISTER_IMG_INVALID_ERROR
- `-5011`: PERSON_NOT_FOUND

---

### POST /person/updateByFaceUrl
**Content-Type:** application/x-www-form-urlencoded
**Auth:** token (form field)
**Params:**
| Name | Type | Required | Description |
|---|---|---|---|
| token | string | yes | Access token |
| aliasID | string | yes | Mã học sinh |
| placeID | string | yes | ID địa điểm |
| file_url | string | yes | URL ảnh mới |

**Response Success (HTTP 200):**
```json
{
  "statusCode": 0,
  "returnCode": 1,
  "returnMessage": "SUCCESS",
  "data": { "aliasID": "HS001", "file": "https://static.hanet.ai/face/employee/mock/url_face.jpg" }
}
```

**Response Error:**
- `-503`: SYSTEM_ERROR
- `-5011`: PERSON_NOT_FOUND

---

### POST /person/updateByFaceUrlByAliasID
**Content-Type:** application/x-www-form-urlencoded
**Auth:** token (form field)
**Params:**
| Name | Type | Required | Description |
|---|---|---|---|
| token | string | yes | Access token |
| aliasID | string | yes | Mã học sinh |
| placeID | string | yes | ID địa điểm |
| file_url | string | yes | URL ảnh mới |

**Response Success (HTTP 200):**
```json
{
  "statusCode": 0,
  "returnCode": 1,
  "returnMessage": "SUCCESS",
  "data": { "aliasID": "HS001", "file": "https://static.hanet.ai/face/employee/mock/url_face.jpg" }
}
```

**Response Error:**
- `-5011`: PERSON_NOT_FOUND

---

### POST /person/updateByFaceUrlByPersonID
**Content-Type:** application/x-www-form-urlencoded
**Auth:** token (form field)
**Params:**
| Name | Type | Required | Description |
|---|---|---|---|
| token | string | yes | Access token |
| personID | string | yes | ID HANET cấp |
| file_url | string | yes | URL ảnh mới |

**Response Success (HTTP 200):**
```json
{
  "statusCode": 0,
  "returnCode": 1,
  "returnMessage": "SUCCESS",
  "data": { "personID": "mock_HS001_1728470000000", "file": "https://static.hanet.ai/face/employee/mock/url_face.jpg" }
}
```

**Response Error:**
- `-5011`: PERSON_NOT_FOUND

---

### POST /person/getListByPlace
**Content-Type:** application/x-www-form-urlencoded
**Auth:** token (form field)
**Params:**
| Name | Type | Required | Description |
|---|---|---|---|
| token | string | yes | Access token |
| placeID | string | yes | ID địa điểm |

**Response Success (HTTP 200):**
```json
{
  "statusCode": 0,
  "returnCode": 1,
  "returnMessage": "SUCCESS",
  "data": [
    {
      "personID": "mock_HS001_1728470000000",
      "aliasID": "HS001",
      "name": "Nguyen Van A",
      "avatar": "https://static.hanet.ai/face/employee/mock/avatar.jpg"
    }
  ]
}
```

**Response Error:**
- `-1`: INVALID_INPUT_ERROR

---

### POST /person/removePersonByID
**Content-Type:** application/x-www-form-urlencoded
**Auth:** token (form field)
**Params:**
| Name | Type | Required | Description |
|---|---|---|---|
| token | string | yes | Access token |
| personID | string | yes | ID HANET cấp |

**Response Success (HTTP 200):**
```json
{
  "statusCode": 0,
  "returnCode": 1,
  "returnMessage": "SUCCESS",
  "data": { "personID": "mock_HS001_1728470000000" }
}
```

**Response Error:**
- `-5011`: PERSON_NOT_FOUND

---

### POST /person/getCheckinByPlaceIdInDay
**Content-Type:** application/x-www-form-urlencoded
**Auth:** token (form field)
**Params:**
| Name | Type | Required | Description |
|---|---|---|---|
| token | string | yes | Access token |
| placeID | string | yes | ID địa điểm |
| date | string | yes | Ngày dạng YYYY-MM-DD |

**Response Success (HTTP 200):**
```json
{
  "statusCode": 0,
  "returnCode": 1,
  "returnMessage": "SUCCESS",
  "data": []
}
```

**Response Error:**
- `-1`: INVALID_INPUT_ERROR

---

### POST /person/getCheckinByPlaceIdInTimestamp
**Content-Type:** application/x-www-form-urlencoded
**Auth:** token (form field)
**Params:**
| Name | Type | Required | Description |
|---|---|---|---|
| token | string | yes | Access token |
| placeID | string | yes | ID địa điểm |
| from | number | yes | Timestamp bắt đầu |
| to | number | yes | Timestamp kết thúc |

**Response Success (HTTP 200):**
```json
{
  "statusCode": 0,
  "returnCode": 1,
  "returnMessage": "SUCCESS",
  "data": []
}
```

**Response Error:**
- `-1`: INVALID_INPUT_ERROR

---

### POST /device/getConnectionStatus
**Content-Type:** application/x-www-form-urlencoded
**Auth:** token (form field)
**Params:**
| Name | Type | Required | Description |
|---|---|---|---|
| token | string | yes | Access token |
| deviceID | string | yes | Mã thiết bị camera |

**Response Success (HTTP 200):**
```json
{
  "statusCode": 0,
  "returnCode": 1,
  "returnMessage": "SUCCESS",
  "data": { "deviceID": "C20371B302", "status": 1 }
}
```

**Response Error:**
- `-1`: INVALID_INPUT_ERROR
