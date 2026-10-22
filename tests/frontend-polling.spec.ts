import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { Queue } from 'bullmq';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const { Pool } = pg;
const API_BASE = process.env.API_BASE || 'http://localhost:3000';
const DB_URL =
  process.env.DATABASE_URL ||
  'postgresql://postgres_user:super_secure_postgres_password_change_me@localhost:5432/thanh_giuse_db';
const REDIS_HOST = process.env.REDIS_HOST || 'localhost';
const REDIS_PORT = Number(process.env.REDIS_PORT) || 6379;
const REDIS_PASSWORD = process.env.REDIS_PASSWORD || 'super_secure_redis_password_change_me';

describe('US3 (T023/T024/T025): Endpoint Trạng Thái, Công Thức Hàng Đợi & Polling Frontend', () => {
  let pool: pg.Pool;
  let queue: Queue;
  let testClassId: number;
  const uniqueSuffix = Date.now().toString().slice(-6);
  const testClassCode = `TC_POL_${uniqueSuffix}`;

  let studentPending1Id: number;
  let studentPending2Id: number;
  let studentSuccessId: number;
  let studentEmptyId: number;
  let studentManualReviewId: number;

  const aliasPending1 = `TEST_POL_${uniqueSuffix}_001`;
  const aliasPending2 = `TEST_POL_${uniqueSuffix}_002`;
  const aliasSuccess = `TEST_POL_${uniqueSuffix}_003`;
  const aliasEmpty = `TEST_POL_${uniqueSuffix}_004`;
  const aliasMR = `TEST_POL_${uniqueSuffix}_005`;

  const FORBIDDEN_STATUS_FIELDS = [
    'qr_token',
    'face_url',
    'local_image_path',
    'person_id',
    'normalized_name',
    'cloud_alias_synced',
  ];

  beforeAll(async () => {
    pool = new Pool({ connectionString: DB_URL });
    queue = new Queue('registration_queue', {
      connection: {
        host: REDIS_HOST,
        port: REDIS_PORT,
        password: REDIS_PASSWORD,
      },
    });

    // 1. Tạo lớp học test
    const clsRes = await pool.query(
      `INSERT INTO classes (code, name, token, is_locked)
       VALUES ($1, $2, $3, false)
       RETURNING id`,
      [testClassCode, `Lớp Test Polling ${testClassCode}`, `PIN_POL_${uniqueSuffix}`]
    );
    testClassId = clsRes.rows[0].id;

    // 2. Tạo học sinh pending 1 (cũ hơn)
    const p1Res = await pool.query(
      `INSERT INTO students (
        class_id, name, alias_id, status, person_id,
        face_url, local_image_path, updated_at
      ) VALUES ($1, $2, $3, 'pending', 'P_POL_1', 'https://static.hanet.ai/face/1.jpg', '/app/uploads/p1.jpg', NOW() - INTERVAL '10 seconds')
      RETURNING id`,
      [testClassId, 'TEST_ Học Sinh Chờ 1', aliasPending1]
    );
    studentPending1Id = p1Res.rows[0].id;

    // 3. Tạo học sinh pending 2 (mới hơn)
    const p2Res = await pool.query(
      `INSERT INTO students (
        class_id, name, alias_id, status, person_id,
        face_url, local_image_path, updated_at
      ) VALUES ($1, $2, $3, 'pending', 'P_POL_2', 'https://static.hanet.ai/face/2.jpg', '/app/uploads/p2.jpg', NOW())
      RETURNING id`,
      [testClassId, 'TEST_ Học Sinh Chờ 2', aliasPending2]
    );
    studentPending2Id = p2Res.rows[0].id;

    // 4. Tạo học sinh success
    const sRes = await pool.query(
      `INSERT INTO students (
        class_id, name, alias_id, status, person_id,
        face_url, local_image_path
      ) VALUES ($1, $2, $3, 'success', 'P_POL_3', 'https://static.hanet.ai/face/3.jpg', '/app/uploads/s.jpg')
      RETURNING id`,
      [testClassId, 'TEST_ Học Sinh Xong', aliasSuccess]
    );
    studentSuccessId = sRes.rows[0].id;

    // 5. Tạo học sinh empty
    const eRes = await pool.query(
      `INSERT INTO students (
        class_id, name, alias_id, status
      ) VALUES ($1, $2, $3, 'empty')
      RETURNING id`,
      [testClassId, 'TEST_ Học Sinh Chưa Nộp', aliasEmpty]
    );
    studentEmptyId = eRes.rows[0].id;

    // 6. Tạo học sinh manual_review
    const mrRes = await pool.query(
      `INSERT INTO students (
        class_id, name, alias_id, status, last_error_message
      ) VALUES ($1, $2, $3, 'manual_review', 'Cần quản trị viên phê duyệt hồ sơ')
      RETURNING id`,
      [testClassId, 'TEST_ Học Sinh Cần Duyệt', aliasMR]
    );
    studentManualReviewId = mrRes.rows[0].id;
  });

  afterAll(async () => {
    // Dọn dẹp BullMQ test jobs
    try {
      const jobs = await queue.getJobs(['waiting', 'active', 'delayed']);
      for (const j of jobs) {
        if (j.id && j.id.includes(uniqueSuffix)) {
          await j.remove();
        }
      }
    } catch {}

    await queue.close();

    // Dọn dẹp DB
    if (testClassId) {
      await pool.query('DELETE FROM logs WHERE class_id = $1', [testClassId]);
      await pool.query('DELETE FROM students WHERE class_id = $1', [testClassId]);
      await pool.query('DELETE FROM classes WHERE id = $1', [testClassId]);
    }
    await pool.end();
  });

  describe('1. Endpoint GET /api/students/:id/status & Công Thức Hàng Đợi (T024)', () => {
    it('1.1. Học sinh pending có job: trả queue_position đúng công thức, estimated_wait_minutes làm tròn lên', async () => {
      // Tạm dừng queue để worker không nuốt job ngay lập tức trong quá trình kiểm thử vị trí
      await queue.pause();
      try {
        // Đẩy job của student 1 vào BullMQ với priority = 5
        const jobId1 = `student_${aliasPending1}`;
        await queue.add(
          'register',
          {
            studentId: studentPending1Id,
            aliasId: aliasPending1,
            studentName: 'TEST_ Học Sinh Chờ 1',
            classCode: testClassCode,
          },
          {
            jobId: jobId1,
            priority: 5,
          }
        );

        const res1 = await fetch(`${API_BASE}/api/students/${studentPending1Id}/status`);
        expect(res1.status).toBe(200);

        const data1 = await res1.json();
        expect(data1.id).toBe(studentPending1Id);
        expect(data1.status).toBe('pending');
        expect(typeof data1.queue_position).toBe('number');
        expect(data1.queue_position).toBeGreaterThanOrEqual(1);
        expect(typeof data1.estimated_wait_minutes).toBe('number');
        expect(data1.estimated_wait_minutes).toBeGreaterThanOrEqual(1);
        expect(data1.message).toContain('Đang xếp hàng');

        // 1.2. Thêm job của giáo viên (priority 1) chen hàng hợp lệ -> position của student 1 tăng lên
        const initialPos = data1.queue_position;
        const teacherJobId = `teacher_override_TEST_${uniqueSuffix}_GV`;
        await queue.add(
          'override-photo',
          {
            studentId: 999999,
            aliasId: `TEST_GV_${uniqueSuffix}`,
            studentName: 'TEST_ Teacher Override',
            classCode: testClassCode,
          },
          {
            jobId: teacherJobId,
            priority: 1, // Giáo viên ưu tiên cao hơn
          }
        );

        const res2 = await fetch(`${API_BASE}/api/students/${studentPending1Id}/status`);
        expect(res2.status).toBe(200);
        const data2 = await res2.json();

        // Vị trí phải tăng thêm ít nhất 1 do job giáo viên chen trước
        expect(data2.queue_position).toBe(initialPos + 1);
        expect(data2.estimated_wait_minutes).toBe(Math.ceil((initialPos + 1) / 1)); // sync_rate_limit = 1
      } finally {
        await queue.resume();
      }
    });

    it('1.3. Fallback CSDL: khi không tìm thấy job trong BullMQ, tính position theo số pending có updated_at sớm hơn', async () => {
      // studentPending2Id không có job trong BullMQ
      const res = await fetch(`${API_BASE}/api/students/${studentPending2Id}/status`);
      expect(res.status).toBe(200);

      const data = await res.json();
      expect(data.id).toBe(studentPending2Id);
      expect(data.status).toBe('pending');
      // studentPending2 có updated_at muộn hơn studentPending1, nên vị trí phải >= 2
      expect(data.queue_position).toBeGreaterThanOrEqual(2);
      expect(data.estimated_wait_minutes).toBe(Math.ceil(data.queue_position / 1));
    });
  });

  describe('2. Trạng thái không pending (success, empty, manual_review) & Không lỗi 500', () => {
    it('2.1. Học sinh status="success": trả đúng contract, queue_position là null', async () => {
      const res = await fetch(`${API_BASE}/api/students/${studentSuccessId}/status`);
      expect(res.status).toBe(200);

      const data = await res.json();
      expect(data.id).toBe(studentSuccessId);
      expect(data.status).toBe('success');
      expect(data.queue_position).toBeNull();
      expect(data.estimated_wait_minutes).toBeNull();
    });

    it('2.2. Học sinh status="empty": trả đúng contract, queue_position là null', async () => {
      const res = await fetch(`${API_BASE}/api/students/${studentEmptyId}/status`);
      expect(res.status).toBe(200);

      const data = await res.json();
      expect(data.id).toBe(studentEmptyId);
      expect(data.status).toBe('empty');
      expect(data.queue_position).toBeNull();
      expect(data.estimated_wait_minutes).toBeNull();
    });

    it('2.3. Học sinh status="manual_review": trả đúng contract kèm last_error_message', async () => {
      const res = await fetch(`${API_BASE}/api/students/${studentManualReviewId}/status`);
      expect(res.status).toBe(200);

      const data = await res.json();
      expect(data.id).toBe(studentManualReviewId);
      expect(data.status).toBe('manual_review');
      expect(data.queue_position).toBeNull();
      expect(data.last_error_message).toContain('quản trị viên');
    });

    it('2.4. Tra cứu học sinh không tồn tại: trả HTTP 404', async () => {
      const res = await fetch(`${API_BASE}/api/students/99999999/status`);
      expect(res.status).toBe(404);
    });
  });

  describe('3. Tính Riêng Tư & Bảo Mật Payload Endpoint Status', () => {
    it('3.1. Response status TUYỆT ĐỐI KHÔNG chứa thông tin nhạy cảm (qr_token, face_url, local_image_path, person_id)', async () => {
      const res = await fetch(`${API_BASE}/api/students/${studentPending1Id}/status`);
      expect(res.status).toBe(200);

      const data = await res.json();
      for (const field of FORBIDDEN_STATUS_FIELDS) {
        expect(data).not.toHaveProperty(field);
      }
      expect(data.id).toBe(studentPending1Id);
    });
  });

  describe('4. T025: Khẳng Định Logic Polling và Giao Diện Trong Hai Bản HTML Portal', () => {
    const studentHtmlPath = path.resolve('apps/student/index.html');
    const apiPublicHtmlPath = path.resolve('apps/api/public/index.html');

    it('4.1. Cả hai bản HTML tồn tại và có mã băm MD5 TRÙNG NHAU 100%', () => {
      expect(fs.existsSync(studentHtmlPath)).toBe(true);
      expect(fs.existsSync(apiPublicHtmlPath)).toBe(true);

      const content1 = fs.readFileSync(studentHtmlPath);
      const content2 = fs.readFileSync(apiPublicHtmlPath);

      const md5_1 = crypto.createHash('md5').update(content1).digest('hex');
      const md5_2 = crypto.createHash('md5').update(content2).digest('hex');

      expect(md5_1).toBe(md5_2);
    });

    it('4.2. Logic Polling: ĐÃ BỎ giới hạn 100 lần (pollingCount > 100) và poll tiếp tục khi tab hiển thị', () => {
      const html = fs.readFileSync(studentHtmlPath, 'utf8');

      // Không còn trần tự dừng sau 100 lần poll / 5 phút
      expect(html).not.toMatch(/pollingCount\s*>\s*100/);

      // Vẫn giữ nguyên cơ chế tạm dừng khi tab ẩn để tiết kiệm tài nguyên
      expect(html).toContain('document.hidden');
      expect(html).toMatch(/3000/); // Chu kỳ short polling 3 giây
    });

    it('4.3. Logic Polling: Gọi endpoint status theo từng học sinh pending thay vì tải lại toàn bộ lớp', () => {
      const html = fs.readFileSync(studentHtmlPath, 'utf8');

      // Có lệnh fetch tới endpoint /api/students/.../status
      expect(html).toMatch(/\/api\/students\/.*\/status/);
    });

    it('4.4. Trạng thái đầy đủ: failed_quota_exceeded, conflict_pending_review, synced không bị rơi về empty', () => {
      const html = fs.readFileSync(studentHtmlPath, 'utf8');

      expect(html).toContain('failed_quota_exceeded');
      expect(html).toContain('conflict_pending_review');
      expect(html).toContain('synced');
    });

    it('4.5. Phần D: manual_review KHÔNG hiện nút "Nộp lại ảnh khác"', () => {
      const html = fs.readFileSync(studentHtmlPath, 'utf8');

      // Kiểm tra trạng thái manual_review không chứa text kích hoạt nộp lại
      const manualReviewBlockMatch = html.match(/manual_review:\s*\{[\s\S]*?\}/);
      expect(manualReviewBlockMatch).not.toBeNull();
      const block = manualReviewBlockMatch![0];
      expect(block).not.toContain('Nộp lại ảnh khác');
      expect(block).toContain('disabled: true');
    });
  });
});
