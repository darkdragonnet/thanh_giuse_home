import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import fs from 'node:fs';
import FormData from 'form-data';
import { generateStudentQrToken } from '@thanh-giuse/shared-infra';

const { Pool } = pg;
const API_BASE = process.env.API_BASE || 'http://localhost:3000';
const DB_URL =
  process.env.DATABASE_URL ||
  'postgresql://postgres_user:super_secure_postgres_password_change_me@localhost:5432/thanh_giuse_db';

describe('US3 / Phần E & D: Narrowing Token Student Payload & Manual Review Claim Lock', () => {
  let pool: pg.Pool;
  let testClassId: number;
  const uniqueSuffix = Date.now().toString().slice(-6);
  const testClassCode = `TC_TOK_${uniqueSuffix}`;
  let testStudentId: number;
  let manualReviewStudentId: number;
  const testQrToken = generateStudentQrToken();
  const manualReviewQrToken = generateStudentQrToken();
  const testAliasId = `TEST_TOK_${uniqueSuffix}_001`;

  const FORBIDDEN_TOKEN_FIELDS = [
    'local_image_path',
    'person_id',
    'normalized_name',
    'cloud_alias_synced',
    'retry_count',
  ];

  beforeAll(async () => {
    pool = new Pool({ connectionString: DB_URL });

    // 1. Tạo lớp học test dùng-một-lần
    const clsRes = await pool.query(
      `INSERT INTO classes (code, name, token, is_locked)
       VALUES ($1, $2, $3, false)
       RETURNING id`,
      [testClassCode, `Lớp Test Token Payload ${testClassCode}`, `PIN_${uniqueSuffix}`]
    );
    testClassId = clsRes.rows[0].id;

    // 2. Tạo học sinh test dùng-một-lần có ĐẦY ĐỦ các trường nhạy cảm để kiểm chứng lọc payload token
    const stuRes = await pool.query(
      `INSERT INTO students (
        class_id, name, alias_id, qr_token, status, person_id,
        face_url, local_image_path, last_error_code, last_error_message, retry_count
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
      RETURNING id`,
      [
        testClassId,
        'TEST_ Học Sinh Token DTO',
        testAliasId,
        testQrToken,
        'empty',
        'TEST_PERSON_HANET_12345',
        'https://static.hanet.ai/face/employee/test/secret_token_face.jpg',
        '/app/uploads/test_token_sensitive_child.jpg',
        'NONE',
        'Không có lỗi',
        3,
      ]
    );
    testStudentId = stuRes.rows[0].id;

    // 3. Tạo học sinh test trạng thái manual_review để kiểm thử chốt chặn claim (Phần D)
    const mrRes = await pool.query(
      `INSERT INTO students (
        class_id, name, alias_id, qr_token, status, person_id,
        face_url, local_image_path, last_error_code, last_error_message, retry_count
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
      RETURNING id`,
      [
        testClassId,
        'TEST_ Học Sinh Chờ Duyệt',
        `TEST_MR_${uniqueSuffix}`,
        manualReviewQrToken,
        'manual_review',
        'TEST_PERSON_MR_999',
        null,
        '/app/uploads/test_mr.jpg',
        '-9006',
        'Ảnh mờ hoặc nghiêng, đang chờ Admin phê duyệt',
        1,
      ]
    );
    manualReviewStudentId = mrRes.rows[0].id;
  });

  afterAll(async () => {
    if (testClassId) {
      await pool.query('DELETE FROM logs WHERE class_id = $1', [testClassId]);
      await pool.query('DELETE FROM students WHERE class_id = $1', [testClassId]);
      await pool.query('DELETE FROM classes WHERE id = $1', [testClassId]);
    }
    await pool.end();
  });

  it('1. GET /api/students/token/:qrToken: TUYỆT ĐỐI KHÔNG chứa 5 trường nội bộ (local_image_path, person_id, normalized_name, cloud_alias_synced, retry_count)', async () => {
    const res = await fetch(`${API_BASE}/api/students/token/${testQrToken}`);
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.student).toBeDefined();

    const student = body.student;

    // 5 trường cấm tối thiểu theo yêu cầu đề bài
    for (const field of FORBIDDEN_TOKEN_FIELDS) {
      expect(student).not.toHaveProperty(field);
    }

    // Các trường hợp lệ phục vụ giao diện cá nhân
    expect(student.id).toBe(testStudentId);
    expect(student.name).toBe('TEST_ Học Sinh Token DTO');
    expect(student.status).toBe('empty');
    expect(student.alias_id).toBe(testAliasId);
    expect(student.qr_token).toBeDefined();
    // face_url được giữ lại để học sinh xem ảnh chân dung đã đăng ký của chính mình
    expect(student.face_url).toBe('https://static.hanet.ai/face/employee/test/secret_token_face.jpg');

    // classInfo hợp lệ
    expect(body.classInfo).toBeDefined();
    expect(body.classInfo.code).toBe(testClassCode);
  });

  it('2. GET /api/students/token/:qrToken: token không tồn tại trả về HTTP 404', async () => {
    const res = await fetch(`${API_BASE}/api/students/token/NON_EXISTENT_QR_TOKEN_XYZ_123456`);
    expect(res.status).toBe(404);

    const body = await res.json();
    expect(body.error).toBe('Not Found');
  });

  it('3. Phần D Chốt chặn claim: Học sinh ở trạng thái manual_review KHÔNG thể tự nộp lại ảnh (trả về HTTP 409 Conflict)', async () => {
    const validJpeg = fs.readFileSync('tests/fixtures/sample_face.jpg');

    // 3.1 Nộp qua endpoint lớp /api/students/:id/photo
    const formClass = new FormData();
    formClass.append('file', validJpeg, {
      filename: 'test_photo.jpg',
      contentType: 'image/jpeg',
    });

    const resClass = await fetch(`${API_BASE}/api/students/${manualReviewStudentId}/photo`, {
      method: 'POST',
      headers: formClass.getHeaders(),
      body: formClass.getBuffer(),
    });

    // Bắt buộc 409 Conflict
    expect(resClass.status).toBe(409);

    // 3.2 Nộp qua endpoint token /api/students/token/:qrToken/photo
    const formToken = new FormData();
    formToken.append('file', validJpeg, {
      filename: 'test_photo.jpg',
      contentType: 'image/jpeg',
    });

    const resToken = await fetch(`${API_BASE}/api/students/token/${manualReviewQrToken}/photo`, {
      method: 'POST',
      headers: formToken.getHeaders(),
      body: formToken.getBuffer(),
    });

    expect(resToken.status).toBe(409);

    // Xác nhận trạng thái trong CSDL vẫn là manual_review, không bị chuyển bừa sang pending
    const checkDb = await pool.query('SELECT status FROM students WHERE id = $1', [manualReviewStudentId]);
    expect(checkDb.rows[0].status).toBe('manual_review');
  });
});
