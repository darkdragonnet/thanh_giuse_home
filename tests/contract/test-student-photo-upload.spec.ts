import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';
import { generateStudentQrToken } from '@thanh-giuse/shared-infra';

const { Pool } = pg;
const API_BASE = process.env.API_BASE || 'http://localhost:3000';
const DB_URL =
  process.env.DATABASE_URL ||
  'postgresql://postgres_user:super_secure_postgres_password_change_me@localhost:5432/thanh_giuse_db';

describe('T011: Contract Test for POST /api/students/:id/photo (contracts/student-api.yaml)', () => {
  let pool: pg.Pool;
  let createdStudentIds: number[] = [];
  let testClassId: number;
  let testClassCode: string;

  beforeAll(async () => {
    pool = new Pool({ connectionString: DB_URL });

    const uniqueSuffix = Date.now().toString().slice(-2);
    testClassCode = `UP${uniqueSuffix}`;

    const clsRes = await pool.query(
      `INSERT INTO classes (code, name, token, is_locked)
       VALUES ($1, $2, $3, false)
       RETURNING id`,
      [testClassCode, `Lớp Test Upload ${testClassCode}`, `PIN_UP_${uniqueSuffix}`]
    );
    testClassId = clsRes.rows[0].id;
  });

  afterAll(async () => {
    // Dọn dẹp tuyệt đối mọi học sinh test dùng một lần (KHÔNG đụng vào dữ liệu thật)
    await pool.query("DELETE FROM logs WHERE alias_id LIKE 'TEST_T011_%'");
    if (createdStudentIds.length > 0) {
      await pool.query('DELETE FROM students WHERE id = ANY($1::int[])', [createdStudentIds]);
    }
    await pool.query("DELETE FROM students WHERE alias_id LIKE 'TEST_T011_%'");
    if (testClassId) {
      await pool.query('DELETE FROM students WHERE class_id = $1', [testClassId]);
      await pool.query('DELETE FROM classes WHERE id = $1', [testClassId]);
    }
    await pool.end();
  });

  // Helper tạo học sinh test dùng một lần
  async function createTestStudent(): Promise<{ id: number; alias_id: string }> {
    const uniqueSuffix = `${Date.now()}_${Math.floor(Math.random() * 10000)}`;
    const aliasId = `TEST_T011_${uniqueSuffix}`;
    const name = `Test Student ${uniqueSuffix}`;
    const qrToken = generateStudentQrToken();

    const res = await pool.query(
      "INSERT INTO students (class_id, name, alias_id, qr_token, status) VALUES ($1, $2, $3, $4, 'empty') RETURNING id, alias_id",
      [testClassId, name, aliasId, qrToken]
    );

    const student = res.rows[0];
    createdStudentIds.push(student.id);
    return student;
  }

  // 1. Ảnh JPEG hợp lệ < 1MB
  it('1. Ảnh JPEG hợp lệ < 1MB: HTTP 200 + đúng schema + phản hồi < 1.500ms + học sinh chuyển pending', async () => {
    const student = await createTestStudent();
    const jpegBuffer = fs.readFileSync(path.resolve('tests/fixtures/sample_face.jpg'));

    const formData = new FormData();
    const blob = new Blob([jpegBuffer], { type: 'image/jpeg' });
    formData.append('photo', blob, 'sample_face.jpg');

    const startTime = Date.now();
    const res = await fetch(`${API_BASE}/api/students/${student.id}/photo`, {
      method: 'POST',
      headers: { 'x-forwarded-for': `10.99.1.${student.id}` },
      body: formData,
    });
    const elapsedMs = Date.now() - startTime;

    expect(elapsedMs).toBeLessThan(1500);
    expect(res.status).toBe(200);

    const body: any = await res.json();
    expect(body.success).toBe(true);
    expect(body.message).toBeDefined();

    // Kiểm tra trạng thái học sinh trong DB
    const dbRes = await pool.query('SELECT status, local_image_path FROM students WHERE id = $1', [student.id]);
    expect(dbRes.rows[0].status).toBe('pending');
    expect(dbRes.rows[0].local_image_path).toBeTruthy();
  });

  // 2. File > 5MB bị từ chối
  it('2. File ảnh quá lớn (> 5MB): bị từ chối với HTTP 413 hoặc lỗi giới hạn', async () => {
    const student = await createTestStudent();
    // Tạo buffer 5.5MB
    const largeBuffer = Buffer.alloc(5.5 * 1024 * 1024, 0xff);

    const formData = new FormData();
    const blob = new Blob([largeBuffer], { type: 'image/jpeg' });
    formData.append('photo', blob, 'large_image.jpg');

    const res = await fetch(`${API_BASE}/api/students/${student.id}/photo`, {
      method: 'POST',
      headers: { 'x-forwarded-for': `10.99.1.${student.id}` },
      body: formData,
    });

    // Fastify multipart từ chối với 413 FST_REQ_FILE_TOO_LARGE hoặc 400
    expect([413, 400]).toContain(res.status);

    // Học sinh trong DB không được chuyển thành pending
    const dbRes = await pool.query('SELECT status FROM students WHERE id = $1', [student.id]);
    expect(dbRes.rows[0].status).toBe('empty');
  });

  // 3. File hỏng/rác bị từ chối kèm mã lỗi của validator
  it('3. File hỏng/rác: bị từ chối kèm mã lỗi của validator (CORRUPTED_IMAGE hoặc UNSUPPORTED_FORMAT)', async () => {
    const student = await createTestStudent();
    const corruptedBuffer = Buffer.from('THIS_IS_NOT_A_VALID_IMAGE_DATA_CORRUPTED_BYTES_Antigravity_Test_T011');

    const formData = new FormData();
    const blob = new Blob([corruptedBuffer], { type: 'image/jpeg' });
    formData.append('photo', blob, 'corrupted.jpg');

    const res = await fetch(`${API_BASE}/api/students/${student.id}/photo`, {
      method: 'POST',
      headers: { 'x-forwarded-for': `10.99.1.${student.id}` },
      body: formData,
    });

    // API phải từ chối với mã HTTP 400
    expect(res.status).toBe(400);

    const body: any = await res.json();
    // Phải trả về mã lỗi cụ thể từ validator (CORRUPTED_IMAGE / UNSUPPORTED_FORMAT)
    expect(body.errorCode || body.code).toMatch(/CORRUPTED_IMAGE|UNSUPPORTED_FORMAT|INVALID_IMAGE/);
    expect(body.message).toBeDefined();

    // Học sinh trong DB phải giữ nguyên 'empty', không bị chuyển sang 'pending'
    const dbRes = await pool.query('SELECT status FROM students WHERE id = $1', [student.id]);
    expect(dbRes.rows[0].status).toBe('empty');
  });

  // 4. File HEIC hợp lệ: chấp nhận HTTP 200 và file lưu trên đĩa đã được convert sang JPEG
  it('4. File HEIC hợp lệ: chấp nhận HTTP 200 và file lưu trên đĩa là JPEG', async () => {
    const student = await createTestStudent();
    const heicFixturePath = path.resolve('tests/fixtures/sample_300x400.heic');
    const heicBuffer = fs.readFileSync(heicFixturePath);

    const formData = new FormData();
    const blob = new Blob([heicBuffer], { type: 'image/heic' });
    formData.append('photo', blob, 'iphone_photo.heic');

    const res = await fetch(`${API_BASE}/api/students/${student.id}/photo`, {
      method: 'POST',
      headers: { 'x-forwarded-for': `10.99.1.${student.id}` },
      body: formData,
    });

    expect(res.status).toBe(200);

    // Kiểm tra học sinh đã chuyển pending
    const dbRes = await pool.query('SELECT status, local_image_path FROM students WHERE id = $1', [student.id]);
    expect(dbRes.rows[0].status).toBe('pending');
    const localPath = dbRes.rows[0].local_image_path;
    expect(localPath).toBeTruthy();

    // Kiểm tra file trên đĩa trong container:
    // Chạy lệnh docker exec để đọc 3 byte đầu của file: JPEG bắt đầu bằng 0xFF 0xD8 0xFF
    const { execSync } = await import('node:child_process');
    const hexHeader = execSync(`docker exec thanh_giuse_api xxd -p -l 3 "${localPath}"`)
      .toString()
      .trim()
      .toLowerCase();

    // JPEG SOI marker là ffd8ff
    expect(hexHeader).toBe('ffd8ff');
  });
});
