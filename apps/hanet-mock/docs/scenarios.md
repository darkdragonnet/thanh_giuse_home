# HƯỚNG DẪN KỊCH BẢN (SCENARIOS) & CƠ CHẾ KÍCH HOẠT

### Scenario: `success`
**Mục đích:** Test luồng đăng ký thành công chuẩn mực
**Cách kích hoạt:**
- Header: x-mock-scenario: success
- Query: ?mock_scenario=success
- Body: mock_scenario=success
- Global: POST /mock/scenario {"scenario":"success"}

**Response:**
```json
{
  "statusCode": 0,
  "returnCode": 1,
  "returnMessage": "SUCCESS",
  "data": {
    "file": "https://static.hanet.ai/face/employee/mock/avatar.jpg",
    "aliasID": "HS001",
    "name": "Nguyen Van A",
    "personID": "mock_HS001_1728470000000"
  }
}
```

---

### Scenario: `-503`
**Mục đích:** Test circuit breaker và BullMQ backoff khi HANET sập
**Cách kích hoạt:**
- Header: x-mock-scenario: -503
- Query: ?mock_scenario=-503
- Body: mock_scenario=-503
- Global: POST /mock/scenario {"scenario":"-503"}

**Response:**
```json
{
  "returnCode": -503,
  "returnMessage": "SYSTEM_ERROR"
}
```

---

### Scenario: `-103`
**Mục đích:** Test tự động refresh access token trước khi retry
**Cách kích hoạt:**
- Header: x-mock-scenario: -103
- Query: ?mock_scenario=-103
- Body: mock_scenario=-103
- Global: POST /mock/scenario {"scenario":"-103"}

**Response:**
```json
{
  "returnCode": -103,
  "returnMessage": "ACCESS_TOKEN_EXPIRE"
}
```

---

### Scenario: `-9006`
**Mục đích:** Test chuyển sang manual_review khi ảnh mờ hoặc không có mặt
**Cách kích hoạt:**
- Header: x-mock-scenario: -9006
- Query: ?mock_scenario=-9006
- Body: mock_scenario=-9006
- Global: POST /mock/scenario {"scenario":"-9006"}

**Response:**
```json
{
  "returnCode": -9006,
  "returnMessage": "EMPLOYEE_REGISTER_IMG_INVALID_ERROR"
}
```

---

### Scenario: `-9007`
**Mục đích:** Test phát hiện trùng lặp khuôn mặt đã đăng ký
**Cách kích hoạt:**
- Header: x-mock-scenario: -9007
- Query: ?mock_scenario=-9007
- Body: mock_scenario=-9007
- Global: POST /mock/scenario {"scenario":"-9007"}

**Response:**
```json
{
  "returnCode": -9007,
  "returnMessage": "EMPLOYEE_REGISTER_IMG_DUPLICATE_ERROR"
}
```

---

### Scenario: `-9008`
**Mục đích:** Test gửi cảnh báo khẩn cấp tới Admin khi hết quota khuôn mặt
**Cách kích hoạt:**
- Header: x-mock-scenario: -9008
- Query: ?mock_scenario=-9008
- Body: mock_scenario=-9008
- Global: POST /mock/scenario {"scenario":"-9008"}

**Response:**
```json
{
  "returnCode": -9008,
  "returnMessage": "FACE_ID_NOT_ENOUGH_ERROR"
}
```

---

### Scenario: `-5011`
**Mục đích:** Test cập nhật học sinh không tìm thấy ID
**Cách kích hoạt:**
- Header: x-mock-scenario: -5011
- Query: ?mock_scenario=-5011
- Body: mock_scenario=-5011
- Global: POST /mock/scenario {"scenario":"-5011"}

**Response:**
```json
{
  "returnCode": -5011,
  "returnMessage": "PERSON_NOT_FOUND"
}
```

---

### Scenario: `slow`
**Mục đích:** Test hành vi giao diện người dùng khi xử lý chậm 30s
**Cách kích hoạt:**
- Header: x-mock-scenario: slow
- Query: ?mock_scenario=slow
- Body: mock_scenario=slow
- Global: POST /mock/scenario {"scenario":"slow"}

**Response:** Trì hoãn 30 giây rồi trả về `returnCode: 1`.
**Hành vi đặc biệt:** `await delay(30_000)` trước khi gửi response.

---

### Scenario: `timeout`
**Mục đích:** Test ngắt kết nối AbortSignal 120s của worker
**Cách kích hoạt:**
- Header: x-mock-scenario: timeout
- Query: ?mock_scenario=timeout
- Body: mock_scenario=timeout
- Global: POST /mock/scenario {"scenario":"timeout"}

**Response:** Không bao giờ trả về phản hồi.
**Hành vi đặc biệt:** `new Promise(() => {})` giữ socket mở vĩnh viễn.
