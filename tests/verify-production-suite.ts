/**
 * BỘ KIỂM THỬ ĐỘC LẬP TOÀN DIỆN HỆ THỐNG (4 TẦNG KIẾN TRÚC)
 *
 * Chạy trực tiếp từ container API hoặc VPS:
 *   docker exec -it thanh_giuse_api node tests/verify-production-suite.ts
 * Hoặc:
 *   npx ts-node tests/verify-production-suite.ts
 */

import assert from 'node:assert/strict';
import { Pool } from 'pg';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';

const DOMAIN = process.env.TEST_DOMAIN || 'https://thanhgiuse.gaudetedomino.io.vn';

async function runTestSuite() {
  console.log('════════════════════════════════════════════════════════════════');
  console.log('🧪 BẮT ĐẦU KIỂM THỬ ĐỘC LẬP HỆ THỐNG: ' + DOMAIN);
  console.log('════════════════════════════════════════════════════════════════\n');

  let passed = 0;
  let failed = 0;

  async function test(name: string, fn: () => Promise<void>) {
    const t0 = Date.now();
    try {
      await fn();
      const ms = Date.now() - t0;
      console.log(`  ✔ [PASS] ${name} (${ms}ms)`);
      passed++;
    } catch (err: any) {
      console.log(`  ❌ [FAIL] ${name}: ${err.message}`);
      failed++;
    }
  }

  // -------------------------------------------------------------------
  // TEST TẦNG 1: GIAO DIỆN WEB FRONTEND (SPA)
  // -------------------------------------------------------------------
  console.log('[TẦNG 1: KIỂM THỬ GIAO DIỆN WEB]');
  await test('GET /l/ (Trang nộp ảnh học sinh)', async () => {
    const res = await fetch(`${DOMAIN}/l/`);
    assert.equal(res.status, 200, 'HTTP Status phải là 200');
    const text = await res.text();
    assert.ok(text.includes('<!DOCTYPE html>') || text.includes('<html'), 'Nội dung phải là HTML');
  });

  await test('GET /classes (Trang danh sách lớp công khai)', async () => {
    const res = await fetch(`${DOMAIN}/classes`);
    assert.equal(res.status, 200, 'HTTP Status phải là 200');
  });

  // -------------------------------------------------------------------
  // TEST TẦNG 2: BACKEND API & MẠNG NỘI BỘ
  // -------------------------------------------------------------------
  console.log('\n[TẦNG 2: KIỂM THỬ API BACKEND]');
  await test('GET /health (API Healthcheck qua Nginx)', async () => {
    const res = await fetch(`${DOMAIN}/health`);
    assert.equal(res.status, 200, 'Healthcheck phải trả về HTTP 200');
    const body = (await res.json()) as any;
    assert.equal(body.status, 'ok', 'Status phải là ok');
    assert.equal(body.serviceStatus, 'UP', 'ServiceStatus phải là UP');
  });

  await test('GET /api/public/classes (API danh sách lớp & Expose Headers)', async () => {
    const res = await fetch(`${DOMAIN}/api/public/classes`);
    assert.equal(res.status, 200, 'HTTP Status phải là 200');
    const classes = (await res.json()) as any[];
    assert.ok(Array.isArray(classes), 'Kết quả phải là một mảng');
    assert.ok(classes.length > 0, 'Danh sách lớp không được rỗng');

    // Kiểm tra các Custom Headers đã được expose đúng
    const totalClassesHeader = res.headers.get('x-total-classes');
    const totalStudentsHeader = res.headers.get('x-total-students');
    const totalSuccessHeader = res.headers.get('x-total-success');
    const overallRateHeader = res.headers.get('x-overall-rate');

    assert.ok(totalClassesHeader !== null, 'Phải có header X-Total-Classes');
    assert.ok(totalStudentsHeader !== null, 'Phải có header X-Total-Students');
    assert.ok(totalSuccessHeader !== null, 'Phải có header X-Total-Success');
    assert.ok(overallRateHeader !== null, 'Phải có header X-Overall-Rate');
    console.log(
      `      (Public Stats -> Classes: ${totalClassesHeader}, Students: ${totalStudentsHeader}, Success: ${totalSuccessHeader}, Rate: ${overallRateHeader}%)`
    );
  });

  await test('GET /api/classes/TS3A/students (API lấy danh sách học sinh theo lớp)', async () => {
    const res = await fetch(`${DOMAIN}/api/classes/TS3A/students`);
    assert.equal(res.status, 200, 'HTTP Status phải là 200');
    const body = (await res.json()) as any;
    assert.ok(Array.isArray(body.students || body.data || body), 'Phải có danh sách học sinh');
  });

  // -------------------------------------------------------------------
  // TEST TẦNG 3: NGINX PROXY & STATIC FACES (RULE ^~ /tmp-faces)
  // -------------------------------------------------------------------
  console.log('\n[TẦNG 3: PHỤC VỤ ẢNH TĨNH & KHÔNG BỊ CACHE LỖI]');
  await test('GET /tmp-faces/ (Đảm bảo Nginx phục vụ ảnh JPEG & No-Cache)', async () => {
    const testUrl = `${DOMAIN}/tmp-faces/face_TS3A_MPNG_1792546526472.jpg`;
    const res = await fetch(testUrl);
    assert.equal(res.status, 200, 'Nginx phải trả về 200 OK cho ảnh đã chuẩn hóa');
    assert.ok(res.headers.get('content-type')?.includes('image'), 'Content-Type phải là ảnh');
    assert.ok(
      (res.headers.get('cache-control') || '').includes('no-store') ||
        (res.headers.get('cache-control') || '').includes('no-cache'),
      'Phải có header chống cache để HANET luôn lấy ảnh mới nhất'
    );
  });

  // -------------------------------------------------------------------
  // TEST TẦNG 4: HÀNG ĐỢI BULLMQ & CSDL POSTGRESQL
  // -------------------------------------------------------------------
  console.log('\n[TẦNG 4: HÀNG ĐỢI BULLMQ & TOÀN VẸN CSDL]');
  await test('Kiểm tra hàng đợi BullMQ (Không còn job bị delay)', async () => {
    const redis = new Redis(process.env.REDIS_URL || 'redis://:super_secure_redis_password_change_me@127.0.0.1:6379', {
      maxRetriesPerRequest: null,
    });
    const queue = new Queue('registration_queue', { connection: redis });
    const delayed = await queue.getDelayedCount();
    const waiting = await queue.getWaitingCount();
    const active = await queue.getActiveCount();
    await queue.close();
    await redis.quit();

    console.log(`      (Queue Stats -> Waiting: ${waiting}, Active: ${active}, Delayed: ${delayed})`);
    assert.equal(delayed, 0, 'Hàng đợi không được còn job bị kẹt delay 300s');
  });

  await test('Kiểm tra tỷ lệ hoàn thành trong PostgreSQL', async () => {
    const pool = new Pool({
      connectionString:
        process.env.DATABASE_URL ||
        'postgresql://postgres_user:super_secure_postgres_password_change_me@127.0.0.1:5432/thanh_giuse_db',
    });
    const res = await pool.query(
      'SELECT status, count(*) FROM students GROUP BY status ORDER BY count DESC'
    );
    await pool.end();

    const stats = Object.fromEntries(res.rows.map((r: any) => [r.status, Number(r.count)]));
    console.log(
      `      (DB Stats -> Success: ${stats.success || 0}, Pending: ${stats.pending || 0}, Manual: ${stats.manual_review || 0}, Empty: ${stats.empty || 0})`
    );
    assert.ok((stats.success || 0) >= 140, 'Số lượng học sinh success phải đạt tối thiểu 140');
  });

  // -------------------------------------------------------------------
  // TỔNG KẾT
  // -------------------------------------------------------------------
  console.log('\n════════════════════════════════════════════════════════════════');
  if (failed === 0) {
    console.log(`🎉 TẤT CẢ ${passed}/${passed} BÀI TEST ĐÃ VƯỢT QUA! HỆ THỐNG HOÀN TOÀN KHỎE MẠNH.`);
  } else {
    console.log(`⚠️ KẾT QUẢ: ${passed} bài PASS, ${failed} bài FAIL.`);
  }
  console.log('════════════════════════════════════════════════════════════════\n');
}

runTestSuite().catch((err) => {
  console.error('Lỗi thực thi test suite:', err);
  process.exit(1);
});
