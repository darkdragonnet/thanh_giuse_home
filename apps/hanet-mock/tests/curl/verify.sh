#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${1:-http://localhost:4000}"
PASSED=0
FAILED=0

GREEN='\033[032m'
RED='\033[031m'
NC='\033[0m'

echo "========================================================"
echo "  BẮT ĐẦU CHẠY HANET MOCK AUTOMATED VERIFICATION SUITE"
echo "  Target: $BASE_URL"
echo "========================================================"

assert_json() {
  local test_name="$1"
  local expected_code="$2"
  local response="$3"

  local return_code
  return_code=$(echo "$response" | grep -o '"returnCode":[-0-9]*' | head -n1 | cut -d':' -f2 || echo "")

  if [ "$return_code" = "$expected_code" ]; then
    echo -e " [PASS] $test_name (returnCode: $return_code)"
    PASSED=$((PASSED + 1))
  else
    echo -e " [${RED}FAIL${NC}] $test_name"
    echo "        Expected returnCode: $expected_code, Got: '$return_code'"
    echo "        Raw response: $response"
    FAILED=$((FAILED + 1))
  fi
}

# 0. Reset State về baseline
curl -s -X DELETE "$BASE_URL/mock/reset" > /dev/null

echo ""
echo "--- 1. KIỂM THỬ 11 ENDPOINTS CHUẨN (HAPPY PATH) ---"

# 1. registerByUrl
RES=$(curl -s -X POST "$BASE_URL/person/registerByUrl" \
  -d "token=test_tok&name=Nguyen+Van+A&aliasID=HS_TEST_01&placeID=196")
assert_json "1. POST /person/registerByUrl" "1" "$RES"
PERSON_ID=$(echo "$RES" | grep -o '"personID":"[^"]*' | cut -d'"' -f4 || echo "mock_pid_1")

# 2. updateByFaceImage (Form-encoded)
RES=$(curl -s -X POST "$BASE_URL/person/updateByFaceImage" \
  -d "aliasID=HS_TEST_01&placeID=196")
assert_json "2. POST /person/updateByFaceImage" "1" "$RES"

# 3. updateByFaceImageByPersonID
RES=$(curl -s -X POST "$BASE_URL/person/updateByFaceImageByPersonID" \
  -d "personID=$PERSON_ID")
assert_json "3. POST /person/updateByFaceImageByPersonID" "1" "$RES"

# 4. updateByFaceUrl
RES=$(curl -s -X POST "$BASE_URL/person/updateByFaceUrl" \
  -d "aliasID=HS_TEST_01&file_url=https://example.com/face2.jpg")
assert_json "4. POST /person/updateByFaceUrl" "1" "$RES"

# 5. updateByFaceUrlByAliasID
RES=$(curl -s -X POST "$BASE_URL/person/updateByFaceUrlByAliasID" \
  -d "aliasID=HS_TEST_01&file_url=https://example.com/face3.jpg")
assert_json "5. POST /person/updateByFaceUrlByAliasID" "1" "$RES"

# 6. updateByFaceUrlByPersonID
RES=$(curl -s -X POST "$BASE_URL/person/updateByFaceUrlByPersonID" \
  -d "personID=$PERSON_ID&file_url=https://example.com/face4.jpg")
assert_json "6. POST /person/updateByFaceUrlByPersonID" "1" "$RES"

# 7. getListByPlace
RES=$(curl -s -X POST "$BASE_URL/person/getListByPlace" \
  -d "placeID=196")
assert_json "7. POST /person/getListByPlace" "1" "$RES"

# 8. getCheckinByPlaceIdInDay
RES=$(curl -s -X POST "$BASE_URL/person/getCheckinByPlaceIdInDay" \
  -d "placeID=196&date=2026-10-09")
assert_json "8. POST /person/getCheckinByPlaceIdInDay" "1" "$RES"

# 9. getCheckinByPlaceIdInTimestamp
RES=$(curl -s -X POST "$BASE_URL/person/getCheckinByPlaceIdInTimestamp" \
  -d "placeID=196&from=1791500000000&to=1791600000000")
assert_json "9. POST /person/getCheckinByPlaceIdInTimestamp" "1" "$RES"

# 10. getConnectionStatus & deprecated alias
RES=$(curl -s -X POST "$BASE_URL/device/getConnectionStatus" \
  -d "deviceID=C20371B302")
assert_json "10. POST /device/getConnectionStatus" "1" "$RES"

RES_ALIAS=$(curl -s -X POST "$BASE_URL/device/get-connection-status" \
  -d "deviceID=C20371B302")
assert_json "10b. POST /device/get-connection-status (Alias)" "1" "$RES_ALIAS"

# 11. removePersonByID
RES=$(curl -s -X POST "$BASE_URL/person/removePersonByID" \
  -d "personID=$PERSON_ID")
assert_json "11. POST /person/removePersonByID" "1" "$RES"

echo ""
echo "--- 2. KIỂM THỬ 9 KỊCH BẢN GIẢ LẬP LỖI (SCENARIO RESOLVER) ---"

# Scenario -503 (Header)
RES=$(curl -s -X POST "$BASE_URL/person/registerByUrl" \
  -H "x-mock-scenario: -503" \
  -d "aliasID=HS_ERR_503&name=Err503&placeID=196")
assert_json "Scenario Header -503 (System Overload)" "-503" "$RES"

# Scenario -103 (Query Param)
RES=$(curl -s -X POST "$BASE_URL/person/registerByUrl?mock_scenario=-103" \
  -d "aliasID=HS_ERR_103&name=Err103&placeID=196")
assert_json "Scenario Query -103 (Token Expired)" "-103" "$RES"

# Scenario -9006 (Body Form-encoded)
RES=$(curl -s -X POST "$BASE_URL/person/registerByUrl" \
  -d "mock_scenario=-9006&aliasID=HS_ERR_9006&name=Err9006&placeID=196")
assert_json "Scenario Body -9006 (Invalid Facial Landmarks)" "-9006" "$RES"

# Scenario -9007 (Duplicate Face)
RES=$(curl -s -X POST "$BASE_URL/person/registerByUrl" \
  -H "x-mock-scenario: -9007" \
  -d "aliasID=HS_ERR_9007&name=Err9007&placeID=196")
assert_json "Scenario -9007 (Duplicate Face)" "-9007" "$RES"

# Scenario -9008 (Quota Exceeded)
RES=$(curl -s -X POST "$BASE_URL/person/registerByUrl" \
  -H "x-mock-scenario: -9008" \
  -d "aliasID=HS_ERR_9008&name=Err9008&placeID=196")
assert_json "Scenario -9008 (Face ID Quota Exceeded)" "-9008" "$RES"

# Scenario -5011 (Person Not Found)
RES=$(curl -s -X POST "$BASE_URL/person/updateByFaceImageByPersonID" \
  -d "personID=NON_EXISTENT_ID")
assert_json "Scenario -5011 (Person Not Found)" "-5011" "$RES"

# Scenario -1 (Thiếu trường bắt buộc)
RES=$(curl -s -X POST "$BASE_URL/person/registerByUrl" \
  -d "aliasID=&name=&placeID=")
assert_json "Scenario -1 (Invalid Input Missing Fields)" "-1" "$RES"

# Scenario Global Override với Hits Counter
curl -s -X POST "$BASE_URL/mock/scenario" \
  -H "Content-Type: application/json" \
  -d '{"scenario": "-503", "hits": 1}' > /dev/null

RES=$(curl -s -X POST "$BASE_URL/person/getListByPlace" -d "placeID=196")
assert_json "Scenario Global Override Hit 1 (-503)" "-503" "$RES"

RES_AFTER=$(curl -s -X POST "$BASE_URL/person/getListByPlace" -d "placeID=196")
assert_json "Scenario Fallback Default Sau Khi Hết Hits (Return 1)" "1" "$RES_AFTER"

echo ""
echo "--- 3. KIỂM THỬ HIỆU SUẤT ĐỘ TRỄ MẠNG (SLOW SIMULATION) ---"
START_TIME=$(date +%s)
RES=$(curl -s -X POST "$BASE_URL/device/getConnectionStatus" \
  -H "x-mock-scenario: slow" \
  -d "deviceID=C20371B302")
END_TIME=$(date +%s)
DIFF=$((END_TIME - START_TIME))

if [ "$DIFF" -ge 4 ]; then
  echo -e " [PASS] Scenario 'slow' delay mô phỏng đúng (Độ trễ thực tế: ${DIFF}s >= 4s)"
  PASSED=$((PASSED + 1))
else
  echo -e " [${RED}FAIL${NC}] Scenario 'slow' không tạo đủ độ trễ (Độ trễ: ${DIFF}s)"
  FAILED=$((FAILED + 1))
fi

# Reset dọn dẹp môi trường sau khi test
curl -s -X DELETE "$BASE_URL/mock/reset" > /dev/null

echo ""
echo "========================================================"
echo "                   KẾT QUẢ KIỂM THỬ"
echo "  Passed: $PASSED"
echo "  Failed: $FAILED"
echo "========================================================"

if [ "$FAILED" -eq 0 ]; then
  echo -e "${GREEN}>>> TẤT CẢ KIỂM THỬ ĐÃ THÀNH CÔNG ĐẠT 100%! <<<${NC}"
  exit 0
else
  echo -e "${RED}>>> CÓ TEST CASE THẤT BẠI! CẦN KIỂM TRA LẠI! <<<${NC}"
  exit 1
fi
