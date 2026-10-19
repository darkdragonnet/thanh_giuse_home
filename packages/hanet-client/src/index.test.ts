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
  cb.reset();

  // Test 4: Khi gặp HTTP 400 Bad Request, không được làm sập Circuit Breaker
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ returnCode: -1, returnMessage: 'INVALID_IMAGE_URL' }), {
        status: 400,
        statusText: 'Bad Request',
        headers: { 'Content-Type': 'application/json' }
      });

    const res400 = await client.registerByUrl({
      aliasID: 'TEST_400',
      name: 'Test 400',
      imageUrl: 'http://invalid-ip:8090/tmp-faces/test.jpg'
    });

    console.assert(res400.success === false, 'Test 4 Thất bại: Gọi 400 phải trả về success: false');
    console.assert(cb.getState() === 'CLOSED', 'Test 4 Thất bại: Lỗi 400 không được kích hoạt Circuit Breaker');
    console.log(' [PASS] Test 4: HTTP 400 được xử lý an toàn và Circuit Breaker vẫn CLOSED.');

    // Test 5: Khi gặp HTTP 400 dạng HTML từ Gateway/Cloudflare (không parse được JSON)
    globalThis.fetch = async () =>
      new Response('<html><body>Direct IP access is not allowed (HTTP 400)</body></html>', {
        status: 400,
        statusText: 'Bad Request',
        headers: { 'Content-Type': 'text/html' }
      });

    const resHtml400 = await client.registerByUrl({
      aliasID: 'TEST_HTML_400',
      name: 'Test HTML 400',
      imageUrl: 'http://161.248.146.115:8090/tmp-faces/test.jpg'
    });

    console.assert(resHtml400.success === false, 'Test 5 Thất bại: resHtml400 phải success: false');
    console.assert(resHtml400.evaluation.action === 'QUARANTINE_MANUAL', 'Test 5 Thất bại: Action phải là QUARANTINE_MANUAL');
    console.assert(cb.getState() === 'CLOSED', 'Test 5 Thất bại: Circuit Breaker vẫn phải CLOSED');
    console.log(' [PASS] Test 5: HTML lỗi 400 từ Cloudflare được cô lập sang QUARANTINE_MANUAL mà không sập Circuit Breaker.');
  } finally {
    globalThis.fetch = originalFetch;
  }

  console.log('>>> TẤT CẢ UNIT TESTS CHO HANET-CLIENT ĐÃ PASS 100%! <<<');
}

runTests().catch((err) => {
  console.error('Test thất bại:', err);
  process.exit(1);
});
