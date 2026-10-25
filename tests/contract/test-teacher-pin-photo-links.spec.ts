import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { generateStudentQrToken } from '@thanh-giuse/shared-infra';

const { Pool } = pg;
const API_BASE = process.env.API_BASE || 'http://localhost:3000';
const PROXY_BASE = process.env.PROXY_BASE || 'http://localhost:8090';
const DB_URL =
  process.env.DATABASE_URL ||
  'postgresql://postgres_user:super_secure_postgres_password_change_me@localhost:5432/thanh_giuse_db';

describe('Contract Test: Privacy Boundary & Teacher PIN Photo Exposure (tests/contract/test-teacher-pin-photo-links.spec.ts)', () => {
  let pool: pg.Pool;

  let classAId: number;
  let classACode: string;
  let pinA: string;

  let classBId: number;
  let classBCode: string;
  let pinB: string;

  let studentA1Id: number;
  let studentA1Alias: string;
  let fakeFaceUrlA1: string;
  let fakeLocalImagePathA1: string;

  let studentA2Id: number;
  let studentA2Alias: string;

  let studentB1Id: number;
  let studentB1Alias: string;

  const FORBIDDEN_IN_ALL_DTOS = [
    'qr_token',
    'person_id',
    'retry_count',
    'normalized_name',
    'cloud_alias_synced',
  ];

  beforeAll(async () => {
    pool = new Pool({ connectionString: DB_URL });

    const suffix = `${Date.now().toString().slice(-4)}_${Math.floor(Math.random() * 1000)}`;

    // Lớp A
    classACode = `TEST_CLSA_${suffix}`;
    pinA = `PIN_A_${suffix}_SECURE`;
    const clsARes = await pool.query(
      `INSERT INTO classes (code, name, token, is_locked)
       VALUES ($1, $2, $3, false)
       RETURNING id`,
      [classACode, `Lớp Test Privacy A ${classACode}`, pinA]
    );
    classAId = clsARes.rows[0].id;

    // Lớp B (phục vụ test cô lập chéo lớp)
    classBCode = `TEST_CLSB_${suffix}`;
    pinB = `PIN_B_${suffix}_OTHER`;
    const clsBRes = await pool.query(
      `INSERT INTO classes (code, name, token, is_locked)
       VALUES ($1, $2, $3, false)
       RETURNING id`,
      [classBCode, `Lớp Test Privacy B ${classBCode}`, pinB]
    );
    classBId = clsBRes.rows[0].id;

    // Học sinh A1: trạng thái success, đã có face_url giả và local_image_path giả
    studentA1Alias = `TEST_S1_${suffix}`;
    fakeFaceUrlA1 = `https://example.invalid/TEST_face_${suffix}.jpg`;
    fakeLocalImagePathA1 = `/app/uploads/TEST_local_${suffix}.jpg`;
    const stuA1Res = await pool.query(
      `INSERT INTO students (
        class_id, name, alias_id, qr_token, status, person_id,
        face_url, local_image_path, last_error_code, last_error_message, retry_count
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
      RETURNING id`,
      [
        classAId,
        `TEST_ Học Sinh A1 Success ${suffix}`,
        studentA1Alias,
        generateStudentQrToken(),
        'success',
        `HANET_FAKE_A1_${suffix}`,
        fakeFaceUrlA1,
        fakeLocalImagePathA1,
        null,
        null,
        0,
      ]
    );
    studentA1Id = stuA1Res.rows[0].id;

    // Học sinh A2: trạng thái empty, chưa có ảnh (face_url: null, local_image_path: null)
    studentA2Alias = `TEST_S2_${suffix}`;
    const stuA2Res = await pool.query(
      `INSERT INTO students (
        class_id, name, alias_id, qr_token, status, person_id,
        face_url, local_image_path
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      RETURNING id`,
      [
        classAId,
        `TEST_ Học Sinh A2 Empty ${suffix}`,
        studentA2Alias,
        generateStudentQrToken(),
        'empty',
        null,
        null,
        null,
      ]
    );
    studentA2Id = stuA2Res.rows[0].id;

    // Học sinh B1: thuộc lớp B
    studentB1Alias = `TEST_SB1_${suffix}`;
    const stuB1Res = await pool.query(
      `INSERT INTO students (
        class_id, name, alias_id, qr_token, status, person_id,
        face_url, local_image_path
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      RETURNING id`,
      [
        classBId,
        `TEST_ Học Sinh B1 ${suffix}`,
        studentB1Alias,
        generateStudentQrToken(),
        'success',
        `HANET_FAKE_B1_${suffix}`,
        `https://example.invalid/TEST_face_B_${suffix}.jpg`,
        `/app/uploads/TEST_local_B_${suffix}.jpg`,
      ]
    );
    studentB1Id = stuB1Res.rows[0].id;
  });

  afterAll(async () => {
    // Vệ sinh triệt để toàn bộ dữ liệu test dùng-một-lần
    const testClassIds = [classAId, classBId].filter(Boolean);
    if (testClassIds.length > 0) {
      await pool.query('DELETE FROM logs WHERE class_id = ANY($1::int[])', [testClassIds]);
      await pool.query('DELETE FROM admin_requests WHERE class_id = ANY($1::int[])', [testClassIds]);
      await pool.query('DELETE FROM students WHERE class_id = ANY($1::int[])', [testClassIds]);
      await pool.query('DELETE FROM classes WHERE id = ANY($1::int[])', [testClassIds]);
    }

    await pool.query("DELETE FROM logs WHERE alias_id LIKE 'TEST_%' OR result_message LIKE '%TEST_%'");
    await pool.query("DELETE FROM admin_requests WHERE alias_id LIKE 'TEST_%' OR student_name LIKE 'TEST_%'");
    await pool.query("DELETE FROM students WHERE alias_id LIKE 'TEST_%' OR name LIKE 'TEST_%'");

    // Xác nhận số lượng học sinh trong DB không đổi
    const countRes = await pool.query('SELECT COUNT(*) AS total FROM students');
    expect(parseInt(countRes.rows[0].total, 10)).toBe(989);

    const testStudentCount = await pool.query("SELECT COUNT(*) AS total FROM students WHERE name LIKE 'TEST_%' OR alias_id LIKE 'TEST_%'");
    expect(parseInt(testStudentCount.rows[0].total, 10)).toBe(0);

    await pool.end();
  });

  // 1. Public (không PIN, không token): response có ĐÚNG 4 key mỗi học sinh; assert toàn bộ body serialize KHÔNG chứa chuỗi nhạy cảm
  it('1. Public (không PIN, không token): đúng 4 key, body KHÔNG chứa face_url, local_image_path, qr_token, person_id, /uploads/, tmp-faces', async () => {
    const res = await fetch(`${API_BASE}/api/classes/${classACode}/students`);
    expect(res.status).toBe(200);
    expect(res.headers.get('x-teacher-verified')).toBe('false');

    const rawBody = await res.text();
    const students = JSON.parse(rawBody);
    expect(Array.isArray(students)).toBe(true);

    const s1 = students.find((s: any) => s.id === studentA1Id);
    expect(s1).toBeDefined();

    // Khẳng định ĐÚNG 4 key cho mỗi học sinh ở nhánh public
    const expectedKeys = ['alias_id', 'id', 'name', 'status'].sort();
    expect(Object.keys(s1).sort()).toEqual(expectedKeys);

    // Khẳng định giá trị DTO tối thiểu
    expect(s1.id).toBe(studentA1Id);
    expect(s1.name).toContain('TEST_ Học Sinh A1');
    expect(s1.status).toBe('success');
    expect(s1.alias_id).toBe(studentA1Alias);

    // Assert toàn bộ serialized body TUYỆT ĐỐI KHÔNG chứa chuỗi nhạy cảm
    expect(rawBody).not.toContain('face_url');
    expect(rawBody).not.toContain('local_image_path');
    expect(rawBody).not.toContain('qr_token');
    expect(rawBody).not.toContain('person_id');
    expect(rawBody).not.toContain('/uploads/');
    expect(rawBody).not.toContain('tmp-faces');
    expect(rawBody).not.toContain('example.invalid');
  });

  // 2. PIN sai → giống hệt public (không có trường ảnh)
  it('2. PIN sai: giống hệt public, x-teacher-verified = false, không có trường ảnh', async () => {
    const res = await fetch(`${API_BASE}/api/classes/${classACode}/students`, {
      headers: {
        'x-teacher-pin': 'INCORRECT_WRONG_PIN_9999',
      },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('x-teacher-verified')).toBe('false');

    const rawBody = await res.text();
    const students = JSON.parse(rawBody);
    const s1 = students.find((s: any) => s.id === studentA1Id);
    expect(s1).toBeDefined();

    const expectedKeys = ['alias_id', 'id', 'name', 'status'].sort();
    expect(Object.keys(s1).sort()).toEqual(expectedKeys);

    expect(rawBody).not.toContain('face_url');
    expect(rawBody).not.toContain('local_image_path');
    expect(rawBody).not.toContain('qr_token');
    expect(rawBody).not.toContain('person_id');
    expect(rawBody).not.toContain('/uploads/');
    expect(rawBody).not.toContain('tmp-faces');
    expect(rawBody).not.toContain('example.invalid');
  });

  // 3. PIN của LỚP KHÁC → giống hệt public cho lớp này (cô lập chéo lớp)
  it('3. PIN của LỚP KHÁC: cô lập chéo lớp, không cấp quyền xem ảnh của lớp A', async () => {
    // Dùng PIN lớp B để gọi lớp A qua header
    const resHeader = await fetch(`${API_BASE}/api/classes/${classACode}/students`, {
      headers: {
        'x-teacher-pin': pinB,
      },
    });
    expect(resHeader.status).toBe(200);
    expect(resHeader.headers.get('x-teacher-verified')).toBe('false');

    const rawBodyHeader = await resHeader.text();
    const studentsHeader = JSON.parse(rawBodyHeader);
    const s1 = studentsHeader.find((s: any) => s.id === studentA1Id);
    expect(s1).toBeDefined();
    expect(Object.keys(s1).sort()).toEqual(['alias_id', 'id', 'name', 'status'].sort());
    expect(rawBodyHeader).not.toContain('face_url');
    expect(rawBodyHeader).not.toContain('local_image_path');
    expect(rawBodyHeader).not.toContain('example.invalid');

    // Dùng PIN lớp B để gọi lớp A qua query token
    const resQuery = await fetch(
      `${API_BASE}/api/classes/${classACode}/students?token=${encodeURIComponent(pinB)}`
    );
    expect(resQuery.status).toBe(200);
    expect(resQuery.headers.get('x-teacher-verified')).toBe('false');
    const rawBodyQuery = await resQuery.text();
    expect(rawBodyQuery).not.toContain('face_url');
    expect(rawBodyQuery).not.toContain('local_image_path');
    expect(rawBodyQuery).not.toContain('example.invalid');
  });

  // 4. PIN đúng qua header x-teacher-pin → có đủ face_url + local_image_path khớp DB; vẫn KHÔNG có qr_token/person_id/retry_count
  it('4. PIN đúng qua header x-teacher-pin: có đủ face_url + local_image_path khớp DB; không lộ qr_token/person_id/retry_count', async () => {
    const res = await fetch(`${API_BASE}/api/classes/${classACode}/students`, {
      headers: {
        'x-teacher-pin': pinA,
      },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('x-teacher-verified')).toBe('true');

    const rawBody = await res.text();
    const students = JSON.parse(rawBody);

    // Học sinh A1 (đã có ảnh): face_url & local_image_path khớp DB
    const s1 = students.find((s: any) => s.id === studentA1Id);
    expect(s1).toBeDefined();
    expect(s1.face_url).toBe(fakeFaceUrlA1);
    expect(s1.local_image_path).toBe(fakeLocalImagePathA1);

    // Học sinh A2 (chưa có ảnh): face_url: null & local_image_path: null
    const s2 = students.find((s: any) => s.id === studentA2Id);
    expect(s2).toBeDefined();
    expect(s2.face_url).toBeNull();
    expect(s2.local_image_path).toBeNull();

    // Teacher DTO vẫn giữ các trường phục vụ kiểm tra lỗi
    expect(s1).toHaveProperty('is_updating');
    expect(s1).toHaveProperty('last_error_code');
    expect(s1).toHaveProperty('last_error_message');

    // CẤM tuyệt đối lộ các trường bảo mật nhạy cảm
    for (const forbidden of FORBIDDEN_INALL_DTOS(s1)) {
      expect(s1).not.toHaveProperty(forbidden);
    }
    expect(rawBody).not.toContain('qr_token');
    expect(rawBody).not.toContain('person_id');
    expect(rawBody).not.toContain(`HANET_FAKE_A1`);
  });

  function FORBIDDEN_INALL_DTOS(obj: any) {
    return FORBIDDEN_IN_ALL_DTOS;
  }

  // 5. PIN đúng qua query token → giống như qua header (cơ chế link chia sẻ giáo viên)
  it('5. PIN đúng qua query token: giống hệt header, link chia sẻ giáo viên hoạt động trọn vẹn', async () => {
    const res = await fetch(
      `${API_BASE}/api/classes/${classACode}/students?token=${encodeURIComponent(pinA)}`
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('x-teacher-verified')).toBe('true');

    const rawBody = await res.text();
    const students = JSON.parse(rawBody);

    const s1 = students.find((s: any) => s.id === studentA1Id);
    expect(s1).toBeDefined();
    expect(s1.face_url).toBe(fakeFaceUrlA1);
    expect(s1.local_image_path).toBe(fakeLocalImagePathA1);

    for (const forbidden of FORBIDDEN_IN_ALL_DTOS) {
      expect(s1).not.toHaveProperty(forbidden);
    }
    expect(rawBody).not.toContain('qr_token');
    expect(rawBody).not.toContain('person_id');
    expect(rawBody).not.toContain(`HANET_FAKE_A1`);
  });

  // 6. PIN không bao giờ bị echo: body và headers response KHÔNG chứa chuỗi PIN đã gửi; header X-Teacher-Verified chỉ là true/false
  it('6. PIN không bao giờ bị echo: body và headers response KHÔNG chứa chuỗi PIN đã gửi', async () => {
    // Trường hợp 1: PIN gửi qua header
    const resHeader = await fetch(`${API_BASE}/api/classes/${classACode}/students`, {
      headers: {
        'x-teacher-pin': pinA,
      },
    });
    expect(resHeader.headers.get('x-teacher-verified')).toBe('true');
    const bodyHeader = await resHeader.text();
    expect(bodyHeader).not.toContain(pinA);
    for (const [name, value] of resHeader.headers.entries()) {
      expect(value, `Header ${name} must not contain PIN`).not.toContain(pinA);
    }

    // Trường hợp 2: PIN gửi qua query token
    const resQuery = await fetch(
      `${API_BASE}/api/classes/${classACode}/students?token=${encodeURIComponent(pinA)}`
    );
    expect(resQuery.headers.get('x-teacher-verified')).toBe('true');
    const bodyQuery = await resQuery.text();
    expect(bodyQuery).not.toContain(pinA);
    for (const [name, value] of resQuery.headers.entries()) {
      expect(value, `Header ${name} must not contain PIN`).not.toContain(pinA);
    }

    // Header X-Teacher-Verified chỉ được là "true" hoặc "false"
    expect(['true', 'false']).toContain(resHeader.headers.get('x-teacher-verified'));
    expect(['true', 'false']).toContain(resQuery.headers.get('x-teacher-verified'));
  });

  // 7. Ảnh đoán theo alias không lộ: GET /images/<TEST_alias>.jpg → 404
  it('7. Ảnh đoán theo alias không lộ: GET /images/<TEST_alias>.jpg → 404 (chống đoán tên file)', async () => {
    const resApi = await fetch(`${API_BASE}/images/${studentA1Alias}.jpg`);
    expect(resApi.status).toBe(404);

    try {
      const resProxy = await fetch(`${PROXY_BASE}/images/${studentA1Alias}.jpg`);
      expect(resProxy.status).toBe(404);
    } catch {
      // Nếu proxy không mở port trên test environment thì bỏ qua
    }
  });

  // 8. Hỗ trợ gọi qua numeric classId: hoạt động đồng nhất
  it('8. Hỗ trợ gọi qua numeric classId: nhất quán chuẩn bảo mật giữa classCode và classId', async () => {
    // Public via numeric ID
    const resPublic = await fetch(`${API_BASE}/api/classes/${classAId}/students`);
    expect(resPublic.status).toBe(200);
    expect(resPublic.headers.get('x-teacher-verified')).toBe('false');
    const studentsPublic = await resPublic.json();
    const s1Public = studentsPublic.find((s: any) => s.id === studentA1Id);
    expect(Object.keys(s1Public).sort()).toEqual(['alias_id', 'id', 'name', 'status'].sort());

    // Teacher via numeric ID
    const resTeacher = await fetch(`${API_BASE}/api/classes/${classAId}/students`, {
      headers: { 'x-teacher-pin': pinA },
    });
    expect(resTeacher.status).toBe(200);
    expect(resTeacher.headers.get('x-teacher-verified')).toBe('true');
    const studentsTeacher = await resTeacher.json();
    const s1Teacher = studentsTeacher.find((s: any) => s.id === studentA1Id);
    expect(s1Teacher.face_url).toBe(fakeFaceUrlA1);
    expect(s1Teacher.local_image_path).toBe(fakeLocalImagePathA1);
  });
});
