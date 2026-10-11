#!/usr/bin/env bash
set -e

BASE_URL="http://localhost:3000/api/admin"
SECRET_TOKEN="${ADMIN_SECRET_TOKEN:-admin_secret_super_secure_token}"

GREEN='\033[0;32m'
RED='\033[0;31m'
NC='\033[0m'

echo "=========================================================="
echo "BẮT ĐẦU KIỂM THỬ: STUDENT MANAGEMENT & ALIAS_ID REST API"
echo "=========================================================="

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

# 1. Lấy lớp học đầu tiên để test CRUD cơ bản
CLASS_RES=$(curl -s -X GET "$BASE_URL/classes" -H "Authorization: Bearer $SECRET_TOKEN")
CLASS_ID=$(echo "$CLASS_RES" | grep -o '"id":[0-9]*' | head -n1 | cut -d: -f2)

if [ -z "$CLASS_ID" ]; then
  echo "Không tìm thấy lớp học nào để test, tiến hành tạo 1 lớp mẫu..."
  RANDOM_CODE="T$(date +%s | tail -c 4)"
  CREATE_RES=$(curl -s -X POST "$BASE_URL/classes" \
    -H "Authorization: Bearer $SECRET_TOKEN" \
    -H "Content-Type: application/json" \
    -d "{\"code\":\"$RANDOM_CODE\",\"name\":\"Lớp Test $RANDOM_CODE\"}")
  CLASS_ID=$(echo "$CREATE_RES" | grep -o '"id":[0-9]*' | head -n1 | cut -d: -f2)
fi

echo "Sử dụng Class ID: $CLASS_ID để kiểm thử CRUD cơ bản"

# 2. Thêm đơn lẻ 1 học sinh
test_expect_status 201 "1. POST /classes/$CLASS_ID/students (Thêm đơn lẻ 1 học sinh)" \
  "curl -s -w '\n%{http_code}' -X POST $BASE_URL/classes/$CLASS_ID/students \
    -H 'Authorization: Bearer $SECRET_TOKEN' \
    -H 'Content-Type: application/json' \
    -d '{\"name\":\"  01. Hoàng Văn Test  \"}'"

# 3. Thêm hàng loạt 3 học sinh (Tự động lọc prefix STT: 1., 02 -, 3/)
test_expect_status 201 "2. POST /classes/$CLASS_ID/students (Bulk paste 3 học sinh)" \
  "curl -s -w '\n%{http_code}' -X POST $BASE_URL/classes/$CLASS_ID/students \
    -H 'Authorization: Bearer $SECRET_TOKEN' \
    -H 'Content-Type: application/json' \
    -d '{\"names\":[\"1. Nguyễn Văn Một\", \"02 - Trần Thị Hai\", \"3/ Lê Đức Ba\", \"\"]}'"

# 4. Thử thêm học sinh không hợp lệ (< 2 ký tự) -> HTTP 400
test_expect_status 400 "3. POST /classes/$CLASS_ID/students (Tên không hợp lệ -> 400)" \
  "curl -s -w '\n%{http_code}' -X POST $BASE_URL/classes/$CLASS_ID/students \
    -H 'Authorization: Bearer $SECRET_TOKEN' \
    -H 'Content-Type: application/json' \
    -d '{\"name\":\"A\"}'"

# 5. Lấy danh sách học sinh của lớp
STUDENTS_RES=$(curl -s -X GET "$BASE_URL/classes/$CLASS_ID/students" -H "Authorization: Bearer $SECRET_TOKEN")
STUDENT_ID=$(echo "$STUDENTS_RES" | grep -o '"id":[0-9]*' | tail -n1 | cut -d: -f2)

test_expect_status 200 "4. GET /classes/$CLASS_ID/students (Lấy danh sách học sinh theo lớp)" \
  "curl -s -w '\n%{http_code}' -X GET $BASE_URL/classes/$CLASS_ID/students \
    -H 'Authorization: Bearer $SECRET_TOKEN'"

# 6. Sửa tên học sinh
test_expect_status 200 "5. PUT /students/$STUDENT_ID (Đổi tên học sinh)" \
  "curl -s -w '\n%{http_code}' -X PUT $BASE_URL/students/$STUDENT_ID \
    -H 'Authorization: Bearer $SECRET_TOKEN' \
    -H 'Content-Type: application/json' \
    -d '{\"name\":\"Lê Đức Ba (Đã Cập Nhật)\"}'"

# 7. Sửa tên không hợp lệ (< 2 ký tự) -> HTTP 400
test_expect_status 400 "6. PUT /students/$STUDENT_ID (Đổi tên ngắn -> 400)" \
  "curl -s -w '\n%{http_code}' -X PUT $BASE_URL/students/$STUDENT_ID \
    -H 'Authorization: Bearer $SECRET_TOKEN' \
    -H 'Content-Type: application/json' \
    -d '{\"name\":\" \"}'"

# 8. Xóa học sinh vừa tạo
test_expect_status 200 "7. DELETE /students/$STUDENT_ID (Xóa học sinh thành công)" \
  "curl -s -w '\n%{http_code}' -X DELETE $BASE_URL/students/$STUDENT_ID \
    -H 'Authorization: Bearer $SECRET_TOKEN'"

# 9. Xóa lại học sinh đã bị xóa -> HTTP 404
test_expect_status 404 "8. DELETE /students/$STUDENT_ID (Xóa học sinh không tồn tại -> 404)" \
  "curl -s -w '\n%{http_code}' -X DELETE $BASE_URL/students/$STUDENT_ID \
    -H 'Authorization: Bearer $SECRET_TOKEN'"

# ==============================================================================
# KIỂM TRA ĐỊNH DẠNG ALIAS_ID THEO TIÊU CHUẨN MỚI ([Mã_Lớp]_[Hex4] <= 9 ký tự)
# ==============================================================================
echo "----------------------------------------------------------"
echo "KIỂM TRA CHUẨN HÓA ALIAS_ID (KT1A VÀ GLV, KHÔNG TIỀN TỐ STU_)"
echo "----------------------------------------------------------"

# Tìm ID của lớp KT1A
KT1A_RES=$(curl -s -X GET "$BASE_URL/classes?search=KT1A" -H "Authorization: Bearer $SECRET_TOKEN")
KT1A_ID=$(echo "$KT1A_RES" | grep -o '"id":[0-9]*,"code":"KT1A"' | head -n1 | cut -d, -f1 | cut -d: -f2)

if [ -n "$KT1A_ID" ]; then
  echo -n "[TEST ALIAS_ID] Tạo học sinh vào lớp KT1A: "
  ADD_KT1A_RES=$(curl -s -X POST "$BASE_URL/classes/$KT1A_ID/students" \
    -H "Authorization: Bearer $SECRET_TOKEN" \
    -H "Content-Type: application/json" \
    -d '{"name":"Em Maria Khai Tâm 1A"}')
  
  KT1A_ALIAS=$(echo "$ADD_KT1A_RES" | grep -o '"alias_id":"[^"]*"' | head -n1 | cut -d'"' -f4)
  KT1A_STU_ID=$(echo "$ADD_KT1A_RES" | grep -o '"id":[0-9]*' | head -n1 | cut -d: -f2)

  if [[ "$KT1A_ALIAS" =~ ^KT1A_[A-F0-9]{4}$ ]]; then
    echo -e "${GREEN}PASS${NC} -> Alias ID: $KT1A_ALIAS (Độ dài: ${#KT1A_ALIAS} <= 9, Khớp regex ^KT1A_[A-F0-9]{4}$)"
  else
    echo -e "${RED}FAIL${NC} -> Alias ID không đúng định dạng: '$KT1A_ALIAS'"
    exit 1
  fi

  # Dọn dẹp học sinh test
  curl -s -X DELETE "$BASE_URL/students/$KT1A_STU_ID" -H "Authorization: Bearer $SECRET_TOKEN" >/dev/null
else
  echo -e "${RED}Không tìm thấy lớp KT1A để kiểm thử!${NC}"
  exit 1
fi

# Tìm ID của Ban GLV
GLV_RES=$(curl -s -X GET "$BASE_URL/classes?search=GLV" -H "Authorization: Bearer $SECRET_TOKEN")
GLV_ID=$(echo "$GLV_RES" | grep -o '"id":[0-9]*,"code":"GLV"' | head -n1 | cut -d, -f1 | cut -d: -f2)

if [ -n "$GLV_ID" ]; then
  echo -n "[TEST ALIAS_ID] Tạo thành viên vào Ban GLV: "
  ADD_GLV_RES=$(curl -s -X POST "$BASE_URL/classes/$GLV_ID/students" \
    -H "Authorization: Bearer $SECRET_TOKEN" \
    -H "Content-Type: application/json" \
    -d '{"name":"Anh Giuse Giáo Lý Viên"}')
  
  GLV_ALIAS=$(echo "$ADD_GLV_RES" | grep -o '"alias_id":"[^"]*"' | head -n1 | cut -d'"' -f4)
  GLV_STU_ID=$(echo "$ADD_GLV_RES" | grep -o '"id":[0-9]*' | head -n1 | cut -d: -f2)

  if [[ "$GLV_ALIAS" =~ ^GLV_[A-F0-9]{4}$ ]]; then
    echo -e "${GREEN}PASS${NC} -> Alias ID: $GLV_ALIAS (Độ dài: ${#GLV_ALIAS} <= 9, Khớp regex ^GLV_[A-F0-9]{4}$)"
  else
    echo -e "${RED}FAIL${NC} -> Alias ID không đúng định dạng: '$GLV_ALIAS'"
    exit 1
  fi

  # Dọn dẹp học sinh test
  curl -s -X DELETE "$BASE_URL/students/$GLV_STU_ID" -H "Authorization: Bearer $SECRET_TOKEN" >/dev/null
else
  echo -e "${RED}Không tìm thấy ban GLV để kiểm thử!${NC}"
  exit 1
fi

echo "=========================================================="
echo -e "${GREEN}TẤT CẢ TEST CASES STUDENT MANAGEMENT & ALIAS_ID ĐÃ PASS 100%!${NC}"
echo "=========================================================="
