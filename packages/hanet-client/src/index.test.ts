import { HanetClient } from './index.js';

async function runTests() {
  console.log('--- BẮT ĐẦU KIỂM THỬ PACKAGES/HANET-CLIENT ---');

  // Khởi tạo client trỏ vào Mock Server cục bộ
  const client = new HanetClient({
    baseUrl: process.env.HANET_BASE_URL || 'http://localhost:4000',
    token: 'test_token',
    placeId: '196',
    circuitBreakerThreshold: 3,
    circuitBreakerCooldownMs: 10_000 // Test dùng 10s cooldown
  });

  // Test 1: Gọi thành công API registerByUrl
  const resSuccess = await client.registerByUrl({
    aliasID: `TEST_CLI_${Date.now()}`,
    name: 'Client Unit Test',
    imageUrl: 'https://static.hanet.ai/test.jpg'
  });
  console.assert(resSuccess.success === true, 'Test 1 Thất bại: API gọi phải thành công');
  console.assert(resSuccess.evaluation.action === 'SUCCESS', 'Test 1 Thất bại: Action phải là SUCCESS');
  console.log(' [PASS] Test 1: registerByUrl thành công.');

  // Test 2: Circuit Breaker nhảy sang OPEN sau 3 lỗi -503 liên tiếp
  const cb = client.getCircuitBreaker();
  cb.reset();

  cb.recordFailure();
  cb.recordFailure();
  console.assert(cb.getState() === 'CLOSED', 'Test 2 Thất bại: Sau 2 lần lỗi state vẫn phải CLOSED');

  cb.recordFailure();
  console.assert(cb.getState() === 'OPEN', 'Test 2 Thất bại: Đủ 3 lỗi state phải chuyển sang OPEN');
  console.log(' [PASS] Test 2: Circuit Breaker tự ngắt (OPEN) sau đúng 3 lỗi.');

  // Test 3: Fast-fail khi circuit đang OPEN
  let thrown = false;
  try {
    cb.checkExecution();
  } catch (err: any) {
    thrown = true;
    console.assert(err.name === 'CircuitBreakerOpenError', 'Test 3 Thất bại: Lỗi ném ra phải là CircuitBreakerOpenError');
  }
  console.assert(thrown === true, 'Test 3 Thất bại: Phải fast-fail khi breaker đang OPEN');
  console.log(' [PASS] Test 3: Fast-fail hoạt động chính xác khi mạch ngắt.');

  cb.reset();
  console.log('>>> TẤT CẢ UNIT TESTS CHO HANET-CLIENT ĐÃ PASS 100%! <<<');
}

runTests().catch((err) => {
  console.error('Test thất bại:', err);
  process.exit(1);
});
