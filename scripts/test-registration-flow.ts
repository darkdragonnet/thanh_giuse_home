import assert from 'node:assert/strict';

interface RegistrationResponse {
  success: boolean;
  message?: string;
  error?: string;
  jobId?: string;
  isLockedForManualEdit?: boolean;
  data?: {
    classCode?: string;
    name?: string;
    aliasId?: string;
  };
}

const API_BASE_URL = process.env.API_BASE_URL || 'http://localhost:3000';

async function submitRegistration(payload: Record<string, any>): Promise<{ status: number; body: RegistrationResponse }> {
  const url = `${API_BASE_URL}/api/registration/submit`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  const body = (await res.json()) as RegistrationResponse;
  return { status: res.status, body };
}

async function runE2ERegistrationTest() {
  console.log('======================================================================');
  console.log('   KIỂM THỬ E2E LUỒNG ĐĂNG KÝ HỌC SINH (REGISTRATION SUBMIT FLOW)   ');
  console.log('======================================================================');
  console.log(`Endpoint mục tiêu: ${API_BASE_URL}/api/registration/submit\n`);

  // Kịch bản 1: Định danh chuẩn 9 ký tự (4_4) -> Thành công 200 OK & Enqueued
  console.log('[Test 1] Gửi payload với aliasId chuẩn 9 ký tự ("TS1A_0088")...');
  const res1 = await submitRegistration({
    classCode: 'TS1A',
    name: 'Nguyễn Văn An',
    aliasId: 'TS1A_0088',
    imageFileUrl: 'http://localhost:4000/mock/face_sample.jpg',
  });
  console.log(`  -> HTTP Status: ${res1.status}`);
  console.log(`  -> Response:`, res1.body);
  assert.equal(res1.status, 200, 'Test 1 thất bại: Mã chuẩn 9 ký tự phải trả về 200 OK');
  assert.equal(res1.body.success, true, 'Test 1 thất bại: success phải là true');
  assert.ok(res1.body.jobId, 'Test 1 thất bại: Phải trả về jobId của BullMQ');
  console.log('  ✓ [PASS] Đã tiếp nhận và nạp BullMQ queue thành công.\n');

  // Kịch bản 2: Mã seed cũ 17 ký tự (STU_...) -> Bị chặn và cô lập (422 Unprocessable Entity)
  console.log('[Test 2] Gửi payload với mã seed cũ 17 ký tự ("STU_10A1_001_A7B2C")...');
  const res2 = await submitRegistration({
    classCode: '10A1',
    name: 'Lê Thị Bình (Seed cũ)',
    aliasId: 'STU_10A1_001_A7B2C',
  });
  console.log(`  -> HTTP Status: ${res2.status}`);
  console.log(`  -> Response:`, res2.body);
  assert.equal(res2.status, 422, 'Test 2 thất bại: Mã seed cũ phải bị từ chối với 422');
  assert.equal(res2.body.success, false, 'Test 2 thất bại: success phải là false');
  assert.equal(res2.body.error, 'LEGACY_FORMAT_QUARANTINED', 'Test 2 thất bại: Sai mã lỗi');
  assert.equal(res2.body.isLockedForManualEdit, true, 'Test 2 thất bại: Phải đánh cờ khóa chỉnh sửa');
  console.log('  ✓ [PASS] Đã cô lập thành công mã seed cũ, kích hoạt cờ duyệt thủ công.\n');

  // Kịch bản 3: Mã sai định dạng độ dài/ký tự ("TS1A_01") -> Từ chối 422
  console.log('[Test 3] Gửi payload với aliasId sai quy chuẩn regex ("TS1A_01")...');
  const res3 = await submitRegistration({
    classCode: 'TS1A',
    name: 'Trần Văn Cảnh',
    aliasId: 'TS1A_01',
  });
  console.log(`  -> HTTP Status: ${res3.status}`);
  console.log(`  -> Response:`, res3.body);
  assert.equal(res3.status, 422, 'Test 3 thất bại: Format sai phải bị trả về 422');
  assert.equal(res3.body.error, 'INVALID_IDENTIFIER_FORMAT');
  console.log('  ✓ [PASS] Đã chặn đúng định dạng không hợp lệ.\n');

  // Kịch bản 4: Thiếu thông tin bắt buộc (Không gửi aliasId hoặc name) -> Trả về 400 Bad Request
  console.log('[Test 4] Gửi payload thiếu trường aliasId bắt buộc...');
  const res4 = await submitRegistration({
    classCode: 'TS1A',
    name: 'Người Vô Danh',
  });
  console.log(`  -> HTTP Status: ${res4.status}`);
  console.log(`  -> Response:`, res4.body);
  assert.equal(res4.status, 400, 'Test 4 thất bại: Thiếu trường bắt buộc phải trả về 400');
  assert.equal(res4.body.error, 'MISSING_REQUIRED_FIELDS');
  console.log('  ✓ [PASS] Đã kiểm soát validation trường bắt buộc.\n');

  console.log('======================================================================');
  console.log('   🎉 TOÀN BỘ 4/4 KỊCH BẢN E2E ĐĂNG KÝ HỌC SINH ĐÃ ĐẠT CHUẨN 100%   ');
  console.log('======================================================================');
}

runE2ERegistrationTest().catch((err) => {
  console.error('\n❌ Lỗi khi thực thi E2E Test:', err);
  process.exit(1);
});
