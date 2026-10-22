import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';

const { Pool } = pg;
const API_BASE = process.env.API_BASE || 'http://localhost:3000';
const DB_URL =
  process.env.DATABASE_URL ||
  'postgresql://postgres_user:super_secure_postgres_password_change_me@localhost:5432/thanh_giuse_db';

describe('T020: Teacher Authorization & Rate-Limit Bypass (US2 Independent Test)', () => {
  let pool: pg.Pool;
  let testClassId: number;
  const uniqueClassCode = `TC_${Date.now().toString().slice(-6)}`;
  const validTeacherPin = `PIN_SECRET_${Date.now()}`;
  let testStudentIds: number[] = [];
  const jpegBuffer = fs.readFileSync(path.resolve('tests/fixtures/sample_face.jpg'));
  const sharedBatchIp = `192.168.200.${Math.floor(Math.random() * 200) + 10}`;

  beforeAll(async () => {
    pool = new Pool({ connectionString: DB_URL });

    // 1. Tạo một lớp học test dùng-một-lần có PIN bí mật riêng
    const clsRes = await pool.query(
      `INSERT INTO classes (code, name, token, is_locked)
       VALUES ($1, $2, $3, false)
       RETURNING id`,
      [uniqueClassCode, `Lớp Test Batch ${uniqueClassCode}`, validTeacherPin]
    );
    testClassId = clsRes.rows[0].id;

    // 2. Tạo 30 học sinh test dùng-một-lần ở trạng thái 'empty'
    for (let i = 1; i <= 30; i++) {
      const aliasId = `TB_${uniqueClassCode.slice(-2)}_${i.toString().padStart(4, '0')}`;
      const name = `Học sinh Test Batch ${i}`;
      const stuRes = await pool.query(
        `INSERT INTO students (class_id, name, alias_id, status)
         VALUES ($1, $2, $3, 'empty')
         RETURNING id`,
        [testClassId, name, aliasId]
      );
      testStudentIds.push(stuRes.rows[0].id);
    }
  });

  afterAll(async () => {
    // Dọn dẹp sạch sẽ toàn bộ học sinh và lớp test (KHÔNG đụng vào 58 lớp và 196 học sinh thật)
    if (testStudentIds.length > 0) {
      await pool.query('DELETE FROM logs WHERE class_id = $1', [testClassId]);
      await pool.query('DELETE FROM students WHERE class_id = $1', [testClassId]);
    }
    if (testClassId) {
      await pool.query('DELETE FROM classes WHERE id = $1', [testClassId]);
    }
    await pool.end();
  });

  function sendPhoto(studentId: number, pin?: string, ip?: string) {
    const formData = new FormData();
    const blob = new Blob([jpegBuffer], { type: 'image/jpeg' });
    formData.append('photo', blob, 'sample_face.jpg');

    const headers: Record<string, string> = {
      'x-forwarded-for': ip || sharedBatchIp,
    };
    if (pin) {
      headers['x-teacher-pin'] = pin;
    }

    return fetch(`${API_BASE}/api/students/${studentId}/photo`, {
      method: 'POST',
      headers,
      body: formData,
    });
  }

  // 1. Test chính US2: Gửi 30 ảnh liên tục từ CÙNG 1 IP kèm PIN giáo viên hợp lệ
  it('Bắn liên tiếp 30 ảnh cho 30 học sinh từ CÙNG 1 IP kèm PIN hợp lệ: cả 30 đều HTTP 200, không bị lỗi 429', async () => {
    expect(testStudentIds.length).toBe(30);

    const results: { id: number; status: number }[] = [];

    // Gửi tuần tự liên tục 30 request (mô phỏng giáo viên chụp từng em trong 1 buổi)
    for (const studentId of testStudentIds) {
      const res = await sendPhoto(studentId, validTeacherPin, sharedBatchIp);
      results.push({ id: studentId, status: res.status });
    }

    // Khẳng định toàn bộ 30 request đều thành công HTTP 200
    const failed429 = results.filter((r) => r.status === 429);
    expect(failed429.length).toBe(0);

    const success200 = results.filter((r) => r.status === 200);
    expect(success200.length).toBe(30);

    // Kiểm tra DB: Tất cả 30 học sinh đều đã chuyển sang 'pending'
    const dbRes = await pool.query(
      'SELECT COUNT(*)::int as count FROM students WHERE class_id = $1 AND status = $2',
      [testClassId, 'pending']
    );
    expect(dbRes.rows[0].count).toBe(30);
  });

  // 2. Ca đối chứng: PIN SAI
  describe('Ca đối chứng khi dùng PIN SAI', () => {
    it('PIN SAI: Không được miễn trừ quyền override cho học sinh đã success → Bị từ chối với HTTP 409 Conflict', async () => {
      // Đổi trạng thái 1 học sinh test sang success
      const targetId = testStudentIds[0];
      await pool.query("UPDATE students SET status = 'success' WHERE id = $1", [targetId]);

      // Nộp lại với PIN SAI
      const res = await sendPhoto(targetId, 'WRONG_PIN_INCORRECT_999', '192.168.201.99');
      expect(res.status).toBe(409);

      const body: any = await res.json();
      expect(body.error || body.message).toMatch(/Conflict|đã được đăng ký/);
    });

    it('PIN SAI: Bị tính vào giới hạn học sinh (Student Rate Limit: quá 3 lần/15 phút bị chặn 429)', async () => {
      // Tạo thêm 1 học sinh test riêng để kiểm tra rate limit khi sai PIN
      const tempRes = await pool.query(
        `INSERT INTO students (class_id, name, alias_id, status)
         VALUES ($1, $2, $3, 'error')
         RETURNING id`,
        [testClassId, 'Rate Limit Test Student', `TB_${uniqueClassCode.slice(-2)}_RATE`]
      );
      const rateStudentId = tempRes.rows[0].id;
      testStudentIds.push(rateStudentId);

      const dedicatedIp = `192.168.202.${Math.floor(Math.random() * 200) + 10}`;

      // Gửi 3 lần đầu với PIN SAI (chấp nhận vì status='error' -> chuyển pending -> nộp lại pending trả 409)
      await sendPhoto(rateStudentId, 'WRONG_PIN_1', dedicatedIp);
      await sendPhoto(rateStudentId, 'WRONG_PIN_1', dedicatedIp);
      await sendPhoto(rateStudentId, 'WRONG_PIN_1', dedicatedIp);

      // Lần thứ 4 gửi với PIN SAI -> Chạm trần 3 req/15 phút của học sinh -> Bị trả 429
      const res4 = await sendPhoto(rateStudentId, 'WRONG_PIN_1', dedicatedIp);
      expect(res4.status).toBe(429);
      const body4: any = await res4.json();
      expect(body4.errorCode || body4.message).toMatch(/STUDENT_RATE_LIMIT_EXCEEDED|15 phút/);
    });
  });
});
