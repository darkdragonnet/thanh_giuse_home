# CONSTRAINTS — KHÔNG ĐƯỢC VI PHẠM

### C1. Không gọi HANET thật
Mock tuyệt đối KHÔNG gọi ra partner.hanet.ai.
Mọi response sinh tại chỗ.
**Kiểm tra:** grep -r "hanet.ai" src/ phải không có kết quả (trừ comment).

### C2. Response khớp schema HANET 100%
Cấu trúc JSON khớp từng field: { returnCode, returnMessage, data }
KHÔNG thêm field lạ, KHÔNG đổi tên field.
**Kiểm tra:** so sánh JSON output với docs/hanet-endpoints.md.

### C3. Luôn trả HTTP 200
HANET trả HTTP 200 ngay cả khi returnCode = -503.
KHÔNG trả HTTP 4xx/5xx cho business logic.
**Kiểm tra:** curl -I mọi endpoint phải thấy HTTP/1.1 200.

### C4. Parse đúng cả 2 Content-Type
- application/x-www-form-urlencoded
- multipart/form-data
**Kiểm tra:** test cả 2 loại request trong verify.sh.

### C5. Scenario điều khiển được runtime
Ưu tiên: header > query > body > global override > default.
Header: x-mock-scenario
Query: mock_scenario
**Kiểm tra:** unit test resolver với 5 case.

### C6. State phải reset được
DELETE /mock/reset xóa sạch: persons, override, counters.
**Kiểm tra:** gọi reset rồi GET /mock/state phải thấy tất cả = 0.
