import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import pg from 'pg';
import IORedis from 'ioredis';
import { generateStudentQrToken } from '@thanh-giuse/shared-infra';

const { Pool } = pg;
const API_BASE = process.env.API_BASE || 'http://localhost:3000';
const rawDbUrl =
  process.env.DATABASE_URL ||
  'postgresql://postgres_user:super_secure_postgres_password_change_me@localhost:5432/thanh_giuse_db';
const DB_URL = rawDbUrl.replace('@app_postgres:', '@localhost:').replace('@postgres:', '@localhost:');
const REDIS_URL =
  process.env.REDIS_URL ||
  'redis://:super_secure_redis_password_change_me@localhost:6379/0';

function checkFileExists(filePath: string): boolean {
  const filename = path.basename(filePath);
  const isHeld = filePath.includes('/held/') || filePath.includes('\\held\\');
  const relPath = isHeld ? `held/${filename}` : filename;

  // 1. Kiểm tra trên filesystem host (nếu chạy local)
  const localCandidates = [
    filePath,
    path.resolve('uploads', relPath),
    path.resolve('uploads', filename),
  ];
  for (const c of localCandidates) {
    if (fs.existsSync(c)) return true;
  }

  // 2. Kiểm tra bên trong container thanh_giuse_api (nếu chạy Docker)
  try {
    const checkTarget = isHeld ? `/app/uploads/held/${filename}` : `/app/uploads/${filename}`;
    execSync(`docker exec thanh_giuse_api test -f "${checkTarget}"`, { stdio: 'ignore' });
    return true;
  } catch {
    // Docker exec failed or file not found in container
  }

  return false;
}

describe('Contract Test: POST /api/admin-requests & Held Conflict Flow', () => {
  let pool: pg.Pool;
  let redis: IORedis;
  let testClassId: number;
  let testClassCode: string;

  const createdStudentIds: number[] = [];
  const createdRequestIds: number[] = [];
  const trackedRedisKeys: string[] = [];
  const sampleJpeg = fs.readFileSync(path.resolve('tests/fixtures/sample_face.jpg'));

  beforeAll(async () => {
    pool = new Pool({ connectionString: DB_URL });
    const formattedRedisUrl = REDIS_URL.replace('@app_redis:', '@localhost:').replace('@redis:', '@localhost:');
    redis = new IORedis(formattedRedisUrl, { maxRetriesPerRequest: null });

    const suffix = `${Date.now().toString().slice(-4)}_${Math.floor(Math.random() * 1000)}`;
    testClassCode = `TEST_AR_${suffix}`;

    const clsRes = await pool.query(
      `INSERT INTO classes (code, name, token, is_locked)
       VALUES ($1, $2, $3, false)
       RETURNING id`,
      [testClassCode, `Lớp Test Admin Requests ${testClassCode}`, `PIN_${testClassCode}`]
    );
    testClassId = clsRes.rows[0].id;
  });

  afterAll(async () => {
    // Dọn dẹp triệt để dữ liệu TEST_ (students, classes, admin_requests, logs, redis, files)
    if (createdRequestIds.length > 0) {
      await pool.query('DELETE FROM admin_requests WHERE id = ANY($1::int[])', [createdRequestIds]);
    }
    await pool.query("DELETE FROM admin_requests WHERE student_name LIKE 'TEST_%' OR note LIKE 'TEST_%' OR alias_id LIKE 'TEST_%'");

    if (createdStudentIds.length > 0) {
      await pool.query('DELETE FROM logs WHERE student_id = ANY($1::int[])', [createdStudentIds]);
      await pool.query('DELETE FROM admin_requests WHERE student_id = ANY($1::int[])', [createdStudentIds]);
      await pool.query('DELETE FROM students WHERE id = ANY($1::int[])', [createdStudentIds]);
    }
    await pool.query("DELETE FROM logs WHERE alias_id LIKE 'TEST_%' OR result_message LIKE '%TEST_%'");
    await pool.query("DELETE FROM students WHERE alias_id LIKE 'TEST_%' OR name LIKE 'TEST_%'");

    if (testClassId) {
      await pool.query('DELETE FROM students WHERE class_id = $1', [testClassId]);
      await pool.query('DELETE FROM classes WHERE id = $1', [testClassId]);
    }

    for (const key of trackedRedisKeys) {
      await redis.del(key);
    }

    try {
      execSync('docker exec thanh_giuse_api sh -c "rm -f /app/uploads/admin_req_TEST_* /app/uploads/held/*_*.jpg"', { stdio: 'ignore' });
    } catch {
      // ignore
    }

    await pool.end();
    await redis.quit();
  });

  async function createTestStudent(status: 'empty' | 'success' = 'empty'): Promise<{ id: number; alias_id: string; qr_token: string; name: string }> {
    const suffix = `${Date.now()}_${Math.floor(Math.random() * 10000)}`;
    const aliasId = `TEST_AR_S_${suffix}`;
    const name = `TEST Student ${suffix}`;
    const qrToken = generateStudentQrToken();

    const res = await pool.query(
      `INSERT INTO students (class_id, name, alias_id, qr_token, status, person_id)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, alias_id, qr_token, name`,
      [testClassId, name, aliasId, qrToken, status, status === 'success' ? `HANET_${suffix}` : null]
    );

    const s = res.rows[0];
    createdStudentIds.push(s.id);
    return s;
  }

  // 1. admin-requests đủ định danh → 201 + liên kết đúng (hành vi cũ giữ nguyên)
  it('1. admin-requests đủ định danh → 201 + liên kết đúng (hành vi cũ giữ nguyên)', async () => {
    const student = await createTestStudent('empty');
    const note = `TEST_full_id_req_${Date.now()}`;

    const form = new FormData();
    form.append('photo', new Blob([sampleJpeg], { type: 'image/jpeg' }), 'portrait.jpg');
    form.append('alias_id', student.alias_id);
    form.append('note', note);

    const res = await fetch(`${API_BASE}/api/admin-requests`, {
      method: 'POST',
      headers: { 'x-forwarded-for': '10.90.1.1' },
      body: form,
    });

    expect(res.status).toBe(201);
    const body: any = await res.json();
    expect(body.success).toBe(true);
    expect(body.data).toBeDefined();

    createdRequestIds.push(body.data.id);
    trackedRedisKeys.push(`ratelimit:admin_req:${student.alias_id}`);

    // Kiểm tra liên kết định danh trong database
    const dbRes = await pool.query('SELECT * FROM admin_requests WHERE id = $1', [body.data.id]);
    expect(dbRes.rows.length).toBe(1);
    const row = dbRes.rows[0];
    expect(row.student_id).toBe(student.id);
    expect(row.alias_id).toBe(student.alias_id);
    expect(row.class_id).toBe(testClassId);
    expect(row.status).toBe('new');

    // Kiểm tra file tồn tại trên đĩa (hoặc container)
    expect(checkFileExists(row.image_path)).toBe(true);

    // Kiểm tra audit log
    const logRes = await pool.query(
      "SELECT * FROM logs WHERE student_id = $1 AND action = 'ADMIN_REQUEST_CREATED'",
      [student.id]
    );
    expect(logRes.rows.length).toBeGreaterThanOrEqual(1);
  });

  // 2. admin-requests chỉ có tên + ảnh → 201 + file tồn tại trên đĩa + hàng request có student_name, student_id NULL, alias_id NULL
  it('2. admin-requests chỉ có tên + ảnh → 201 + file tồn tại trên đĩa + hàng request có student_name, student_id NULL, alias_id NULL', async () => {
    const testName = `TEST_NameOnly_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
    const note = `TEST_note_name_only_${Date.now()}`;

    const form = new FormData();
    form.append('photo', new Blob([sampleJpeg], { type: 'image/jpeg' }), 'student_photo.jpg');
    form.append('student_name', testName);
    form.append('note', note);

    const res = await fetch(`${API_BASE}/api/admin-requests`, {
      method: 'POST',
      headers: { 'x-forwarded-for': '10.90.1.2' },
      body: form,
    });

    expect(res.status).toBe(201);
    const body: any = await res.json();
    expect(body.success).toBe(true);
    expect(body.data).toBeDefined();

    createdRequestIds.push(body.data.id);

    const dbRes = await pool.query('SELECT * FROM admin_requests WHERE id = $1', [body.data.id]);
    expect(dbRes.rows.length).toBe(1);
    const row = dbRes.rows[0];
    expect(row.student_id).toBeNull();
    expect(row.alias_id).toBeNull();
    expect(row.student_name).toBe(testName);
    expect(row.status).toBe('new');

    // File tồn tại trên đĩa
    expect(checkFileExists(row.image_path)).toBe(true);

    // Kiểm tra audit log
    const logRes = await pool.query(
      "SELECT * FROM logs WHERE action = 'ADMIN_REQUEST_CREATED' AND result_message LIKE $1",
      [`%ID: ${body.data.id}%`]
    );
    expect(logRes.rows.length).toBeGreaterThanOrEqual(1);
  });

  // 3. admin-requests có ảnh nhưng không định danh, không tên → 201 + hàng request không định danh + file tồn tại (chống thất thoát tuyệt đối), rate limit theo IP
  it('3. admin-requests có ảnh nhưng không định danh, không tên → 201 + hàng request không định danh + file tồn tại (chống thất thoát tuyệt đối), rate limit theo IP', async () => {
    const note = `TEST_no_id_no_name_${Date.now()}`;
    const customIp = '10.90.1.3';

    const form = new FormData();
    form.append('photo', new Blob([sampleJpeg], { type: 'image/jpeg' }), 'anonymous_photo.jpg');
    form.append('note', note);

    const res = await fetch(`${API_BASE}/api/admin-requests`, {
      method: 'POST',
      headers: { 'x-forwarded-for': customIp },
      body: form,
    });

    expect(res.status).toBe(201);
    const body: any = await res.json();
    expect(body.success).toBe(true);
    expect(body.data).toBeDefined();

    createdRequestIds.push(body.data.id);

    const dbRes = await pool.query('SELECT * FROM admin_requests WHERE id = $1', [body.data.id]);
    expect(dbRes.rows.length).toBe(1);
    const row = dbRes.rows[0];
    expect(row.student_id).toBeNull();
    expect(row.alias_id).toBeNull();
    expect(row.student_name).toBeNull();
    expect(row.status).toBe('new');

    // File tồn tại trên đĩa
    expect(checkFileExists(row.image_path)).toBe(true);
  });

  // 4. admin-requests không có ảnh → 400 như cũ
  it('4. admin-requests không có ảnh → 400 như cũ', async () => {
    const form = new FormData();
    form.append('student_name', 'TEST_NoPhoto_Student');
    form.append('note', 'TEST_missing_photo');

    const res = await fetch(`${API_BASE}/api/admin-requests`, {
      method: 'POST',
      headers: { 'x-forwarded-for': '10.90.1.4' },
      body: form,
    });

    expect(res.status).toBe(400);
    const body: any = await res.json();
    expect(body.message).toContain('ảnh chân dung');
  });

  // 5. Rate limit: lần thứ 6 trong giờ (cùng key tên) → 429
  it('5. Rate limit: lần thứ 6 trong giờ (cùng key tên) → 429', async () => {
    const rlName = `TEST_RL_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
    const sanitizedKey = rlName;
    trackedRedisKeys.push(`ratelimit:admin_req:${sanitizedKey}`);
    await redis.del(`ratelimit:admin_req:${sanitizedKey}`);

    const customIp = '10.90.1.5';

    // 5 lần đầu -> 201
    for (let i = 1; i <= 5; i++) {
      const form = new FormData();
      form.append('photo', new Blob([sampleJpeg], { type: 'image/jpeg' }), `rl_${i}.jpg`);
      form.append('student_name', rlName);
      form.append('note', `TEST_rl_attempt_${i}`);

      const res = await fetch(`${API_BASE}/api/admin-requests`, {
        method: 'POST',
        headers: { 'x-forwarded-for': customIp },
        body: form,
      });

      expect(res.status).toBe(201);
      const b: any = await res.json();
      if (b.data?.id) createdRequestIds.push(b.data.id);
    }

    // Lần thứ 6 -> 429 Too Many Requests
    const form6 = new FormData();
    form6.append('photo', new Blob([sampleJpeg], { type: 'image/jpeg' }), 'rl_6.jpg');
    form6.append('student_name', rlName);
    form6.append('note', 'TEST_rl_attempt_6');

    const res6 = await fetch(`${API_BASE}/api/admin-requests`, {
      method: 'POST',
      headers: { 'x-forwarded-for': customIp },
      body: form6,
    });

    expect(res6.status).toBe(429);
    const b6: any = await res6.json();
    expect(b6.error).toBe('Too Many Requests');
  });

  // 6. Nộp ảnh chính vào hàng TEST_ đang success (tự nộp, không PIN) → 409 + file còn nguyên trong held/ + có audit log + hàng học sinh không đổi (vẫn success)
  it('6. Nộp ảnh chính vào hàng TEST_ đang success (tự nộp, không PIN) → 409 + file còn nguyên trong held/ + có audit log + hàng học sinh không đổi (vẫn success)', async () => {
    const student = await createTestStudent('success');

    const form = new FormData();
    form.append('photo', new Blob([sampleJpeg], { type: 'image/jpeg' }), 'self_upload.jpg');

    const res = await fetch(`${API_BASE}/api/students/${student.id}/photo`, {
      method: 'POST',
      headers: { 'x-forwarded-for': `10.90.1.${student.id % 200 + 10}` },
      body: form,
    });

    expect(res.status).toBe(409);
    const body: any = await res.json();
    expect(body.error).toBe('Conflict');
    // Message mới nói rõ ảnh ĐÃ ĐƯỢC GIỮ để admin xử lý, không bị xóa
    expect(body.message.toLowerCase()).toContain('giữ');

    // Kiểm tra hàng học sinh không đổi (vẫn success)
    const dbStudent = await pool.query('SELECT status, person_id FROM students WHERE id = $1', [student.id]);
    expect(dbStudent.rows[0].status).toBe('success');
    expect(dbStudent.rows[0].person_id).toBeTruthy();

    // Kiểm tra audit log PHOTO_HELD_CONFLICT
    const logRes = await pool.query(
      "SELECT * FROM logs WHERE student_id = $1 AND action = 'PHOTO_HELD_CONFLICT'",
      [student.id]
    );
    expect(logRes.rows.length).toBe(1);
    expect(logRes.rows[0].result_message).toContain('held');

    // Kiểm tra file tồn tại trong thư mục held/ (tên dạng <studentId>_<timestamp>.jpg)
    // Trích xuất đường dẫn file held từ audit log
    const match = logRes.rows[0].result_message.match(/(?:tại|mục tạm)\s+([^\s]+)/i);
    const heldFilePath = match ? match[1] : '';
    expect(heldFilePath).toBeTruthy();
    expect(checkFileExists(heldFilePath)).toBe(true);
  });
});
