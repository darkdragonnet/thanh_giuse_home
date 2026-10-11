import axios from 'axios';
import FormData from 'form-data';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Giả lập 25 học sinh nộp đồng thời từ các IP/mã PIN khác nhau
const CONCURRENT_REQUESTS = 25;
const API_BASE = process.env.API_BASE || 'http://localhost:3000/api';

export async function runLoadTest() {
  console.log(`[LoadTest] Bắt đầu kích hoạt ${CONCURRENT_REQUESTS} request đồng thời tới ${API_BASE}...`);

  // Tạo sẵn 1 file ảnh mẫu chuẩn bị test
  const sampleImagePath = path.join(__dirname, 'fixtures/sample_face.jpg');
  if (!fs.existsSync(sampleImagePath)) {
    throw new Error('Cần file ảnh mẫu tại tests/fixtures/sample_face.jpg');
  }

  const startTime = Date.now();

  const promises = Array.from({ length: CONCURRENT_REQUESTS }, async (_, idx) => {
    const studentId = idx + 1; // Giả sử danh sách ID từ 1 -> 25
    const fakeIp = `192.168.1.${10 + idx}`; // Giả lập các IP khác nhau để không chạm rate limiter chung

    const form = new FormData();
    form.append('file', fs.createReadStream(sampleImagePath));

    const reqStart = Date.now();
    try {
      const res = await axios.post(`${API_BASE}/students/${studentId}/photo`, form, {
        headers: {
          ...form.getHeaders(),
          'x-forwarded-for': fakeIp,
        },
        timeout: 10000,
      });
      const reqDuration = Date.now() - reqStart;
      return { id: studentId, status: res.status, durationMs: reqDuration, data: res.data };
    } catch (err: any) {
      const reqDuration = Date.now() - reqStart;
      return {
        id: studentId,
        status: err.response?.status || 'ERROR',
        durationMs: reqDuration,
        error: err.response?.data?.message || err.message,
      };
    }
  });

  const results = await Promise.all(promises);
  const elapsed = (Date.now() - startTime) / 1000;

  console.log(`\n--- KẾT QUẢ ĐẨY TẢI (Thời gian: ${elapsed}s) ---`);
  const successCount = results.filter((r) => r.status === 200).length;
  const conflictCount = results.filter((r) => r.status === 409).length;
  const rateLimitCount = results.filter((r) => r.status === 429).length;
  const errorCount = results.filter((r) => r.status !== 200 && r.status !== 409 && r.status !== 429).length;

  console.log(`- Thành công (200 OK Enqueued): ${successCount}`);
  console.log(`- Xung đột trạng thái (409 Conflict): ${conflictCount}`);
  console.log(`- Chặn Rate Limit (429): ${rateLimitCount}`);
  if (errorCount > 0) {
    console.log(`- Lỗi khác: ${errorCount}`);
    results
      .filter((r) => r.status !== 200)
      .forEach((r) => console.log(`  Student ${r.id}: status=${r.status}, error=${r.error}`));
  }

  const maxDuration = Math.max(...results.map((r) => r.durationMs));
  const avgDuration = Math.round(results.reduce((acc, r) => acc + r.durationMs, 0) / results.length);
  console.log(`- Thời gian phản hồi trung bình: ${avgDuration}ms, tối đa: ${maxDuration}ms`);

  return { successCount, conflictCount, rateLimitCount, elapsed, maxDuration, avgDuration, results };
}

// Chạy trực tiếp nếu là script chính
if (process.argv[1] && process.argv[1].endsWith('load-test-concurrent.ts')) {
  runLoadTest().catch(console.error);
}
