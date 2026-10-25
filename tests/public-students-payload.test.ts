import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { generateStudentQrToken } from '@thanh-giuse/shared-infra';

const { Pool } = pg;
const API_BASE = process.env.API_BASE || 'http://localhost:3000';
const DB_URL =
  process.env.DATABASE_URL ||
  'postgresql://postgres_user:super_secure_postgres_password_change_me@localhost:5432/thanh_giuse_db';

describe('P0 Security: Narrowing Public Payload of Class Students Endpoint', () => {
  let pool: pg.Pool;
  let testClassId: number;
  const uniqueSuffix = Date.now().toString().slice(-6);
  const testClassCode = `TC_${uniqueSuffix}`;
  const validTeacherPin = `PIN_TEST_${uniqueSuffix}`;
  let testStudentId: number;
  const testAliasId = `TEST_${uniqueSuffix}_001`;

  const FORBIDDEN_PUBLIC_FIELDS = [
    'qr_token',
    'face_url',
    'local_image_path',
    'person_id',
    'last_error_code',
    'last_error_message',
    'normalized_name',
    'cloud_alias_synced',
    'is_updating',
    'retry_count',
  ];

  beforeAll(async () => {
    pool = new Pool({ connectionString: DB_URL });

    // 1. Tạo lớp học test dùng-một-lần có PIN giáo viên bí mật
    const clsRes = await pool.query(
      `INSERT INTO classes (code, name, token, is_locked)
       VALUES ($1, $2, $3, false)
       RETURNING id`,
      [testClassCode, `Lớp Test Privacy ${testClassCode}`, validTeacherPin]
    );
    testClassId = clsRes.rows[0].id;

    // 2. Tạo học sinh test dùng-một-lần với ĐẦY ĐỦ các trường nhạy cảm để kiểm chứng lọc payload
    const stuRes = await pool.query(
      `INSERT INTO students (
        class_id, name, alias_id, qr_token, status, person_id,
        face_url, local_image_path, last_error_code, last_error_message, retry_count
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
      RETURNING id`,
      [
        testClassId,
        'TEST_ Học Sinh Nhạy Cảm',
        testAliasId,
        generateStudentQrToken(),
        'error',
        'TEST_PERSON_998877',
        'https://static.hanet.ai/face/employee/test/secret_child_face.jpg',
        '/app/uploads/test_sensitive_child.jpg',
        'FACE_ANGLE_TOO_LARGE',
        'Khuôn mặt nghiêng quá 30 độ so với khung hình',
        2,
      ]
    );
    testStudentId = stuRes.rows[0].id;
  });

  afterAll(async () => {
    // Dọn dẹp sạch sẽ toàn bộ dữ liệu test dùng-một-lần
    if (testClassId) {
      await pool.query('DELETE FROM logs WHERE class_id = $1', [testClassId]);
      await pool.query('DELETE FROM students WHERE class_id = $1', [testClassId]);
      await pool.query('DELETE FROM classes WHERE id = $1', [testClassId]);
    }
    await pool.end();
  });

  it('1. Gọi công khai (KHÔNG có Teacher PIN): KHÔNG chứa bất kỳ trường nhạy cảm nào, VẪN chứa đủ trường tối thiểu', async () => {
    const res = await fetch(`${API_BASE}/api/classes/${testClassCode}/students`);
    expect(res.status).toBe(200);
    expect(res.headers.get('x-teacher-verified')).toBe('false');

    const students = await res.json();
    expect(Array.isArray(students)).toBe(true);

    const testStudent = students.find((s: any) => s.id === testStudentId);
    expect(testStudent).toBeDefined();

    // Khẳng định 10 trường bị cấm TUYỆT ĐỐI không có trong response công khai
    for (const field of FORBIDDEN_PUBLIC_FIELDS) {
      expect(testStudent).not.toHaveProperty(field);
    }

    // Khẳng định các trường cần thiết cho portal hiển thị danh sách
    expect(testStudent.id).toBe(testStudentId);
    expect(testStudent.name).toBe('TEST_ Học Sinh Nhạy Cảm');
    expect(testStudent.status).toBe('error');
    expect(testStudent.alias_id).toBe(testAliasId);
  });

  it('2. Gọi với Teacher PIN SAI: Vẫn chỉ trả DTO công khai tối thiểu, KHÔNG cấp quyền xem thêm trường giáo viên', async () => {
    const res = await fetch(`${API_BASE}/api/classes/${testClassCode}/students`, {
      headers: {
        'x-teacher-pin': 'WRONG_INCORRECT_PIN_9999',
      },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('x-teacher-verified')).toBe('false');

    const students = await res.json();
    const testStudent = students.find((s: any) => s.id === testStudentId);
    expect(testStudent).toBeDefined();

    for (const field of FORBIDDEN_PUBLIC_FIELDS) {
      expect(testStudent).not.toHaveProperty(field);
    }
  });

  it('3. Gọi với Teacher PIN HỢP LỆ (qua header x-teacher-pin): Nhận thêm các trường nghiệp vụ giáo viên, nhưng TUYỆT ĐỐI KHÔNG lộ qr_token hay person_id', async () => {
    const res = await fetch(`${API_BASE}/api/classes/${testClassCode}/students`, {
      headers: {
        'x-teacher-pin': validTeacherPin,
      },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('x-teacher-verified')).toBe('true');

    const students = await res.json();
    const testStudent = students.find((s: any) => s.id === testStudentId);
    expect(testStudent).toBeDefined();

    // Giáo viên được nhận các trường phục vụ chụp ảnh & kiểm tra lỗi
    expect(testStudent).toHaveProperty('last_error_code', 'FACE_ANGLE_TOO_LARGE');
    expect(testStudent).toHaveProperty('last_error_message', 'Khuôn mặt nghiêng quá 30 độ so với khung hình');
    expect(testStudent).toHaveProperty('is_updating');

    // Giáo viên có PIN hợp lệ được nhận thêm ảnh học sinh (face_url, local_image_path)
    expect(testStudent).toHaveProperty('face_url', 'https://static.hanet.ai/face/employee/test/secret_child_face.jpg');
    expect(testStudent).toHaveProperty('local_image_path', '/app/uploads/test_sensitive_child.jpg');

    // Nhưng ngay cả Giáo viên cũng KHÔNG được lộ qr_token cá nhân, person_id, retry_count
    expect(testStudent).not.toHaveProperty('qr_token');
    expect(testStudent).not.toHaveProperty('person_id');
    expect(testStudent).not.toHaveProperty('cloud_alias_synced');
    expect(testStudent).not.toHaveProperty('retry_count');
    expect(testStudent).not.toHaveProperty('normalized_name');
  });

  it('4. Gọi với Teacher PIN HỢP LỆ (qua query param token): Nhận thêm các trường nghiệp vụ giáo viên tương tự header', async () => {
    const res = await fetch(`${API_BASE}/api/classes/${testClassCode}/students?token=${encodeURIComponent(validTeacherPin)}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('x-teacher-verified')).toBe('true');

    const students = await res.json();
    const testStudent = students.find((s: any) => s.id === testStudentId);
    expect(testStudent).toBeDefined();

    expect(testStudent).toHaveProperty('last_error_code', 'FACE_ANGLE_TOO_LARGE');
    expect(testStudent).toHaveProperty('last_error_message', 'Khuôn mặt nghiêng quá 30 độ so với khung hình');
    expect(testStudent).toHaveProperty('is_updating');
    expect(testStudent).toHaveProperty('face_url', 'https://static.hanet.ai/face/employee/test/secret_child_face.jpg');
    expect(testStudent).toHaveProperty('local_image_path', '/app/uploads/test_sensitive_child.jpg');
    expect(testStudent).not.toHaveProperty('qr_token');
    expect(testStudent).not.toHaveProperty('person_id');
  });

  it('5. Gọi theo numeric classId: Hoạt động đồng nhất chuẩn bảo mật như classCode', async () => {
    const resPublic = await fetch(`${API_BASE}/api/classes/${testClassId}/students`);
    expect(resPublic.status).toBe(200);
    const studentsPublic = await resPublic.json();
    const stuPublic = studentsPublic.find((s: any) => s.id === testStudentId);
    expect(stuPublic).toBeDefined();
    for (const field of FORBIDDEN_PUBLIC_FIELDS) {
      expect(stuPublic).not.toHaveProperty(field);
    }

    const resTeacher = await fetch(`${API_BASE}/api/classes/${testClassId}/students`, {
      headers: { 'x-teacher-pin': validTeacherPin },
    });
    expect(resTeacher.status).toBe(200);
    expect(resTeacher.headers.get('x-teacher-verified')).toBe('true');
    const studentsTeacher = await resTeacher.json();
    const stuTeacher = studentsTeacher.find((s: any) => s.id === testStudentId);
    expect(stuTeacher).toHaveProperty('last_error_code', 'FACE_ANGLE_TOO_LARGE');
    expect(stuTeacher).toHaveProperty('face_url', 'https://static.hanet.ai/face/employee/test/secret_child_face.jpg');
    expect(stuTeacher).toHaveProperty('local_image_path', '/app/uploads/test_sensitive_child.jpg');
    expect(stuTeacher).not.toHaveProperty('qr_token');
    expect(stuTeacher).not.toHaveProperty('person_id');
  });
});
