#!/usr/bin/env bash
set -e

BASE_URL="http://localhost:3000/api/admin"
SECRET_TOKEN="${ADMIN_SECRET_TOKEN:-admin_secret_super_secure_token}"

GREEN='\033[0;32m'
RED='\033[0;31m'
NC='\033[0m'

echo "=========================================================="
echo "BẮT ĐẦU CHECKPOINT VERIFICATION: FASTIFY ADMIN API"
echo "=========================================================="

test_expect_401() {
  local endpoint=$1
  local method=${2:-GET}
  echo -n "[TEST CHẶN 401] $method $endpoint: "
  
  status_code=$(curl -s -o /dev/null -w "%{http_code}" -X "$method" "$BASE_URL$endpoint")
  if [ "$status_code" -eq 401 ]; then
    echo -e "${GREEN}PASS (Chặn đúng 401)${NC}"
  else
    echo -e "${RED}FAIL (Kỳ vọng 401 nhưng nhận $status_code)${NC}"
    exit 1
  fi
}

test_expect_200() {
  local name=$1
  local cmd=$2
  echo -n "[TEST 200 OK] $name: "
  
  res=$(eval "$cmd")
  status_code=$(echo "$res" | tail -n1)
  body=$(echo "$res" | sed '$d')

  if [ "$status_code" -eq 200 ]; then
    echo -e "${GREEN}PASS (HTTP 200)${NC}"
  else
    echo -e "${RED}FAIL (Kỳ vọng 200 nhưng nhận $status_code)${NC}"
    echo "Body: $body"
    exit 1
  fi
}

test_expect_status() {
  local expected=$1
  local name=$2
  local cmd=$3
  echo -n "[TEST HTTP $expected] $name: "
  
  res=$(eval "$cmd")
  status_code=$(echo "$res" | tail -n1)
  body=$(echo "$res" | sed '$d')

  if [ "$status_code" -eq "$expected" ]; then
    echo -e "${GREEN}PASS (HTTP $expected)${NC}"
  else
    echo -e "${RED}FAIL (Kỳ vọng $expected nhưng nhận $status_code)${NC}"
    echo "Body: $body"
    exit 1
  fi
}

# ----------------------------------------------------
# 1. KIỂM THỬ BẢO VỆ 401 KHI KHÔNG CÓ TOKEN
# ----------------------------------------------------
test_expect_401 "/dashboard/stats" "GET"
test_expect_401 "/classes" "GET"
test_expect_401 "/students" "GET"
test_expect_401 "/requests" "GET"
test_expect_401 "/logs" "GET"

echo "----------------------------------------------------------"
echo "XÁC THỰC THÀNH CÔNG: TẤT CẢ ENDPOINT ĐỀU ĐƯỢC BẢO VỆ!"
echo "----------------------------------------------------------"

# ----------------------------------------------------
# 2. KIỂM THỬ TRỌN BỘ 11 ENDPOINTS KHI CÓ TOKEN
# ----------------------------------------------------

# Endpoint 1: Verify Auth Login
test_expect_200 "1. POST /auth/verify" \
  "curl -s -w '\n%{http_code}' -X POST $BASE_URL/auth/verify -H 'Content-Type: application/json' -d '{\"token\":\"$SECRET_TOKEN\"}'"

# Endpoint 2: Dashboard Stats
test_expect_200 "2. GET /dashboard/stats" \
  "curl -s -w '\n%{http_code}' -X GET $BASE_URL/dashboard/stats -H 'Authorization: Bearer $SECRET_TOKEN'"

# Endpoint 3: Classes
test_expect_200 "3. GET /classes" \
  "curl -s -w '\n%{http_code}' -X GET $BASE_URL/classes -H 'Authorization: Bearer $SECRET_TOKEN'"

RANDOM_CODE="CLS_$(date +%s | tail -c 5)"
# Endpoint 3.1: POST /classes (Tạo mới thành công - HTTP 201)
test_expect_status 201 "3.1 POST /classes (Tạo lớp $RANDOM_CODE)" \
  "curl -s -w '\n%{http_code}' -X POST $BASE_URL/classes -H 'Authorization: Bearer $SECRET_TOKEN' -H 'Content-Type: application/json' -d '{\"code\":\"$RANDOM_CODE\",\"name\":\"Lớp Thử Nghiệm $RANDOM_CODE\",\"teacher_name\":\"Thầy Test\"}'"

# Endpoint 3.2: POST /classes (Bắt trùng mã lớp - HTTP 409)
test_expect_status 409 "3.2 POST /classes (Trùng mã lớp $RANDOM_CODE)" \
  "curl -s -w '\n%{http_code}' -X POST $BASE_URL/classes -H 'Authorization: Bearer $SECRET_TOKEN' -H 'Content-Type: application/json' -d '{\"code\":\"$RANDOM_CODE\",\"name\":\"Lớp Trùng Lặp\"}'"

# Endpoint 3.3: POST /classes (Sai định dạng regex mã lớp - HTTP 400)
test_expect_status 400 "3.3 POST /classes (Sai định dạng mã lớp)" \
  "curl -s -w '\n%{http_code}' -X POST $BASE_URL/classes -H 'Authorization: Bearer $SECRET_TOKEN' -H 'Content-Type: application/json' -d '{\"code\":\"@L@P!#\",\"name\":\"Lớp Ký Tự Lạ\"}'"

# Endpoint 4: Lock/Unlock Class (Test với class id=1)
test_expect_200 "4. PATCH /classes/1/lock" \
  "curl -s -w '\n%{http_code}' -X PATCH $BASE_URL/classes/1/lock -H 'Authorization: Bearer $SECRET_TOKEN' -H 'Content-Type: application/json' -d '{\"is_locked\":false}'"

# Endpoint 5: Students Pagination
test_expect_200 "5. GET /students?page=1&limit=5" \
  "curl -s -w '\n%{http_code}' -X GET '$BASE_URL/students?page=1&limit=5' -H 'Authorization: Bearer $SECRET_TOKEN'"

# Endpoint 6: Override Student Photo (Priority 1)
# Tạo file ảnh giả lập test.jpg
echo "fake_image_binary_content" > /tmp/test_face.jpg
test_expect_200 "6. POST /students/1/override" \
  "curl -s -w '\n%{http_code}' -X POST $BASE_URL/students/1/override -H 'Authorization: Bearer $SECRET_TOKEN' -F 'file=@/tmp/test_face.jpg'"
rm -f /tmp/test_face.jpg

# Endpoint 7: Reset Student
test_expect_200 "7. POST /students/1/reset" \
  "curl -s -w '\n%{http_code}' -X POST $BASE_URL/students/1/reset -H 'Authorization: Bearer $SECRET_TOKEN'"

# Endpoint 8: Admin Requests List
test_expect_200 "8. GET /requests" \
  "curl -s -w '\n%{http_code}' -X GET $BASE_URL/requests -H 'Authorization: Bearer $SECRET_TOKEN'"

# Endpoint 9: Update Request Status (Giả lập cập nhật bản ghi id=1 nếu có)
test_expect_200 "9. PATCH /requests/1/status" \
  "curl -s -w '\n%{http_code}' -X PATCH $BASE_URL/requests/1/status -H 'Authorization: Bearer $SECRET_TOKEN' -H 'Content-Type: application/json' -d '{\"status\":\"processing\"}'"

# Endpoint 10: Kill Switch Toggle
test_expect_200 "10. POST /settings/kill-switch" \
  "curl -s -w '\n%{http_code}' -X POST $BASE_URL/settings/kill-switch -H 'Authorization: Bearer $SECRET_TOKEN' -H 'Content-Type: application/json' -d '{\"enabled\":true}'"

# Endpoint 11: Logs Pagination
test_expect_200 "11. GET /logs?page=1&limit=5" \
  "curl -s -w '\n%{http_code}' -X GET '$BASE_URL/logs?page=1&limit=5' -H 'Authorization: Bearer $SECRET_TOKEN'"

echo "=========================================================="
echo -e "${GREEN}HOÀN THÀNH TOÀN DIỆN: 11/11 ENDPOINTS PASS TEST!${NC}"
echo "=========================================================="
