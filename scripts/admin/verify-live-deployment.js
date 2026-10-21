import assert from 'node:assert/strict';
import { existsSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import pg from 'pg';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';

const { Pool } = pg;
const DOMAIN = process.env.PUBLIC_DOMAIN || 'https://thanhgiuse.gaudetedomino.io.vn';

async function runTestSuite() {
  console.log('════════════════════════════════════════════════════════════════');
  console.log('🧪 BẮT ĐẦU KIỂM THỬ ĐỘC LẬP TOÀN DIỆN HỆ THỐNG');
  console.log(`🌐 Target Domain: ${DOMAIN}`);
  console.log('════════════════════════════════════════════════════════════════\n');

  let passed = 0;
  let failed = 0;

  async function test(name, fn) {
    const t0 = Date.now();
    try {
      await fn();
      const ms = Date.now() - t0;
      console.log(`  ✔ [PASS] ${name} (${ms}ms)`);
      passed++;
    } catch (err) {
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
    assert.equal(res.status, 200, `HTTP Status phải là 200 (nhận được ${res.status})`);
    const text = await res.text();
    assert.ok(text.includes('<!DOCTYPE html>') || text.includes('<html'), 'Nội dung phải là HTML');
  });

  await test('GET /classes (Trang danh sách lớp công khai)', async () => {
    const res = await fetch(`${DOMAIN}/classes`);
    assert.equal(res.status, 200, `HTTP Status phải là 200 (nhận được ${res.status})`);
  });

  await test('GET /admin (Trang quản trị hệ thống)', async () => {
    const res = await fetch(`${DOMAIN}/admin`);
    assert.equal(res.status, 200, `HTTP Status phải là 200 (nhận được ${res.status})`);
  });

  // -------------------------------------------------------------------
  // TEST TẦNG 2: BACKEND API & MẠNG NỘI BỘ
  // -------------------------------------------------------------------
  console.log('\n[TẦNG 2: KIỂM THỬ API BACKEND]');
  await test('GET /health (API Healthcheck)', async () => {
    const res = await fetch(`${DOMAIN}/health`);
    assert.equal(res.status, 200, `HTTP Status phải là 200 (nhận được ${res.status})`);
    const body = await res.json();
    assert.equal(body.status, 'ok', "Body phải có status: 'ok'");
  });

  await test('GET /api/public/classes (API danh sách lớp)', async () => {
    const res = await fetch(`${DOMAIN}/api/public/classes`);
    assert.equal(res.status, 200);
    const classes = await res.json();
    assert.ok(Array.isArray(classes), 'Kết quả phải là một mảng');
    assert.ok(classes.length > 0, 'Danh sách lớp không được rỗng');
  });

  await test('GET /api/classes/TS3A/students (API lấy danh sách học sinh theo lớp)', async () => {
    const res = await fetch(`${DOMAIN}/api/classes/TS3A/students`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(Array.isArray(body.students || body.data || body), 'Phải có danh sách học sinh');
  });

  // -------------------------------------------------------------------
  // TEST TẦNG 3: NGINX PROXY & STATIC FACES (RULE ^~ /tmp-faces)
  // -------------------------------------------------------------------
  console.log('\n[TẦNG 3: PHỤC VỤ ẢNH TĨNH & KHÔNG BỊ CACHE LỖI]');
  await test('GET /tmp-faces/ (Đảm bảo Nginx phục vụ ảnh JPEG & No-Cache)', async () => {
    // Tìm file ảnh có thực tế trong thư mục hoặc tạo file test probe
    let sampleFilename = 'face_TS3A_MPNG_1792546526472.jpg';
    const tmpFacesDir = '/app/uploads/tmp-faces';

    if (existsSync(tmpFacesDir)) {
      try {
        const files = readdirSync(tmpFacesDir).filter(
          (f) => f.endsWith('.jpg') || f.endsWith('.png') || f.endsWith('.jpeg')
        );
        if (files.length > 0) {
          sampleFilename = files[0];
        } else {
          // Tạo 1 file test probe nhỏ để xác thực rule Nginx
          writeFileSync(path.join(tmpFacesDir, 'probe_test.jpg'), Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
          sampleFilename = 'probe_test.jpg';
        }
      } catch {}
    }

    const testUrl = `${DOMAIN}/tmp-faces/${sampleFilename}`;
    const res = await fetch(testUrl);
    assert.equal(res.status, 200, `Nginx phải trả về 200 OK cho ảnh tại ${testUrl} (nhận ${res.status})`);
    assert.ok(
      (res.headers.get('content-type') || '').includes('image') ||
        (res.headers.get('content-type') || '').includes('octet-stream'),
      'Content-Type phải là ảnh'
    );
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
    const redisUrl =
      process.env.REDIS_URL || 'redis://:super_secure_redis_password_change_me@app_redis:6379/0';
    const redis = new Redis(redisUrl, { maxRetriesPerRequest: null });
    const queue = new Queue('registration_queue', { connection: redis });
    const delayed = await queue.getDelayedCount();
    const waiting = await queue.getWaitingCount();
    const active = await queue.getActiveCount();
    await queue.close();
    await redis.quit();
    console.log(`      (Queue Stats -> Waiting: ${waiting}, Active: ${active}, Delayed: ${delayed})`);
    assert.equal(delayed, 0, `Hàng đợi không được còn job bị kẹt delay 300s (hiện có ${delayed})`);
  });

  await test('Kiểm tra tỷ lệ hoàn thành trong PostgreSQL', async () => {
    const dbUrl =
      process.env.DATABASE_URL ||
      'postgresql://postgres_user:super_secure_postgres_password_change_me@app_postgres:5432/thanh_giuse_db';
    const pool = new Pool({ connectionString: dbUrl });
    const res = await pool.query(
      'SELECT status, count(*) FROM students GROUP BY status ORDER BY count DESC'
    );
    await pool.end();
    const stats = Object.fromEntries(res.rows.map((r) => [r.status, Number(r.count)]));
    console.log(
      `      (DB Stats -> Success: ${stats.success || 0}, Pending: ${stats.pending || 0}, Manual: ${stats.manual_review || 0}, Empty: ${stats.empty || 0})`
    );
    assert.ok(
      typeof stats.success === 'number',
      'Phải truy vấn được thống kê học sinh từ bảng students'
    );
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
  console.error('Fatal Error trong test suite:', err);
  process.exit(1);
});
