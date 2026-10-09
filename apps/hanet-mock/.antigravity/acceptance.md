# ACCEPTANCE CRITERIA — NGHIỆM THU

## AC1. Endpoints bắt buộc (11 endpoints)
Liệt kê rõ 11 endpoint với method + path:
1. POST /person/registerByUrl
2. POST /person/updateByFaceImage
3. POST /person/updateByFaceImageByPersonID
4. POST /person/updateByFaceUrl
5. POST /person/updateByFaceUrlByAliasID
6. POST /person/updateByFaceUrlByPersonID
7. POST /person/getListByPlace
8. POST /person/removePersonByID
9. POST /person/getCheckinByPlaceIdInDay
10. POST /person/getCheckinByPlaceIdInTimestamp
11. POST /device/getConnectionStatus

## AC2. Scenarios tối thiểu (9 scenarios)
success, -503, -103, -9006, -9007, -9008, -5011, slow, timeout

## AC3. Điều khiển scenario qua 3 cách
1. Header x-mock-scenario
2. Query ?mock_scenario=
3. Body field mock_scenario
+ Global override qua POST /mock/scenario

## AC4. Global scenario override có TTL
POST /mock/scenario { scenario, ttl_seconds }
Override tự hết hạn sau TTL.

## AC5. Verify bằng cURL script
File tests/curl/verify.sh pass 100%, exit code 0.

## AC6. Logging JSON ra stdout
Format: { ts, level, msg, endpoint, scenario, requestId, latency_ms }
