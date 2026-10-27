import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';
import {
  StudentRepository,
  LogRepository,
  SettingsRepository,
  createDbPool,
  closeDbPool,
  generateStudentQrToken,
} from '@thanh-giuse/shared-infra';
import { HanetClient } from '@thanh-giuse/hanet-client';
import { evaluateHanetError } from '@thanh-giuse/error-mapping';
import { processRegistrationJob } from '../../apps/worker/src/processor.js';

const rawDbUrl =
  process.env.DATABASE_URL ||
  'postgresql://postgres_user:super_secure_postgres_password_change_me@localhost:5432/thanh_giuse_db';
const DB_URL = rawDbUrl.replace('@app_postgres:', '@localhost:').replace('@postgres:', '@localhost:');

describe('Regression Contract Tests: System Log Error Cases (-101, -5004, UPDATE_PHOTO_FAILED -1)', () => {
  let pool: pg.Pool;
  let studentRepo: StudentRepository;
  let logRepo: LogRepository;
  let settingsRepo: SettingsRepository;
  let hanetClient: HanetClient;

  let testClassId: number;
  let testClassCode: string;
  const createdStudentIds: number[] = [];
  const testImageFilename = 'test_sample_error_cases.jpg';
  const testImagePath = path.resolve('uploads', testImageFilename);

  beforeAll(async () => {
    pool = createDbPool({ connectionString: DB_URL });
    studentRepo = new StudentRepository(pool);
    logRepo = new LogRepository(pool);
    settingsRepo = new SettingsRepository(pool);

    // Tạo mã lớp 4 ký tự đúng chuẩn
    testClassCode = 'TERR';

    // Tạo lớp test riêng biệt
    const clsRes = await pool.query(
      `INSERT INTO classes (code, name, token, is_locked)
       VALUES ($1, $2, $3, false)
       RETURNING id`,
      [testClassCode, `Lớp Test Error Cases ${testClassCode}`, `PIN_${Date.now()}`]
    );
    testClassId = clsRes.rows[0].id;

    hanetClient = new HanetClient({
      baseUrl: 'http://localhost:4000',
      token: 'mock_token',
      placeId: '998577',
      timeoutMs: 10_000,
    });

    if (!fs.existsSync(path.resolve('uploads'))) {
      fs.mkdirSync(path.resolve('uploads'), { recursive: true });
    }
    const sampleSource = path.resolve('tests/fixtures/sample_face.jpg');
    fs.copyFileSync(sampleSource, testImagePath);
  });

  afterAll(async () => {
    // Dọn dẹp an toàn toàn bộ dữ liệu test
    try {
      if (createdStudentIds.length > 0) {
        await pool.query('DELETE FROM logs WHERE student_id = ANY($1::int[])', [createdStudentIds]);
        await pool.query('DELETE FROM students WHERE id = ANY($1::int[])', [createdStudentIds]);
      }
      await pool.query("DELETE FROM logs WHERE alias_id LIKE 'TEST_%' OR alias_id LIKE 'TERR_%'");
      await pool.query("DELETE FROM students WHERE alias_id LIKE 'TEST_%' OR alias_id LIKE 'TERR_%'");
      if (testClassId) {
        await pool.query('DELETE FROM classes WHERE id = $1', [testClassId]);
      }
    } catch {
      // ignore
    }

    if (fs.existsSync(testImagePath)) {
      try {
        fs.unlinkSync(testImagePath);
      } catch {
        // ignore
      }
    }

    await closeDbPool(pool);
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // TRƯỜNG HỢP 1: REGISTER lỗi -101 ("All devices in current place offline")
  // ═══════════════════════════════════════════════════════════════════════════
  it('1. REGISTER lỗi -101: Job kết thúc sạch, status="error", last_error_code="-101", audit log REGISTER/ERROR', async () => {
    const aliasId = 'TEST_101A'; // Khớp regex ^[A-Za-z]{2}[A-Za-z0-9]{2}_[A-Za-z0-9]{4}$ (9 ký tự)
    const qrToken = generateStudentQrToken();

    const baselineCountRes = await pool.query('SELECT COUNT(*)::int AS count FROM students');
    const baselineCount = baselineCountRes.rows[0].count;

    const studentRes = await pool.query(
      `INSERT INTO students (class_id, name, alias_id, qr_token, status, local_image_path)
       VALUES ($1, $2, $3, $4, 'pending', $5)
       RETURNING id, alias_id, name`,
      [testClassId, 'Học sinh Test Lỗi 101', aliasId, qrToken, testImagePath]
    );
    const testStudent = studentRes.rows[0];
    createdStudentIds.push(testStudent.id);

    // Mock HanetClient trả về -101 "All devices in current place offline"
    const mockHanet = {
      registerByUrl: async () => ({
        success: false,
        rawResponse: {
          returnCode: -101,
          returnMessage: 'All devices in current place offline',
          data: null,
        },
        evaluation: evaluateHanetError(-101, 'All devices in current place offline'),
      }),
      updateByFaceImageByPersonID: async () => {
        throw new Error('Should not be called');
      },
    } as unknown as HanetClient;

    const mockJob = {
      id: `student_${aliasId}`,
      data: {
        studentId: testStudent.id,
        aliasId,
        studentName: testStudent.name,
        classCode: testClassCode,
        tempFilename: testImageFilename,
        uploadedAt: Date.now(),
        actionType: 'REGISTER' as const,
      },
      opts: { attempts: 1 },
      attemptsMade: 0,
    } as any;

    // Thực thi processor - kỳ vọng kết thúc sạch (không crash, không ném exception)
    const result = await processRegistrationJob(mockJob, {
      studentRepo,
      logRepo,
      settingsRepo,
      hanetClient: mockHanet,
    });

    expect(result.success).toBe(false);

    // Kiểm tra trạng thái học sinh trong CSDL: status='error', last_error_code='-101'
    const updatedStudent = await studentRepo.findById(testStudent.id);
    expect(updatedStudent).toBeDefined();
    expect(updatedStudent?.status).toBe('error');
    expect(updatedStudent?.last_error_code).toBe('-101');
    expect(updatedStudent?.last_error_message).toContain('Đã xảy ra lỗi không xác định từ hệ thống nhận diện (-101)');

    // Kiểm tra audit log
    const logRes = await pool.query(
      `SELECT * FROM logs WHERE alias_id = $1 ORDER BY id DESC LIMIT 1`,
      [aliasId]
    );
    expect(logRes.rows.length).toBe(1);
    expect(logRes.rows[0].action).toBe('REGISTER');
    expect(logRes.rows[0].result_code).toBe('ERROR');
    expect(logRes.rows[0].result_message).toContain('(-101)');
    expect(logRes.rows[0].result_message).toContain('All devices in current place offline');

    // Tổng số học sinh chỉ tăng đúng 1 (bản ghi test vừa tạo), không ảnh hưởng học sinh khác
    const afterCountRes = await pool.query('SELECT COUNT(*)::int AS count FROM students');
    expect(afterCountRes.rows[0].count).toBe(baselineCount + 1);
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // TRƯỜNG HỢP 2: REGISTER lỗi -101 lặp lại trên cùng học sinh
  // ═══════════════════════════════════════════════════════════════════════════
  it('2. REGISTER lỗi -101 lặp lại: Idempotency Guard chặn job trùng khi chưa re-claim, và re-claim hợp lệ không nhân đôi student', async () => {
    const aliasId = 'TEST_101B';
    const qrToken = generateStudentQrToken();

    const studentRes = await pool.query(
      `INSERT INTO students (class_id, name, alias_id, qr_token, status, local_image_path)
       VALUES ($1, $2, $3, $4, 'pending', $5)
       RETURNING id, alias_id, name`,
      [testClassId, 'Học sinh Test Retry 101', aliasId, qrToken, testImagePath]
    );
    const testStudent = studentRes.rows[0];
    createdStudentIds.push(testStudent.id);

    let hanetCallCount = 0;
    const mockHanet = {
      registerByUrl: async () => {
        hanetCallCount++;
        return {
          success: false,
          rawResponse: {
            returnCode: -101,
            returnMessage: 'All devices in current place offline',
            data: null,
          },
          evaluation: evaluateHanetError(-101, 'All devices in current place offline'),
        };
      },
    } as unknown as HanetClient;

    const mockJob = {
      id: `student_${aliasId}`,
      data: {
        studentId: testStudent.id,
        aliasId,
        studentName: testStudent.name,
        classCode: testClassCode,
        tempFilename: testImageFilename,
        uploadedAt: Date.now(),
        actionType: 'REGISTER' as const,
      },
      opts: { attempts: 1 },
      attemptsMade: 0,
    } as any;

    // Lần 1: Gặp lỗi -101 từ HANET
    const res1 = await processRegistrationJob(mockJob, {
      studentRepo,
      logRepo,
      settingsRepo,
      hanetClient: mockHanet,
    });
    expect(res1.success).toBe(false);
    expect(hanetCallCount).toBe(1);

    // Kịch bản 2a: Job trùng lặp đẩy vào khi học sinh đang ở status="error" (chưa được re-claim)
    // Chốt chặn Idempotency Guard (T019) phải SKIP, không gọi lại HANET, không nhân đôi audit ERROR
    const resDuplicate = await processRegistrationJob(mockJob, {
      studentRepo,
      logRepo,
      settingsRepo,
      hanetClient: mockHanet,
    });
    expect(resDuplicate.success).toBe(true); // Trả về success: true để BullMQ gỡ job trùng khỏi queue
    expect(hanetCallCount).toBe(1); // Tuyệt đối không gọi thêm lần nào vào HANET!

    const dupLogRes = await pool.query(
      `SELECT * FROM logs WHERE alias_id = $1 AND result_code = 'SKIPPED_NON_PENDING_JOB'`,
      [aliasId]
    );
    expect(dupLogRes.rows.length).toBe(1);

    // Kịch bản 2b: Học sinh nộp lại hợp lệ (re-claim từ 'error' -> 'pending')
    const reclaimed = await studentRepo.claimStudentForClassRegister(testStudent.id, testImagePath);
    expect(reclaimed).not.toBeNull();
    expect(reclaimed?.status).toBe('pending');

    // Chạy lại job lần 2 sau khi re-claim hợp lệ
    const res2 = await processRegistrationJob(mockJob, {
      studentRepo,
      logRepo,
      settingsRepo,
      hanetClient: mockHanet,
    });
    expect(res2.success).toBe(false);
    expect(hanetCallCount).toBe(2);

    // Khẳng định: Tuyệt đối không tạo dòng học sinh trùng trong bảng students
    const studentCountRes = await pool.query(
      `SELECT COUNT(*)::int AS count FROM students WHERE alias_id = $1`,
      [aliasId]
    );
    expect(studentCountRes.rows[0].count).toBe(1);

    // Trạng thái cuối vẫn là error, last_error_code = '-101'
    const studentInDb = await studentRepo.findById(testStudent.id);
    expect(studentInDb?.status).toBe('error');
    expect(studentInDb?.last_error_code).toBe('-101');

    // Tổng số audit logs cho học sinh này:
    // - 2 dòng ERROR (ứng với 2 lần nộp thực tế khi pending)
    // - 1 dòng SKIPPED_NON_PENDING_JOB (khi job trùng được chặn)
    const errorLogsRes = await pool.query(
      `SELECT * FROM logs WHERE alias_id = $1 AND result_code = 'ERROR' ORDER BY id ASC`,
      [aliasId]
    );
    expect(errorLogsRes.rows.length).toBe(2);
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // TRƯỜNG HỢP 3: REGISTER lỗi -5004
  // ═══════════════════════════════════════════════════════════════════════════
  it('3. REGISTER lỗi -5004: Job kết thúc sạch, status="error", last_error_code="-5004", audit log REGISTER/ERROR', async () => {
    const aliasId = 'TEST_5004';
    const qrToken = generateStudentQrToken();

    const baselineCountRes = await pool.query('SELECT COUNT(*)::int AS count FROM students');
    const baselineCount = baselineCountRes.rows[0].count;

    const studentRes = await pool.query(
      `INSERT INTO students (class_id, name, alias_id, qr_token, status, local_image_path)
       VALUES ($1, $2, $3, $4, 'pending', $5)
       RETURNING id, alias_id, name`,
      [testClassId, 'Học sinh Test Lỗi 5004', aliasId, qrToken, testImagePath]
    );
    const testStudent = studentRes.rows[0];
    createdStudentIds.push(testStudent.id);

    const mockHanet = {
      registerByUrl: async () => ({
        success: false,
        rawResponse: {
          returnCode: -5004,
          returnMessage: 'UNKNOWN_DEVICE_OR_PLACE_ERROR',
          data: null,
        },
        evaluation: evaluateHanetError(-5004, 'UNKNOWN_DEVICE_OR_PLACE_ERROR'),
      }),
    } as unknown as HanetClient;

    const mockJob = {
      id: `student_${aliasId}`,
      data: {
        studentId: testStudent.id,
        aliasId,
        studentName: testStudent.name,
        classCode: testClassCode,
        tempFilename: testImageFilename,
        uploadedAt: Date.now(),
        actionType: 'REGISTER' as const,
      },
      opts: { attempts: 1 },
      attemptsMade: 0,
    } as any;

    const result = await processRegistrationJob(mockJob, {
      studentRepo,
      logRepo,
      settingsRepo,
      hanetClient: mockHanet,
    });

    expect(result.success).toBe(false);

    // Học sinh mang status='error', last_error_code='-5004'
    const updatedStudent = await studentRepo.findById(testStudent.id);
    expect(updatedStudent?.status).toBe('error');
    expect(updatedStudent?.last_error_code).toBe('-5004');
    expect(updatedStudent?.last_error_message).toContain('(-5004)');

    // Audit log
    const logRes = await pool.query(
      `SELECT * FROM logs WHERE alias_id = $1 ORDER BY id DESC LIMIT 1`,
      [aliasId]
    );
    expect(logRes.rows.length).toBe(1);
    expect(logRes.rows[0].action).toBe('REGISTER');
    expect(logRes.rows[0].result_code).toBe('ERROR');
    expect(logRes.rows[0].result_message).toContain('(-5004)');

    // Không ảnh hưởng tổng số học sinh khác
    const afterCountRes = await pool.query('SELECT COUNT(*)::int AS count FROM students');
    expect(afterCountRes.rows[0].count).toBe(baselineCount + 1);
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // TRƯỜNG HỢP 4: So sánh -5004 vs -101 (Khóa sự thật mã nguồn & hành vi)
  // ═══════════════════════════════════════════════════════════════════════════
  it('4. So sánh -5004 vs -101: Cùng rơi vào nhánh UNKNOWN_ERROR/ngoại lệ, cùng kết thúc status="error"', () => {
    // 1. Kiểm tra qua mapping error-mapping
    const eval101 = evaluateHanetError(-101, 'All devices in current place offline');
    const eval5004 = evaluateHanetError(-5004, 'UNKNOWN_DEVICE_ERROR');

    // Cả hai đều KHÔNG có nhánh định nghĩa riêng trong HANET_ERROR_MAP
    expect(eval101.action).toBe('UNKNOWN_ERROR');
    expect(eval5004.action).toBe('UNKNOWN_ERROR');

    // Cả hai đều không phải lỗi tạm thời thử lại tự động (isRetryable = false)
    expect(eval101.isRetryable).toBe(false);
    expect(eval5004.isRetryable).toBe(false);

    // 2. Điểm khác biệt duy nhất là mã lỗi số học và thông điệp kỹ thuật
    expect(eval101.returnCode).toBe(-101);
    expect(eval5004.returnCode).toBe(-5004);
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // TRƯỜNG HỢP 5: UPDATE_PHOTO lỗi -1, đường teacher-PIN override, SELF_SERVICE_PRESERVED
  // ═══════════════════════════════════════════════════════════════════════════
  it('5. UPDATE_PHOTO lỗi -1 (Teacher Override): status VẪN "success", ảnh cũ và person_id GIỮ NGUYÊN, audit UPDATE_PHOTO_FAILED', async () => {
    const aliasId = 'TEST_PH01';
    const qrToken = generateStudentQrToken();
    const existingPersonId = 'HANET_PRESERVED_123';
    const existingFaceUrl = 'http://localhost:8090/tmp-faces/old_face_sample.jpg';
    const originalLocalImagePath = '/app/uploads/original_face.jpg';

    // Tạo học sinh ban đầu đã ở trạng thái success
    const studentRes = await pool.query(
      `INSERT INTO students (class_id, name, alias_id, qr_token, status, person_id, face_url, local_image_path, is_updating)
       VALUES ($1, $2, $3, $4, 'success', $5, $6, $7, false)
       RETURNING id, alias_id, name`,
      [testClassId, 'Học sinh Đã Thành Công', aliasId, qrToken, existingPersonId, existingFaceUrl, originalLocalImagePath]
    );
    const testStudent = studentRes.rows[0];
    createdStudentIds.push(testStudent.id);

    // Mô phỏng đường Teacher Override: claimStudentForTeacherOverride bật is_updating = true
    const claimRes = await studentRepo.claimStudentForTeacherOverride(testStudent.id, testImagePath);
    expect(claimRes).not.toBeNull();
    expect(claimRes?.mode).toBe('UPDATE_PHOTO');
    expect(claimRes?.student.is_updating).toBe(true);

    // Mock HANET trả về lỗi -1 ("Dữ liệu gửi lên không hợp lệ hoặc thiếu thông tin bắt buộc")
    const mockHanet = {
      updateByFaceImageByPersonID: async () => ({
        success: false,
        rawResponse: {
          returnCode: -1,
          returnMessage: 'INVALID_INPUT_ERROR: file corrupted or invalid',
          data: null,
        },
        evaluation: evaluateHanetError(-1, 'Dữ liệu gửi lên không hợp lệ hoặc thiếu thông tin bắt buộc.'),
      }),
    } as unknown as HanetClient;

    const mockJob = {
      id: `teacher_override_${aliasId}`,
      data: {
        studentId: testStudent.id,
        aliasId,
        studentName: testStudent.name,
        classCode: testClassCode,
        tempFilename: testImageFilename,
        uploadedAt: Date.now(),
        actionType: 'UPDATE_PHOTO' as const,
        personId: existingPersonId,
      },
      opts: { attempts: 1 },
      attemptsMade: 0,
    } as any;

    // Chạy processor
    const result = await processRegistrationJob(mockJob, {
      studentRepo,
      logRepo,
      settingsRepo,
      hanetClient: mockHanet,
    });

    // Kết quả: quarantined=true (cách ly an toàn, job kết thúc không ném exception làm crash worker)
    expect(result.quarantined).toBe(true);
    expect(result.success).toBe(false);

    // Kiểm tra học sinh trong CSDL:
    const studentAfter = await studentRepo.findById(testStudent.id);
    expect(studentAfter).toBeDefined();
    // 1. Status VẪN là 'success' (KHÔNG bị tụt xuống error hay manual_review)
    expect(studentAfter?.status).toBe('success');
    // 2. person_id VẪN giữ nguyên
    expect(studentAfter?.person_id).toBe(existingPersonId);
    // 3. face_url VẪN giữ nguyên ảnh cũ phục vụ điểm danh
    expect(studentAfter?.face_url).toBe(existingFaceUrl);
    // 4. Cờ is_updating được giải phóng về false
    expect(studentAfter?.is_updating).toBe(false);
    // 5. last_error_code ghi nhận '-1'
    expect(studentAfter?.last_error_code).toBe('-1');

    // Kiểm tra Audit Log: Phải có dòng UPDATE_PHOTO_FAILED với prefix [SELF_SERVICE_PRESERVED]
    const logRes = await pool.query(
      `SELECT * FROM logs WHERE student_id = $1 AND action = 'UPDATE_PHOTO_FAILED' ORDER BY id DESC LIMIT 1`,
      [testStudent.id]
    );
    expect(logRes.rows.length).toBe(1);
    expect(logRes.rows[0].result_code).toBe('-1');
    expect(logRes.rows[0].result_message).toContain('[SELF_SERVICE_PRESERVED]');
    expect(logRes.rows[0].result_message).toContain("status='success'");
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // TRƯỜNG HỢP 6: Đối chứng UPDATE_PHOTO lỗi -1 vs Đăng ký thường REGISTER lỗi -1
  // ═══════════════════════════════════════════════════════════════════════════
  it('6. Đối chứng: REGISTER mới gặp lỗi -1 thì rơi vào manual_review (Fast Isolation), KHÔNG giữ status', async () => {
    const aliasId = 'TEST_REG1';
    const qrToken = generateStudentQrToken();

    // Học sinh đang đăng ký lần đầu (status = 'pending')
    const studentRes = await pool.query(
      `INSERT INTO students (class_id, name, alias_id, qr_token, status, local_image_path)
       VALUES ($1, $2, $3, $4, 'pending', $5)
       RETURNING id, alias_id, name`,
      [testClassId, 'Học sinh Đăng Ký Mới Lỗi -1', aliasId, qrToken, testImagePath]
    );
    const testStudent = studentRes.rows[0];
    createdStudentIds.push(testStudent.id);

    const mockHanet = {
      registerByUrl: async () => ({
        success: false,
        rawResponse: {
          returnCode: -1,
          returnMessage: 'INVALID_INPUT_ERROR',
          data: null,
        },
        evaluation: evaluateHanetError(-1, 'Dữ liệu gửi lên không hợp lệ hoặc thiếu thông tin bắt buộc.'),
      }),
    } as unknown as HanetClient;

    const mockJob = {
      id: `student_${aliasId}`,
      data: {
        studentId: testStudent.id,
        aliasId,
        studentName: testStudent.name,
        classCode: testClassCode,
        tempFilename: testImageFilename,
        uploadedAt: Date.now(),
        actionType: 'REGISTER' as const, // Đường đăng ký thường
      },
      opts: { attempts: 1 },
      attemptsMade: 0,
    } as any;

    const result = await processRegistrationJob(mockJob, {
      studentRepo,
      logRepo,
      settingsRepo,
      hanetClient: mockHanet,
    });

    expect(result.quarantined).toBe(true);

    // Khẳng định đối chứng: Khác với UPDATE_PHOTO (giữ status='success'),
    // đường REGISTER gặp -1 sẽ chuyển sang 'manual_review'
    const studentAfter = await studentRepo.findById(testStudent.id);
    expect(studentAfter?.status).toBe('manual_review');
    expect(studentAfter?.last_error_code).toBe('-1');

    // Audit log là REGISTER/MANUAL_REVIEW, không phải UPDATE_PHOTO_FAILED
    const logRes = await pool.query(
      `SELECT * FROM logs WHERE alias_id = $1 ORDER BY id DESC LIMIT 1`,
      [aliasId]
    );
    expect(logRes.rows.length).toBe(1);
    expect(logRes.rows[0].action).toBe('REGISTER');
    expect(logRes.rows[0].result_code).toBe('MANUAL_REVIEW');
    expect(logRes.rows[0].result_message).toContain('[FAST_ISOLATION]');
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // TRƯỜNG HỢP 7: Mã lỗi không xác định (ví dụ -9999)
  // ═══════════════════════════════════════════════════════════════════════════
  it('7. Mã lỗi không xác định (-9999): Không crash, chuyển status="error", ghi last_error_code="-9999"', async () => {
    const aliasId = 'TEST_9999';
    const qrToken = generateStudentQrToken();

    const studentRes = await pool.query(
      `INSERT INTO students (class_id, name, alias_id, qr_token, status, local_image_path)
       VALUES ($1, $2, $3, $4, 'pending', $5)
       RETURNING id, alias_id, name`,
      [testClassId, 'Học sinh Mã Lỗi Lạ -9999', aliasId, qrToken, testImagePath]
    );
    const testStudent = studentRes.rows[0];
    createdStudentIds.push(testStudent.id);

    const mockHanet = {
      registerByUrl: async () => ({
        success: false,
        rawResponse: {
          returnCode: -9999,
          returnMessage: 'UNEXPECTED_CLOUD_GATEWAY_ANOMALY',
          data: null,
        },
        evaluation: evaluateHanetError(-9999, 'UNEXPECTED_CLOUD_GATEWAY_ANOMALY'),
      }),
    } as unknown as HanetClient;

    const mockJob = {
      id: `student_${aliasId}`,
      data: {
        studentId: testStudent.id,
        aliasId,
        studentName: testStudent.name,
        classCode: testClassCode,
        tempFilename: testImageFilename,
        uploadedAt: Date.now(),
        actionType: 'REGISTER' as const,
      },
      opts: { attempts: 1 },
      attemptsMade: 0,
    } as any;

    const result = await processRegistrationJob(mockJob, {
      studentRepo,
      logRepo,
      settingsRepo,
      hanetClient: mockHanet,
    });

    expect(result.success).toBe(false);

    // Học sinh chuyển status='error', không bị treo 'pending' nửa vời
    const studentAfter = await studentRepo.findById(testStudent.id);
    expect(studentAfter?.status).toBe('error');
    expect(studentAfter?.last_error_code).toBe('-9999');

    // Audit log
    const logRes = await pool.query(
      `SELECT * FROM logs WHERE alias_id = $1 ORDER BY id DESC LIMIT 1`,
      [aliasId]
    );
    expect(logRes.rows.length).toBe(1);
    expect(logRes.rows[0].result_code).toBe('ERROR');
    expect(logRes.rows[0].result_message).toContain('(-9999)');
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // TRƯỜNG HỢP 8: Lỗi trong lúc ghi audit log (mô phỏng được)
  // ═══════════════════════════════════════════════════════════════════════════
  it('8. Lỗi ghi audit log: Trạng thái học sinh (status="error", last_error_code) đã được cập nhật trước đó và không bị mất', async () => {
    const aliasId = 'TEST_LG01';
    const qrToken = generateStudentQrToken();

    const studentRes = await pool.query(
      `INSERT INTO students (class_id, name, alias_id, qr_token, status, local_image_path)
       VALUES ($1, $2, $3, $4, 'pending', $5)
       RETURNING id, alias_id, name`,
      [testClassId, 'Học sinh Test Audit Fail', aliasId, qrToken, testImagePath]
    );
    const testStudent = studentRes.rows[0];
    createdStudentIds.push(testStudent.id);

    const mockHanet = {
      registerByUrl: async () => ({
        success: false,
        rawResponse: {
          returnCode: -101,
          returnMessage: 'All devices in current place offline',
          data: null,
        },
        evaluation: evaluateHanetError(-101, 'All devices in current place offline'),
      }),
    } as unknown as HanetClient;

    // Giả lập logRepo gặp sự cố ném Exception
    const failingLogRepo = {
      recordLog: async () => {
        throw new Error('SIMULATED_DB_LOG_DISK_FULL');
      },
    } as unknown as LogRepository;

    const mockJob = {
      id: `student_${aliasId}`,
      data: {
        studentId: testStudent.id,
        aliasId,
        studentName: testStudent.name,
        classCode: testClassCode,
        tempFilename: testImageFilename,
        uploadedAt: Date.now(),
        actionType: 'REGISTER' as const,
      },
      opts: { attempts: 1 },
      attemptsMade: 0,
    } as any;

    // Processor sẽ ném lỗi do logRepo.recordLog không được bọc try/catch nội bộ trong nhánh lỗi chung
    await expect(
      processRegistrationJob(mockJob, {
        studentRepo,
        logRepo: failingLogRepo,
        settingsRepo,
        hanetClient: mockHanet,
      })
    ).rejects.toThrow('SIMULATED_DB_LOG_DISK_FULL');

    // Xác minh: Trạng thái học sinh ĐÃ ĐƯỢC markFailure LƯU VÀO DB TRƯỚC KHI GHI LOG
    // Do đó KHÔNG bị mất trạng thái dù bước audit log ném lỗi!
    const studentInDb = await studentRepo.findById(testStudent.id);
    expect(studentInDb).toBeDefined();
    expect(studentInDb?.status).toBe('error');
    expect(studentInDb?.last_error_code).toBe('-101');
  });
});
