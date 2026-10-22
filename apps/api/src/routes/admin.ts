import { FastifyPluginAsync } from 'fastify';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { adminAuth } from '../middlewares/admin-auth.js';
import {
  AdminRequestStatus,
  StudentStatus,
  RawCloudFace,
  ParsedCloudResult,
  CloudInspectorResponse,
  DataDriftReport,
  DataDriftItem,
  parseAndClassifyAlias,
  resolveDeterministicAliasInMemory,
  generateQrToken,
  normalizeVietnameseStudentName,
} from '@thanh-giuse/shared-types';
import type { Queue } from 'bullmq';
import type { Redis } from 'ioredis';
import type { Pool } from 'pg';
import {
  cleanupStagingCloudFaces,
  executeStage1SnapshotAndSeed,
  upsertStagingCloudFaces,
  type ClassRepository,
  type StudentRepository,
  type LogRepository,
  type AdminRequestRepository,
  type SettingsRepository,
} from '@thanh-giuse/shared-infra';


declare module 'fastify' {
  interface FastifyInstance {
    classRepo: ClassRepository;
    studentRepo: StudentRepository;
    logRepo: LogRepository;
    adminRequestRepo: AdminRequestRepository;
    settingsRepo: SettingsRepository;
    registrationQueue: Queue;
    redis: Redis;
    pg: Pool;
  }
}

function sanitizeStudentName(rawName: string): string {
  return rawName
    .replace(/^\s*\d+[\.\-\/\)\s]\s*/, '')
    .trim()
    .replace(/\s+/g, ' ');
}

function findStudentImageFile(localPath: string | null): string | null {
  if (!localPath) return null;
  const filename = path.basename(localPath);
  const candidates = [
    localPath,
    path.join('/app/uploads', filename),
    path.join('/app/uploads/tmp-faces', filename),
    path.resolve(process.cwd(), 'uploads', filename),
    path.resolve(process.cwd(), 'uploads/tmp-faces', filename),
    process.env.UPLOAD_DIR ? path.join(process.env.UPLOAD_DIR, filename) : null,
    process.env.UPLOAD_DIR ? path.join(process.env.UPLOAD_DIR, 'tmp-faces', filename) : null,
  ].filter(Boolean) as string[];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      const uploadDir =
        process.env.UPLOAD_DIR ||
        (fs.existsSync('/app/uploads') ? '/app/uploads' : path.resolve(process.cwd(), 'uploads'));
      const mainPath = path.join(uploadDir, filename);
      if (candidate !== mainPath && !fs.existsSync(mainPath)) {
        try {
          if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
          fs.copyFileSync(candidate, mainPath);
        } catch {
          // ignore
        }
      }
      return candidate;
    }
  }
  return null;
}

export const adminRoutes: FastifyPluginAsync = async (fastify) => {
  const { classRepo, studentRepo, logRepo, adminRequestRepo, settingsRepo, registrationQueue, redis } = fastify;

  // =========================================================================
  // 1. POST /api/admin/auth/verify (Endpoint công khai duy nhất cho Login)
  // =========================================================================
  fastify.post('/auth/verify', async (request, reply) => {
    const body = request.body as { token?: string };
    const secretToken = process.env.ADMIN_SECRET_TOKEN || process.env.JWT_SECRET || 'admin_secret_super_secure_token';

    if (!body?.token || body.token !== secretToken) {
      return reply.status(401).send({ success: false, message: 'Mã xác thực không hợp lệ' });
    }

    // Set Cookie có hạn 3 ngày (259200 giây)
    reply.header(
      'Set-Cookie',
      `admin_token=${encodeURIComponent(body.token)}; Path=/; Max-Age=259200; HttpOnly; SameSite=Strict`
    );

    return reply.send({ success: true, message: 'Xác thực quản trị thành công' });
  });

  // =========================================================================
  // CÁC ENDPOINT DƯỚI ĐÂY YÊU CẦU MIDDLEWARE adminAuth BẢO VỆ
  // =========================================================================
  fastify.register(async (protectedRoutes) => {
    protectedRoutes.addHook('preHandler', adminAuth);

    // 2. GET /api/admin/dashboard/stats
    protectedRoutes.get('/dashboard/stats', async (_req, reply) => {
      const metrics = await studentRepo.getOverallMetrics();
      const classes = await classRepo.getClassesWithStats();
      const killSwitchValue = await redis.get('setting:kill_switch');

      // Kiểm tra có lỗi hệ thống nghiêm trọng đang tồn tại không
      const emergencyLogs = await fastify.pg.query(
        `SELECT result_code, result_message FROM logs 
         WHERE result_code IN ('-103', '-9008') 
         ORDER BY id DESC LIMIT 1`
      );

      const totalSuccess = Number(metrics?.total_success ?? 0);
      return reply.send({
        success: true,
        data: {
          metrics,
          total_classes: classes.length,
          face_quota: {
            used: totalSuccess,
            limit: 50000,
            percent: Number(((totalSuccess / 50000) * 100).toFixed(2)),
          },
          system_status: {
            is_maintenance: killSwitchValue === 'true',
            emergency_alert: emergencyLogs.rows[0] || null,
          },
        },
      });
    });

    // 3. GET /api/admin/classes
    protectedRoutes.get('/classes', async (req, reply) => {
      const query = req.query as { search?: string; grade?: string };
      const data = await classRepo.getClassesWithStats(query);
      return reply.send({ success: true, data });
    });

    // 3.1 POST /api/admin/classes
    protectedRoutes.post('/classes', async (req, reply) => {
      const body = req.body as {
        code?: string;
        name?: string;
        teacher_name?: string;
        token?: string;
      };

      const rawCode = body?.code?.trim();
      const rawName = body?.name?.trim();
      const rawTeacher = body?.teacher_name?.trim();
      const rawToken = body?.token?.trim();

      if (!rawCode || !rawName) {
        return reply.status(400).send({
          success: false,
          message: 'Mã lớp và tên lớp là các trường bắt buộc',
        });
      }

      const code = rawCode.toUpperCase();
      const CODE_REGEX = /^[A-Z0-9_-]{2,20}$/;
      if (!CODE_REGEX.test(code)) {
        return reply.status(400).send({
          success: false,
          message: 'Mã lớp chỉ được chứa từ 2-20 ký tự chữ, số, gạch dưới hoặc gạch ngang (VD: 10A1, 10A_2)',
        });
      }

      if (rawName.length < 2 || rawName.length > 100) {
        return reply.status(400).send({
          success: false,
          message: 'Tên lớp phải có độ dài từ 2 đến 100 ký tự',
        });
      }

      let token = rawToken;
      if (token) {
        const TOKEN_REGEX = /^[a-zA-Z0-9_-]{4,64}$/;
        if (!TOKEN_REGEX.test(token)) {
          return reply.status(400).send({
            success: false,
            message: 'Mã PIN phải có độ dài từ 4-64 ký tự và chỉ chứa ký tự an toàn URL (chữ, số, _, -)',
          });
        }
      } else {
        token = `PIN_${code}_${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
      }

      // Kiểm tra trùng lặp
      const existence = await classRepo.checkExistence(code, token);
      if (existence.codeExists) {
        return reply.status(409).send({
          success: false,
          message: `Mã lớp '${code}' đã tồn tại`,
        });
      }
      if (existence.tokenExists) {
        return reply.status(409).send({
          success: false,
          message: 'Mã PIN này đã được sử dụng cho lớp khác',
        });
      }

      try {
        const newClass = await classRepo.createClass({
          code,
          name: rawName,
          teacher_name: rawTeacher || null,
          token,
        });

        // Audit Logging
        const ip = req.ip || (req.headers['x-forwarded-for'] as string) || null;
        await logRepo.recordLog({
          class_id: newClass.id,
          action: 'CREATE_CLASS',
          result_code: '1',
          result_message: `Admin khởi tạo lớp mới: ${newClass.code} - ${newClass.name}`,
          ip,
        });

        return reply.status(201).send({
          success: true,
          message: 'Khởi tạo lớp học mới thành công',
          data: newClass,
        });
      } catch (err: any) {
        if (err.code === '23505') {
          return reply.status(409).send({
            success: false,
            message: `Mã lớp '${code}' hoặc mã PIN đã tồn tại`,
          });
        }
        throw err;
      }
    });

    // 4. PATCH /api/admin/classes/:id/lock
    protectedRoutes.patch('/classes/:id/lock', async (req, reply) => {
      const { id } = req.params as { id: string };
      const body = req.body as { is_locked: boolean };

      if (typeof body?.is_locked !== 'boolean') {
        return reply.status(400).send({ message: 'Tham số is_locked (boolean) là bắt buộc' });
      }

      const success = await classRepo.updateLockStatus(Number(id), body.is_locked);
      if (!success) {
        return reply.status(404).send({ message: 'Không tìm thấy lớp học' });
      }

      return reply.send({ success: true, message: `Đã ${body.is_locked ? 'khóa' : 'mở khóa'} link nộp bài của lớp.` });
    });

    // 4.1. GET /api/admin/classes/:id/students (Lấy danh sách học sinh theo lớp)
    protectedRoutes.get('/classes/:id/students', async (req, reply) => {
      const { id } = req.params as { id: string };
      const classId = Number(id);
      const cls = await classRepo.findById(classId);
      if (!cls) {
        return reply.status(404).send({ success: false, message: 'Không tìm thấy lớp học' });
      }

      const students = await studentRepo.getStudentsByClassId(classId);
      return reply.send({ success: true, data: students });
    });

    // 4.2. POST /api/admin/classes/:id/students (Thêm đơn lẻ hoặc hàng loạt học sinh)
    protectedRoutes.post('/classes/:id/students', async (req, reply) => {
      const { id } = req.params as { id: string };
      const classId = Number(id);
      const cls = await classRepo.findById(classId);
      if (!cls) {
        return reply.status(404).send({ success: false, message: 'Không tìm thấy lớp học' });
      }

      const body = req.body as { name?: string; names?: string[] };
      let namesToCreate: string[] = [];

      if (Array.isArray(body?.names)) {
        namesToCreate = body.names
          .map(sanitizeStudentName)
          .filter(n => n.length >= 2 && n.length <= 100);
      } else if (typeof body?.name === 'string') {
        const clean = sanitizeStudentName(body.name);
        if (clean.length >= 2 && clean.length <= 100) {
          namesToCreate = [clean];
        }
      }

      if (namesToCreate.length === 0) {
        return reply.status(400).send({
          success: false,
          message: 'Vui lòng cung cấp họ và tên học sinh hợp lệ (từ 2 đến 100 ký tự)',
        });
      }

      const ip = req.ip || (req.headers['x-forwarded-for'] as string) || null;
      let createdStudents;

      if (namesToCreate.length === 1) {
        const student = await studentRepo.createStudent(classId, namesToCreate[0], cls.code);
        createdStudents = [student];
        await logRepo.recordLog({
          student_id: student.id,
          class_id: classId,
          alias_id: student.alias_id,
          action: 'CREATE_STUDENT',
          result_code: '1',
          result_message: `Admin thêm học sinh: ${student.name} vào lớp ${cls.code}`,
          ip,
        });
      } else {
        createdStudents = await studentRepo.bulkCreateStudents(classId, namesToCreate, cls.code);
        await logRepo.recordLog({
          class_id: classId,
          action: 'BULK_CREATE_STUDENTS',
          result_code: '1',
          result_message: `Admin nhập hàng loạt ${createdStudents.length} học sinh vào lớp ${cls.code}`,
          ip,
        });
      }

      return reply.status(201).send({
        success: true,
        message: `Đã thêm thành công ${createdStudents.length} học sinh vào lớp ${cls.code}`,
        data: createdStudents,
      });
    });

    // 4.3. POST /api/admin/classes/:id/requeue-pending (Giải cứu toàn bộ học sinh pending trong lớp)
    protectedRoutes.post('/classes/:id/requeue-pending', async (req, reply) => {
      const { id } = req.params as { id: string };
      const classId = Number(id);
      const cls = await classRepo.findById(classId);
      if (!cls) {
        return reply.status(404).send({ success: false, message: 'Không tìm thấy lớp học' });
      }

      const pendingStudentsRes = await fastify.pg.query<{
        id: number;
        name: string;
        alias_id: string | null;
        qr_token: string;
        local_image_path: string | null;
        person_id: string | null;
      }>(
        `SELECT id, name, alias_id, qr_token, local_image_path, person_id 
         FROM students 
         WHERE class_id = $1 AND status = 'pending' 
         ORDER BY id ASC`,
        [classId]
      );

      const pendingStudents = pendingStudentsRes.rows;
      if (pendingStudents.length === 0) {
        return reply.send({
          success: true,
          requeuedCount: 0,
          resetCount: 0,
          message: `Lớp ${cls.code} không có học sinh nào đang bị kẹt pending.`,
        });
      }

      let requeuedCount = 0;
      let resetCount = 0;

      for (const student of pendingStudents) {
        const foundImage = findStudentImageFile(student.local_image_path);
        const safeIdentifier = student.alias_id || student.qr_token || String(student.id);
        const isUpdate = Boolean(student.person_id);
        const actionType = isUpdate ? 'UPDATE_PHOTO' : 'REGISTER';

        if (foundImage) {
          const tempFilename = path.basename(foundImage);
          const jobId = `requeue_${safeIdentifier}_${Date.now()}`;

          await registrationQueue.add(
            isUpdate ? 'override-photo' : 'register',
            {
              studentId: student.id,
              aliasId: student.alias_id || undefined,
              qrToken: student.qr_token,
              studentName: student.name,
              classCode: cls.code,
              tempFilename,
              uploadedAt: Date.now(),
              actionType,
              ...(student.person_id ? { personId: student.person_id } : {}),
            },
            {
              jobId,
              priority: 1,
              removeOnComplete: true,
            }
          );
          requeuedCount++;
        } else {
          await fastify.pg.query(
            `UPDATE students 
             SET status = 'empty', local_image_path = NULL, retry_count = 0, last_error_code = NULL, updated_at = NOW() 
             WHERE id = $1`,
            [student.id]
          );
          resetCount++;
        }
      }

      return reply.send({
        success: true,
        requeuedCount,
        resetCount,
        message: `Đã nạp lại ${requeuedCount} học sinh vào hàng đợi xử lý ngay${resetCount > 0 ? `, hoàn trả ${resetCount} học sinh không còn ảnh về empty` : ''}.`,
      });
    });

    // 5. GET /api/admin/students
    protectedRoutes.get('/students', async (req, reply) => {
      const query = req.query as {
        class_id?: string;
        status?: StudentStatus;
        search?: string;
        page?: string;
        limit?: string;
      };

      const result = await studentRepo.getPaginatedStudents({
        classId: query.class_id ? Number(query.class_id) : undefined,
        status: query.status,
        search: query.search,
        page: query.page ? parseInt(query.page, 10) : 1,
        limit: query.limit ? parseInt(query.limit, 10) : 20,
      });

      return reply.send({ success: true, data: result });
    });

    // 6. POST /api/admin/students/:id/override (Đẩy BullMQ job priority = 1)
    protectedRoutes.post('/students/:id/override', async (req, reply) => {
      const { id } = req.params as { id: string };
      const student = await studentRepo.findById(Number(id));
      if (!student) {
        return reply.status(404).send({ message: 'Không tìm thấy học sinh' });
      }

      const fileData = await req.file();
      if (!fileData) {
        return reply.status(400).send({ message: 'Vui lòng đính kèm file ảnh' });
      }

      // Lưu file ảnh thô vào Volume tạm
      const tempDir = fs.existsSync('/app/storage/temp')
        ? '/app/storage/temp'
        : (process.env.UPLOAD_DIR
            ? path.join(process.env.UPLOAD_DIR, 'temp')
            : path.resolve(process.cwd(), 'uploads/temp'));
      if (!fs.existsSync(tempDir)) {
        fs.mkdirSync(tempDir, { recursive: true });
      }

      const tempFileName = `admin_override_${Date.now()}_${crypto.randomBytes(4).toString('hex')}.jpg`;
      const tempFilePath = path.join(tempDir, tempFileName);
      await fs.promises.writeFile(tempFilePath, await fileData.toBuffer());

      // Cập nhật trạng thái pending cho học sinh
      await fastify.pg.query(
        `UPDATE students 
         SET status = 'pending', local_image_path = $1, retry_count = 0, updated_at = NOW() 
         WHERE id = $2`,
        [tempFilePath, student.id]
      );

      const safeIdentifier = student.alias_id || student.qr_token || String(student.id);
      const clsRecord = await classRepo.findById(student.class_id);

      // Đẩy job xử lý ưu tiên số 1 (High Priority)
      await registrationQueue.add(
        'SYNC_FACE',
        {
          studentId: student.id,
          aliasId: student.alias_id,
          qrToken: student.qr_token,
          classCode: clsRecord?.code || 'TS1A',
          name: student.name,
          studentName: student.name,
          rawImagePath: tempFilePath,
          tempFilename: tempFileName,
          actionType: student.person_id ? 'UPDATE_PHOTO' : 'REGISTER',
          personId: student.person_id,
          uploadedAt: Date.now(),
        },
        {
          priority: 1, // BullMQ: Priority thấp hơn = Chạy trước (Priority 1 > Priority 5 > Priority 20)
          jobId: `override_${safeIdentifier}_${Date.now()}`,
        }
      );

      return reply.send({ success: true, message: 'Đã nạp job cập nhật ảnh ưu tiên cao vào hàng đợi.' });
    });

    // 7. POST /api/admin/students/:id/reset
    protectedRoutes.post('/students/:id/reset', async (req, reply) => {
      const { id } = req.params as { id: string };
      const success = await studentRepo.resetStudentStatus(Number(id));
      if (!success) {
        return reply.status(404).send({ message: 'Không tìm thấy học sinh để reset' });
      }
      return reply.send({ success: true, message: 'Đã hoàn trả trạng thái học sinh về empty.' });
    });

    // 7b. POST /api/admin/students/:id/unlock (Chuẩn hóa theo contracts/admin-api.yaml)
    protectedRoutes.post('/students/:id/unlock', async (req, reply) => {
      const { id } = req.params as { id: string };
      const studentId = Number(id);
      const student = await studentRepo.findById(studentId);
      if (!student) {
        return reply.status(404).send({ success: false, message: 'Không tìm thấy học sinh để mở khóa' });
      }

      // Micro-fix unlock guard: Chỉ cho phép mở khóa khi hồ sơ đang ở trạng thái manual_review
      if (student.status !== 'manual_review') {
        return reply.status(400).send({
          statusCode: 400,
          error: 'Bad Request',
          message: 'Chỉ có thể mở khóa cho hồ sơ đang ở trạng thái manual_review',
        });
      }

      const success = await studentRepo.resetStudentStatus(studentId);
      if (!success) {
        return reply.status(404).send({ success: false, message: 'Không tìm thấy học sinh để mở khóa' });
      }
      return reply.send({ success: true, message: 'Đã mở khóa hồ sơ học sinh về trạng thái empty.' });
    });

    // 7.1. PUT /api/admin/students/:id (Cập nhật họ tên học sinh)
    protectedRoutes.put('/students/:id', async (req, reply) => {
      const { id } = req.params as { id: string };
      const studentId = Number(id);
      const student = await studentRepo.findById(studentId);
      if (!student) {
        return reply.status(404).send({ success: false, message: 'Không tìm thấy học sinh' });
      }

      const body = req.body as { name?: string };
      const cleanName = sanitizeStudentName(body?.name || '');
      if (cleanName.length < 2 || cleanName.length > 100) {
        return reply.status(400).send({
          success: false,
          message: 'Họ và tên học sinh phải từ 2 đến 100 ký tự',
        });
      }

      const updated = await studentRepo.updateStudent(studentId, cleanName);
      const ip = req.ip || (req.headers['x-forwarded-for'] as string) || null;
      await logRepo.recordLog({
        student_id: student.id,
        class_id: student.class_id,
        alias_id: student.alias_id,
        action: 'UPDATE_STUDENT',
        result_code: '1',
        result_message: `Admin đổi tên học sinh từ "${student.name}" thành "${cleanName}"`,
        ip,
      });

      return reply.send({
        success: true,
        message: 'Cập nhật thông tin học sinh thành công',
        data: updated,
      });
    });

    // 7.2. DELETE /api/admin/students/:id (Xóa học sinh khỏi lớp)
    protectedRoutes.delete('/students/:id', async (req, reply) => {
      const { id } = req.params as { id: string };
      const studentId = Number(id);

      const result = await studentRepo.deleteStudent(studentId);
      if (!result.success) {
        if (result.reason === 'NOT_FOUND') {
          return reply.status(404).send({ success: false, message: 'Không tìm thấy học sinh' });
        }
        if (result.reason === 'STUDENT_PENDING') {
          return reply.status(400).send({
            success: false,
            message: 'Không thể xóa học sinh khi đang trong trạng thái xử lý ảnh (pending)',
          });
        }
        return reply.status(400).send({ success: false, message: 'Không thể xóa học sinh' });
      }

      const student = result.student!;
      const ip = req.ip || (req.headers['x-forwarded-for'] as string) || null;
      await logRepo.recordLog({
        student_id: student.id,
        class_id: student.class_id,
        alias_id: student.alias_id,
        action: 'DELETE_STUDENT',
        result_code: '1',
        result_message: `Admin đã xóa học sinh ${student.name} (${student.alias_id || student.qr_token}) khỏi lớp`,
        ip,
      });


      return reply.send({
        success: true,
        message: `Đã xóa học sinh ${student.name} thành công`,
      });
    });

    // 7.3. POST /api/admin/students/:id/retry (Thử lại đồng bộ từ file ảnh đã lưu trên server)
    protectedRoutes.post('/students/:id/retry', async (req, reply) => {
      const { id } = req.params as { id: string };
      const studentId = Number(id);
      const student = await studentRepo.findById(studentId);
      if (!student) {
        return reply.status(404).send({ success: false, message: 'Không tìm thấy học sinh' });
      }

      const finalImagePath = findStudentImageFile(student.local_image_path);

      if (!finalImagePath) {
        return reply.status(400).send({
          success: false,
          message: `Không tìm thấy file ảnh đã lưu của học sinh "${student.name}" trên máy chủ. Vui lòng cho học sinh chụp lại ảnh hoặc nộp ảnh qua PIN lớp.`,
        });
      }

      const cls = student.class_id ? await classRepo.findById(student.class_id) : null;
      const classCode = cls?.code || 'TS1A';
      const safeIdentifier = student.alias_id || student.qr_token || String(student.id);
      const isUpdate = Boolean(student.person_id);
      const actionType = isUpdate ? 'UPDATE_PHOTO' : 'REGISTER';
      const tempFilename = path.basename(finalImagePath);
      const jobId = `admin_retry_${safeIdentifier}_${Date.now()}`;

      // Đưa trạng thái về pending
      await fastify.pg.query(
        `UPDATE students 
         SET status = 'pending', retry_count = 0, last_error_code = NULL, last_error_message = NULL, updated_at = NOW() 
         WHERE id = $1`,
        [student.id]
      );

      await registrationQueue.add(
        isUpdate ? 'override-photo' : 'register',
        {
          studentId: student.id,
          aliasId: student.alias_id || undefined,
          qrToken: student.qr_token,
          studentName: student.name,
          classCode,
          tempFilename,
          uploadedAt: Date.now(),
          actionType,
          ...(student.person_id ? { personId: student.person_id } : {}),
        },
        {
          jobId,
          priority: 1, // Ưu tiên xử lý ngay
          removeOnComplete: true,
        }
      );

      return reply.send({
        success: true,
        message: `Đã nạp học sinh "${student.name}" vào hàng đợi xử lý ngay (Job ID: ${jobId}).`,
      });
    });

    // 8. GET /api/admin/requests
    protectedRoutes.get('/requests', async (req, reply) => {
      const query = req.query as {
        status?: AdminRequestStatus;
        class_id?: string;
        page?: string;
        limit?: string;
      };

      const result = await adminRequestRepo.getRequests({
        status: query.status,
        classId: query.class_id ? Number(query.class_id) : undefined,
        page: query.page ? parseInt(query.page, 10) : 1,
        limit: query.limit ? parseInt(query.limit, 10) : 20,
      });

      return reply.send({ success: true, data: result });
    });

    // 9. PATCH /api/admin/requests/:id/status
    protectedRoutes.patch('/requests/:id/status', async (req, reply) => {
      const { id } = req.params as { id: string };
      const body = req.body as { status: AdminRequestStatus };

      if (!['new', 'processing', 'done'].includes(body?.status)) {
        return reply.status(400).send({ message: 'Trạng thái status không hợp lệ (new, processing, done)' });
      }

      const success = await adminRequestRepo.updateRequestStatus(Number(id), body.status);
      if (!success) {
        return reply.status(404).send({ message: 'Không tìm thấy yêu cầu' });
      }

      return reply.send({ success: true, message: 'Đã cập nhật trạng thái yêu cầu xử lý.' });
    });

    // 10. POST /api/admin/settings/kill-switch
    protectedRoutes.post('/settings/kill-switch', async (req, reply) => {
      const body = req.body as { enabled: boolean };
      if (typeof body?.enabled !== 'boolean') {
        return reply.status(400).send({ message: 'Tham số enabled (boolean) là bắt buộc' });
      }

      const ip = req.ip || (req.headers['x-forwarded-for'] as string) || null;

      if (!body.enabled) {
        // --- NGẮT HÀNG ĐỢI (Kill Switch ON / enabled: false) ---
        // 1. Tạm dừng hàng đợi ở tầng queue (BullMQ qua Redis, xuyên tiến trình/container)
        await registrationQueue.pause();

        // 2. Cập nhật cờ bảo trì Redis và settings PostgreSQL
        await redis.set('setting:kill_switch', 'true');
        await settingsRepo.set('registration_enabled', 'false');

        // 3. Ghi Audit Log vào bảng logs
        await logRepo.recordLog({
          action: 'KILL_SWITCH_DISABLED',
          result_code: '1',
          result_message: 'Admin kích hoạt Kill Switch: Tạm dừng hàng đợi registration_queue và khóa tiếp nhận ảnh mới',
          ip,
        });

        return reply.send({
          success: true,
          message: 'Hệ thống đã BẬT CHẾ ĐỘ BẢO TRÌ (tạm dừng tiếp nhận ảnh mới và tạm dừng hàng đợi).'
        });
      } else {
        // --- MỞ LẠI HÀNG ĐỢI (Kill Switch OFF / enabled: true) ---
        // 1. Resume hàng đợi ở tầng queue (BullMQ qua Redis, xuyên tiến trình/container)
        await registrationQueue.resume();

        // 2. Xóa cờ bảo trì và cờ khóa hệ thống trong Redis
        await redis.del('system:registration_disabled');
        await redis.set('setting:kill_switch', 'false');
        await settingsRepo.set('registration_enabled', 'true');

        // 3. Quét khôi phục: Đưa lại vào hàng đợi mọi học sinh đang pending có last_error_code thuộc nhóm token (-103, -401)
        const tokenErrorStudentsRes = await fastify.pg.query(
          `SELECT s.id, s.name, s.alias_id, s.local_image_path, s.person_id, c.code AS class_code
           FROM students s
           LEFT JOIN classes c ON s.class_id = c.id
           WHERE s.status = 'pending' AND s.last_error_code IN ('-103', '-401')`
        );

        let requeuedCount = 0;
        for (const s of tokenErrorStudentsRes.rows) {
          const jobId = `student_${s.alias_id}`;
          try {
            const existingJob = await registrationQueue.getJob(jobId);
            if (existingJob) {
              const state = await existingJob.getState();
              // Nếu job đang sống (waiting, active, delayed, prioritized) thì không nạp trùng
              if (['waiting', 'active', 'delayed', 'prioritized'].includes(state)) {
                continue;
              }
              // Nếu job đã failed hoặc completed cũ thì xóa trước khi nạp lại
              await existingJob.remove();
            }

            const filename = s.local_image_path ? path.basename(s.local_image_path) : `${s.alias_id}.jpg`;
            await registrationQueue.add(
              'register',
              {
                studentId: s.id,
                aliasId: s.alias_id,
                studentName: s.name,
                classCode: s.class_code || 'DEFAULT',
                tempFilename: filename,
                uploadedAt: Date.now(),
                actionType: 'REGISTER',
                ...(s.person_id ? { personId: s.person_id } : {}),
              },
              {
                jobId,
                priority: 5,
                removeOnComplete: true,
              }
            );
            requeuedCount++;
          } catch (jobErr: any) {
            fastify.log.warn(`[KillSwitch Recovery] Không thể đưa lại job cho học sinh ${s.alias_id}: ${jobErr?.message}`);
          }
        }

        // 4. Ghi Audit Log vào bảng logs
        await logRepo.recordLog({
          action: 'KILL_SWITCH_ENABLED',
          result_code: '1',
          result_message: `Admin mở lại hệ thống: Khôi phục hàng đợi registration_queue, gỡ cờ khóa và tái lập ${requeuedCount} học sinh lỗi token vào hàng đợi.`,
          ip,
        });

        return reply.send({
          success: true,
          requeued_count: requeuedCount,
          message: `Hệ thống đã MỞ LẠI cho phép học sinh nộp ảnh. Đã khôi phục ${requeuedCount} học sinh vào hàng đợi.`
        });
      }
    });

    // 11. GET /api/admin/logs
    protectedRoutes.get('/logs', async (req, reply) => {
      const query = req.query as {
        action?: string;
        result_code?: string;
        class_id?: string;
        search?: string;
        page?: string;
        limit?: string;
      };

      const result = await logRepo.getPaginatedLogs({
        action: query.action,
        resultCode: query.result_code,
        classId: query.class_id ? Number(query.class_id) : undefined,
        search: query.search,
        page: query.page ? parseInt(query.page, 10) : 1,
        limit: query.limit ? parseInt(query.limit, 10) : 20,
      });

      return reply.send({ success: true, data: result });
    });

    // Helper tự động chuẩn hóa & khắc phục Place ID (Tự phục hồi nếu Admin cấu hình nhầm Device ID Camera)
    async function resolveValidPlaceID(
      rawPlaceID: string,
      token: string,
      baseUrl: string,
      log?: any
    ): Promise<{ resolvedPlaceID: string; isAutoCorrected: boolean; warningMessage?: string | undefined }> {
      const trimmed = (rawPlaceID || '').trim();

      // Nếu đã là chuỗi số nguyên hợp lệ (ví dụ: '998577')
      if (/^\d+$/.test(trimmed) && trimmed !== '0') {
        return { resolvedPlaceID: trimmed, isAutoCorrected: false };
      }

      log?.warn(
        { rawPlaceID: trimmed },
        `Phát hiện HANET_PLACE_ID='${trimmed}' không phải ID địa điểm dạng số (khả năng là Device ID Camera). Đang tự động tra cứu ID địa điểm từ HANET API...`
      );

      let foundPlaceId = '998577';
      let placeName = 'Nhà thờ thánh Giuse';

      if (token && baseUrl.includes('partner.hanet.ai')) {
        try {
          const res = await fetch(`${baseUrl.replace(/\/$/, '')}/place/getPlaces`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({ token }).toString(),
          });
          if (res.ok) {
            const json = (await res.json()) as any;
            if (json?.returnCode === 1 && Array.isArray(json?.data) && json.data.length > 0) {
              foundPlaceId = String(json.data[0].id);
              placeName = json.data[0].name || placeName;
            }
          }
        } catch (err: any) {
          log?.warn({ err: err?.message }, 'Không thể tra cứu place/getPlaces, dùng fallback chuẩn 998577');
        }
      }

      const warningMessage = `Cảnh báo cấu hình: Giá trị HANET_PLACE_ID='${trimmed}' là mã thiết bị (Device Serial), không phải Place ID địa điểm. Hệ thống đã tự động kết nối về Place ID chuẩn: ${foundPlaceId} (${placeName}). Vui lòng cập nhật HANET_PLACE_ID=${foundPlaceId} trong tệp .env.`;

      log?.info(
        { rawPlaceID: trimmed, resolvedPlaceID: foundPlaceId, placeName },
        'Đã tự động định tuyến PlaceID thành công'
      );

      return {
        resolvedPlaceID: foundPlaceId,
        isAutoCorrected: true,
        warningMessage,
      };
    }

    // Helper lấy danh sách đầy đủ Face ID (kèm Auto-Pagination)
    async function fetchAllRawCloudFaces(
      token: string,
      rawPlaceID: string,
      primaryUrl: string,
      log?: any
    ): Promise<{
      rawList: RawCloudFace[];
      connectedBaseUrl: string;
      isLiveCloud: boolean;
      resolvedPlaceID: string;
      isAutoCorrected: boolean;
      warningMessage?: string | undefined;
    }> {
      const isCloudPrimary = primaryUrl.includes('partner.hanet.ai');
      const { resolvedPlaceID, isAutoCorrected, warningMessage } = await resolveValidPlaceID(
        rawPlaceID,
        token,
        primaryUrl,
        log
      );

      const candidateUrls = isCloudPrimary
        ? [primaryUrl]
        : ([
            primaryUrl,
            'http://app_mock:4000',
            'http://localhost:8001',
            'http://127.0.0.1:4000',
          ].filter(Boolean) as string[]);

      let connectedBaseUrl = primaryUrl;
      let lastFetchError: any = null;
      let rawList: RawCloudFace[] = [];

      for (const baseUrl of candidateUrls) {
        try {
          let page = 1;
          const size = 50;
          const maxPages = isCloudPrimary ? 35 : 5; // Tối đa 35 trang (1.750 người) cho Cloud thật
          const collected: RawCloudFace[] = [];
          let prevFirstPersonID: string | null = null;
          let encounteredError = false;

          while (page <= maxPages) {
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 15000);

            const postData = new URLSearchParams({
              token,
              placeID: resolvedPlaceID,
              page: String(page),
              size: String(size),
              type: '0', // Đảm bảo lấy đúng danh sách thành viên/học sinh
            });

            const hanetRes = await fetch(`${baseUrl.replace(/\/$/, '')}/person/getListByPlace`, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                Accept: 'application/json',
              },
              body: postData.toString(),
              signal: controller.signal,
            });
            clearTimeout(timeout);

            if (!hanetRes.ok) {
              encounteredError = true;
              break;
            }

            const json = (await hanetRes.json()) as any;

            // Kiểm tra lỗi Token hết hạn (-103)
            if (json?.returnCode === -103) {
              const err: any = new Error('HANET_TOKEN_EXPIRED');
              err.returnCode = -103;
              throw err;
            }

            // Chốt an toàn 2: Dừng ngay khi returnCode != 1 hoặc data không phải array
            if (json?.returnCode !== 1 || !Array.isArray(json?.data) || json.data.length === 0) {
              if (page === 1 && json?.returnCode !== 1) {
                log?.error(
                  { returnCode: json?.returnCode, returnMessage: json?.returnMessage, placeID: resolvedPlaceID },
                  'HANET Cloud trả về mã lỗi khi lấy danh sách nhân sự trang 1'
                );
                lastFetchError = new Error(`Lỗi HANET Cloud: [${json?.returnCode}] ${json?.returnMessage || 'Thất bại'}`);
              }
              break;
            }

            // Chốt an toàn 3: Dừng ngay nếu personID trang sau trùng lặp với trang trước
            const currentFirstPersonID = json.data[0]?.personID;
            if (currentFirstPersonID && currentFirstPersonID === prevFirstPersonID) {
              break;
            }
            prevFirstPersonID = currentFirstPersonID;

            collected.push(...json.data);

            // Điều kiện dừng tự nhiên: Trang cuối cùng có số lượng < size
            if (json.data.length < size) {
              break;
            }

            page++;
            await new Promise((r) => setTimeout(r, 200)); // Delay an toàn 200ms
          }

          if (!encounteredError && collected.length > 0) {
            rawList = collected;
            connectedBaseUrl = baseUrl;
            break;
          }
        } catch (err: any) {
          if (err.returnCode === -103 || err.message === 'HANET_TOKEN_EXPIRED') {
            throw err;
          }
          lastFetchError = err;
        }
      }

      if (rawList.length === 0 && lastFetchError) {
        throw lastFetchError;
      }

      return {
        rawList,
        connectedBaseUrl,
        isLiveCloud: connectedBaseUrl.includes('partner.hanet.ai'),
        resolvedPlaceID,
        isAutoCorrected,
        warningMessage,
      };
    }

    // Helper xây dựng CloudInspectorResponse từ rawList
    function processCloudFaces(
      rawList: RawCloudFace[],
      placeID: string,
      isLiveCloud: boolean,
      isPlaceIdAutoCorrected?: boolean,
      warningMessage?: string
    ): CloudInspectorResponse {
      const parsedItems: ParsedCloudResult[] = rawList.map((face) => parseAndClassifyAlias(face));
      const usedAliases = new Map<string, string>();
      for (const item of parsedItems) {
        if (!item.isError && item.maLopChuanHoa && item.personID) {
          const resolved = resolveDeterministicAliasInMemory(
            item.maLopChuanHoa,
            item.personID,
            usedAliases
          );
          item.aliasChuanHoaDuKien = resolved.aliasId;
        }
      }


      // Phân loại & Sắp xếp tự nhiên (Natural Sort) theo nhom3_id bên trong từng nhóm
      const validItems = parsedItems.filter((i) => !i.isError);
      const errorItems = parsedItems.filter((i) => i.isError);

      validItems.sort((a, b) =>
        (a.nhom3_id || '').localeCompare(b.nhom3_id || '', undefined, { numeric: true })
      );


      // Đếm theo Sector
      let tnCount = 0;
      let lgCount = 0;
      let lmCount = 0;
      const summaryByGroup: Record<
        string,
        { count: number; normalizedCode: string; label: string; sector: 'TN' | 'LG' | 'LM' }
      > = {};

      for (const item of validItems) {
        if (item.nhom1_nganh === 'TN') tnCount++;
        if (item.nhom1_nganh === 'LG') lgCount++;
        if (item.nhom1_nganh === 'LM') lmCount++;

        const key = (item.maLopChuanHoa || item.nhom2_lop || 'OTHER').toLowerCase();
        if (!summaryByGroup[key]) {
          summaryByGroup[key] = {
            count: 0,
            normalizedCode: item.maLopChuanHoa!,
            label: item.tenLopTiengViet!,
            sector: item.nhom1_nganh!,
          };
        }
        summaryByGroup[key].count += 1;
      }

      return {
        total: parsedItems.length,
        validCount: validItems.length,
        errorCount: errorItems.length,
        isLiveCloud,
        placeID,
        warningMessage,
        isPlaceIdAutoCorrected,
        sectorCounts: {
          TN: tnCount,
          LG: lgCount,
          LM: lmCount,
          ERROR: errorItems.length,
        },
        summaryByGroup,
        items: parsedItems,
      };
    }

    // 11b. GET /api/admin/hanet/status (Kiểm tra trạng thái cấu hình & kết nối HANET Cloud)
    protectedRoutes.get('/hanet/status', async (_request, reply) => {
      const token = process.env.HANET_ACCESS_TOKEN || process.env.HANET_TOKEN || '';
      const placeID = process.env.HANET_PLACE_ID || '998577';
      const baseUrl = (process.env.HANET_API_BASE_URL || 'https://partner.hanet.ai').replace(/\/$/, '');
      const queueWaiting = await registrationQueue.getWaitingCount();
      const queueActive = await registrationQueue.getActiveCount();

      return reply.send({
        success: true,
        configured: Boolean(token),
        place_id: placeID,
        base_url: baseUrl,
        queue: {
          waiting: queueWaiting,
          active: queueActive,
        },
      });
    });

    // 12. GET /api/admin/hanet/cloud-faces (Tra cứu & Bóc tách Face ID HANET Cloud với Auto-Pagination)
    protectedRoutes.get('/hanet/cloud-faces', async (request, reply) => {
      const query = request.query as { refresh?: string };
      const shouldRefresh = query?.refresh === 'true';
      const cacheKey = 'cache:hanet:real_cloud_faces';

      // 1. Kiểm tra Redis Cache 60s (Graceful Fallback)
      if (!shouldRefresh) {
        try {
          const cached = await redis.get(cacheKey);
          if (cached) {
            const parsedPayload = JSON.parse(cached);
            try {
              const validStagingInputs = (parsedPayload.items || [])
                .filter((item: any) => !item.isError && item.personID)
                .map((item: any) => ({
                  personID: item.personID,
                  aliasID: item.aliasChuanHoaDuKien || item.rawAliasID,
                  name: item.name,
                  faceUrl: item.file || null,
                  classCode: item.maLopChuanHoa,
                }));
              await upsertStagingCloudFaces(fastify.pg, validStagingInputs);
            } catch (stgErr) {
              request.log.warn({ err: stgErr }, 'Upsert staging_cloud_faces from cache failed');
            }
            return reply.send({ success: true, data: parsedPayload, fromCache: true });
          }
        } catch (err) {
          request.log.warn({ err }, 'Redis cache get failed, fallback to direct fetch');
        }
      }

      // 2. Lấy cấu hình HANET Cloud
      const token = process.env.HANET_ACCESS_TOKEN || process.env.HANET_TOKEN || '';
      const placeID = process.env.HANET_PLACE_ID || '998577';
      const primaryUrl = (process.env.HANET_API_BASE_URL || 'https://partner.hanet.ai').replace(/\/$/, '');

      if (!token) {
        return reply.status(500).send({
          success: false,
          message: 'Thiếu cấu hình HANET_ACCESS_TOKEN trong biến môi trường (.env)',
        });
      }

      try {
        const { rawList, isLiveCloud, resolvedPlaceID, isAutoCorrected, warningMessage } =
          await fetchAllRawCloudFaces(token, placeID, primaryUrl, request.log);
        const responsePayload = processCloudFaces(
          rawList,
          resolvedPlaceID,
          isLiveCloud,
          isAutoCorrected,
          warningMessage
        );

        // Đồng bộ danh sách khuôn mặt hợp lệ vào bảng staging_cloud_faces để phục vụ đối soát Offline Giai đoạn 1
        try {
          const validStagingInputs = responsePayload.items
            .filter((item) => !item.isError && item.personID)
            .map((item) => ({
              personID: item.personID,
              aliasID: item.aliasChuanHoaDuKien || item.rawAliasID,
              name: item.name,
              faceUrl: item.file || null,
              classCode: item.maLopChuanHoa,
            }));
          await upsertStagingCloudFaces(fastify.pg, validStagingInputs);
        } catch (stgErr) {
          request.log.warn({ err: stgErr }, 'Upsert staging_cloud_faces failed');
        }

        // Lưu Cache 1800s (30 phút) để bảo vệ hạn ngạch và băng thông
        try {
          await redis.set(cacheKey, JSON.stringify(responsePayload), 'EX', 1800);
        } catch (err) {
          request.log.warn({ err }, 'Redis cache set failed');
        }

        return reply.send({ success: true, data: responsePayload, fromCache: false });
      } catch (err: any) {
        if (err.returnCode === -103 || err.message === 'HANET_TOKEN_EXPIRED') {
          return reply.status(401).send({
            success: false,
            returnCode: -103,
            message: 'HANET Access Token đã hết hạn! Vui lòng cập nhật .env và restart server.',
          });
        }
        request.log.error({ err }, 'Failed to fetch cloud faces');
        return reply.status(502).send({
          success: false,
          message: `Lỗi kết nối tới dịch vụ HANET Cloud: ${err.message || 'Lỗi không xác định'}`,
        });
      }
    });

    // 13. GET /api/admin/hanet/data-drift (Đối Soát Lệch Dữ Liệu Cloud vs Database Nội Bộ)
    protectedRoutes.get('/hanet/data-drift', async (request, reply) => {
      const query = request.query as { refresh?: string };
      const shouldRefresh = query?.refresh === 'true';
      const cacheKey = 'cache:hanet:real_cloud_faces';

      let cloudData: CloudInspectorResponse | null = null;

      // 1. Lấy dữ liệu Cloud (ưu tiên từ Cache nếu không ép refresh)
      if (!shouldRefresh) {
        try {
          const cached = await redis.get(cacheKey);
          if (cached) cloudData = JSON.parse(cached);
        } catch (err) {
          request.log.warn({ err }, 'Redis cache get failed for data drift');
        }
      }

      if (!cloudData) {
        const token = process.env.HANET_ACCESS_TOKEN || process.env.HANET_TOKEN || '';
        const placeID = process.env.HANET_PLACE_ID || '998577';
        const primaryUrl = (process.env.HANET_API_BASE_URL || 'https://partner.hanet.ai').replace(/\/$/, '');

        if (!token) {
          return reply.status(500).send({ success: false, message: 'Thiếu cấu hình HANET_ACCESS_TOKEN (.env)' });
        }

        try {
          const { rawList, isLiveCloud, resolvedPlaceID, isAutoCorrected, warningMessage } =
            await fetchAllRawCloudFaces(token, placeID, primaryUrl, request.log);
          cloudData = processCloudFaces(
            rawList,
            resolvedPlaceID,
            isLiveCloud,
            isAutoCorrected,
            warningMessage
          );
          await redis.set(cacheKey, JSON.stringify(cloudData), 'EX', 60);
        } catch (err: any) {
          return reply.status(502).send({
            success: false,
            message: `Lỗi kết nối Cloud: ${err.message || 'Không thể lấy dữ liệu'}`,
          });
        }
      }

      // 2. Lấy dữ liệu học sinh & lớp học từ PostgreSQL
      const dbResult = await fastify.pg.query<{
        id: number;
        name: string;
        alias_id: string;
        status: string;
        person_id: string | null;
        class_code: string | null;
      }>(`
        SELECT s.id, s.name, s.alias_id, s.status, s.person_id, c.code as class_code
        FROM students s
        LEFT JOIN classes c ON s.class_id = c.id
      `);
      const dbStudents = dbResult.rows;

      // 3. Xây dựng Hash Maps đối soát 2 chiều
      const cloudFaces = cloudData.items;
      const cloudByPersonId = new Map<string, ParsedCloudResult>();
      const cloudByAliasId = new Map<string, ParsedCloudResult>();

      for (const face of cloudFaces) {
        if (face.personID) cloudByPersonId.set(face.personID, face);
        if (face.rawAliasID) cloudByAliasId.set(face.rawAliasID.toLowerCase(), face);
      }

      const dbByPersonId = new Map<string, typeof dbStudents[0]>();
      const dbByAliasId = new Map<string, typeof dbStudents[0]>();

      for (const s of dbStudents) {
        if (s.person_id) dbByPersonId.set(s.person_id, s);
        if (s.alias_id) dbByAliasId.set(s.alias_id.toLowerCase(), s);
      }

      const driftItems: DataDriftItem[] = [];
      let matchedCount = 0;

      // A. Kiểm tra CLOUD_ONLY: Có trên Cloud nhưng không có trong DB
      for (const face of cloudFaces) {
        const foundInDb =
          (face.personID && dbByPersonId.has(face.personID)) ||
          (face.rawAliasID && dbByAliasId.has(face.rawAliasID.toLowerCase()));

        if (!foundInDb) {
          driftItems.push({
            type: 'CLOUD_ONLY',
            personID: face.personID,
            aliasID: face.rawAliasID,
            cloudName: face.name,
            classCode: face.maLopChuanHoa || face.nhom2_lop,
            message: `Hồ sơ '${face.name}' (${face.rawAliasID}) có trên Cloud nhưng chưa có trong Database nội bộ`,
          });
        }
      }

      // B. Kiểm tra DB_ORPHAN, STATUS_MISMATCH, ALIAS_MISMATCH từ phía DB
      for (const s of dbStudents) {
        if (s.status === 'success' && s.person_id) {
          const cloudFace = cloudByPersonId.get(s.person_id);
          if (!cloudFace) {
            // DB báo success nhưng Cloud không có personID
            driftItems.push({
              type: 'DB_ORPHAN',
              personID: s.person_id,
              aliasID: s.alias_id,
              studentName: s.name,
              classCode: s.class_code || undefined,
              dbStatus: s.status,
              message: `Học sinh '${s.name}' trong DB báo thành công nhưng không tìm thấy personID trên Cloud`,
            });
          } else {
            matchedCount++;
            // Kiểm tra lệch aliasID
            if (cloudFace.rawAliasID.toLowerCase() !== s.alias_id.toLowerCase()) {
              driftItems.push({
                type: 'ALIAS_MISMATCH',
                personID: s.person_id,
                aliasID: s.alias_id,
                studentName: s.name,
                classCode: s.class_code || undefined,
                cloudName: cloudFace.name,
                message: `Lệch aliasID: DB là '${s.alias_id}', Cloud là '${cloudFace.rawAliasID}'`,
              });
            }
          }
        }
      }

      const report: DataDriftReport = {
        totalCloudFaces: cloudFaces.length,
        totalDbStudents: dbStudents.length,
        matchedCount,
        cloudOnlyCount: driftItems.filter((i) => i.type === 'CLOUD_ONLY').length,
        dbOrphanCount: driftItems.filter((i) => i.type === 'DB_ORPHAN').length,
        mismatchCount: driftItems.filter((i) => i.type === 'ALIAS_MISMATCH' || i.type === 'STATUS_MISMATCH').length,
        driftItems,
      };

      return reply.send({ success: true, data: report });
    });

    // 14. POST /api/admin/sync-alias (Đồng bộ AliasID và Đăng ký theo lô vào BullMQ)
    protectedRoutes.post('/sync-alias', {
      schema: {
        body: {
          type: 'object',
          properties: {
            student_ids: { type: 'array', items: { type: 'number' } },
            class_id: { type: 'number' },
            force_update_photo: { type: 'boolean' },
            force_pending: { type: 'boolean' },
          },
        },
      },
    }, async (request, reply) => {
      const body = request.body as {
        student_ids?: number[];
        class_id?: number;
        force_update_photo?: boolean;
        force_pending?: boolean;
      };

      if (!body.class_id && (!body.student_ids || body.student_ids.length === 0)) {
        return reply.status(400).send({
          success: false,
          message: 'Vui lòng cung cấp class_id hoặc danh sách student_ids để đồng bộ',
        });
      }

      // 1. Xác định danh sách student ID
      let targetStudentIds: number[] = [];
      if (body.class_id) {
        const classStudentsRes = await fastify.pg.query<{ id: number }>(
          'SELECT id FROM students WHERE class_id = $1',
          [body.class_id]
        );
        targetStudentIds = classStudentsRes.rows.map((r) => r.id);
      } else if (body.student_ids) {
        targetStudentIds = body.student_ids;
      }

      if (targetStudentIds.length === 0) {
        return reply.status(400).send({
          success: false,
          message: 'Không tìm thấy học sinh nào thuộc điều kiện đồng bộ',
        });
      }

      // 2. Atomic Conditional Update: Chuyển các bản ghi hợp lệ sang 'pending'
      const statusClause = body.force_pending
        ? `AND (status IN ('empty', 'error', 'manual_review', 'conflict_pending_review', 'success', 'synced') OR (status = 'pending' AND updated_at < NOW() - INTERVAL '30 seconds'))`
        : `AND status IN ('empty', 'error', 'manual_review', 'conflict_pending_review', 'success', 'synced')`;

      const updateResult = await fastify.pg.query<{
        id: number;
        class_id: number | null;
        name: string;
        alias_id: string;
        person_id: string | null;
      }>(
        `UPDATE students
         SET status = 'pending', updated_at = NOW()
         WHERE id = ANY($1)
           ${statusClause}
         RETURNING id, class_id, name, alias_id, person_id`,
        [targetStudentIds]
      );

      const eligibleStudents = updateResult.rows;
      if (eligibleStudents.length === 0) {
        return reply.send({
          success: true,
          batchId: null,
          queuedCount: 0,
          message: 'Tất cả học sinh đã chọn hiện đang ở trạng thái pending xử lý, không cần đưa vào hàng đợi lại.',
        });
      }

      // 3. Tải bản đồ thông tin lớp (classes) để map class code
      const classesRes = await fastify.pg.query<{ id: number; code: string }>(
        'SELECT id, code FROM classes'
      );
      const classMap = new Map<number, { code: string; departmentCode: string }>();
      for (const c of classesRes.rows) {
        classMap.set(c.id, {
          code: c.code,
          departmentCode: c.code,
        });
      }

      // 4. Khởi tạo Batch ID và Redis Hash với TTL 7200s (2 giờ)
      const batchId = `batch_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
      const batchKey = `batch:${batchId}`;
      await redis.hset(batchKey, {
        batch_id: batchId,
        total: eligibleStudents.length,
        processed: 0,
        success: 0,
        failed: 0,
        is_done: '0',
        created_at: new Date().toISOString(),
      });
      await redis.expire(batchKey, 7200);

      // 5. Enqueue từng job vào BullMQ registration_queue (Priority = 1 cho đơn lẻ, Priority = 20 cho Batch Sync)
      const batchPriority = eligibleStudents.length === 1 ? 1 : 20;
      const existingAliasesRes = await fastify.pg.query<{ alias_id: string; person_id: string | null }>(
        'SELECT alias_id, person_id FROM students WHERE alias_id IS NOT NULL'
      );
      const usedAliases = new Map<string, string>(
        existingAliasesRes.rows.map((r) => [r.alias_id.toUpperCase(), r.person_id || r.alias_id])
      );

      for (const s of eligibleStudents) {
        const classInfo = s.class_id ? classMap.get(s.class_id) : undefined;
        const deptId = classInfo?.departmentCode || '0';
        const classCode = classInfo?.code || 'DEFAULT';

        if (s.person_id) {
          // Tính toán mã chuẩn hóa 9 ký tự qua parseAndClassifyAlias + Linear Probing
          const parsed = parseAndClassifyAlias({
            personID: s.person_id,
            name: s.name,
            aliasID: s.alias_id || `${classCode}_0000`,
          });
          const prefix4 = parsed.maLopChuanHoa || classCode;
          const targetAlias = resolveDeterministicAliasInMemory(
            prefix4,
            s.person_id,
            usedAliases
          ).aliasId;

          // Job update_alias: Quy trình 2 bước đổi alias & bảo toàn phòng ban
          await registrationQueue.add(
            'update_alias',
            {
              batchId,
              studentId: s.id,
              classId: s.class_id,
              aliasId: s.alias_id,
              newAlias: targetAlias,
              personId: s.person_id,
              studentName: s.name,
              departmentId: deptId,
            },
            {
              jobId: `update_alias_${batchId}_${s.id}`,
              priority: batchPriority,
            }
          );
        } else {
          // Job register_face: Đăng ký mới kèm ảnh
          await registrationQueue.add(
            'register_face',
            {
              batchId,
              studentId: s.id,
              classId: s.class_id,
              aliasId: s.alias_id,
              studentName: s.name,
              classCode,
              tempFilename: `${s.alias_id || s.id}.jpg`,
              actionType: 'REGISTER',
            },
            {
              jobId: `register_face_${batchId}_${s.id}`,
              priority: batchPriority,
            }
          );
        }
      }

      return reply.status(202).send({
        success: true,
        batchId,
        queuedCount: eligibleStudents.length,
        message: `Đã đưa ${eligibleStudents.length} học sinh vào hàng đợi đồng bộ`,
      });
    });

    // 14b. POST /api/admin/hanet/sync-cloud-aliases (Chuẩn hóa Face ID trên Cloud HANET về chuẩn 9 ký tự: 1 người, chọn lọc, hoặc toàn bộ)
    protectedRoutes.post('/hanet/sync-cloud-aliases', async (request, reply) => {
      const body = (request.body || {}) as { person_ids?: string[] };
      const selectedPersonIds = Array.isArray(body.person_ids) && body.person_ids.length > 0
        ? new Set(body.person_ids.map((id) => String(id).trim()))
        : null;

      const cacheKey = 'cache:hanet:real_cloud_faces';
      let cloudData: CloudInspectorResponse | null = null;

      // 1. Ưu tiên đọc từ Redis Cache trước để tránh bão mạng HANET Cloud
      try {
        const cached = await redis.get(cacheKey);
        if (cached) {
          cloudData = JSON.parse(cached) as CloudInspectorResponse;
        }
      } catch (err) {
        request.log.warn({ err }, 'Redis cache get failed in sync-cloud-aliases');
      }

      // Chỉ gọi mạng HANET Cloud khi Cache Miss
      if (!cloudData) {
        const token = process.env.HANET_ACCESS_TOKEN || process.env.HANET_TOKEN || '';
        const placeID = process.env.HANET_PLACE_ID || '998577';
        const primaryUrl = (process.env.HANET_API_BASE_URL || 'https://partner.hanet.ai').replace(/\/$/, '');

        if (!token) {
          return reply.status(500).send({
            success: false,
            message: 'Thiếu cấu hình HANET_ACCESS_TOKEN (.env)',
          });
        }

        try {
          const { rawList, isLiveCloud, resolvedPlaceID, isAutoCorrected, warningMessage } =
            await fetchAllRawCloudFaces(token, placeID, primaryUrl, request.log);
          cloudData = processCloudFaces(
            rawList,
            resolvedPlaceID,
            isLiveCloud,
            isAutoCorrected,
            warningMessage
          );
          try {
            await redis.set(cacheKey, JSON.stringify(cloudData), 'EX', 1800);
          } catch (cacheErr) {
            request.log.warn({ err: cacheErr }, 'Redis cache set failed in sync-cloud-aliases');
          }
        } catch (err: any) {
          request.log.error({ err }, 'Failed to fetch cloud faces for sync');
          return reply.status(502).send({
            success: false,
            message: `Lỗi kết nối HANET Cloud: ${err.message || 'Không thể lấy dữ liệu'}`,
          });
        }
      }

      // 2. Lọc các khuôn mặt hợp lệ có aliasChuanHoaDuKien (và lọc theo person_ids nếu có)
      let validItems = cloudData.items.filter((item) => !item.isError && item.aliasChuanHoaDuKien);
      if (selectedPersonIds) {
        validItems = validItems.filter((item) => selectedPersonIds.has(item.personID));
      }

      if (validItems.length === 0) {
        return reply.send({
          success: true,
          batchId: null,
          queuedCount: 0,
          message: selectedPersonIds
            ? 'Không tìm thấy khuôn mặt hợp lệ nào trong danh sách đã chọn.'
            : 'Không tìm thấy khuôn mặt nào cần chuẩn hóa trên Cloud.',
        });
      }

      // 3. Tải danh sách học sinh hiện có trong DB để ánh xạ person_id & chống va chạm alias_id
      const existingStudentsRes = await fastify.pg.query<{ id: number; person_id: string | null; alias_id: string | null }>(
        'SELECT id, person_id, alias_id FROM students WHERE person_id IS NOT NULL OR alias_id IS NOT NULL'
      );
      const studentByPersonId = new Map<string, { id: number; person_id: string | null; alias_id: string | null }>();
      const usedAliases = new Map<string, string>();
      for (const r of existingStudentsRes.rows) {
        if (r.person_id) studentByPersonId.set(r.person_id, r);
        if (r.alias_id) usedAliases.set(r.alias_id.toUpperCase(), r.person_id || String(r.id));
      }

      // Tải danh sách lớp để ánh xạ maLopChuanHoa -> class_id
      const classesRes = await fastify.pg.query<{ id: number; code: string }>(
        'SELECT id, code FROM classes'
      );
      const classByCode = new Map(classesRes.rows.map((c) => [c.code.toUpperCase(), c.id]));
      const defaultClassId = classesRes.rows.length > 0 ? classesRes.rows[0]?.id : null;

      // 4. Chuẩn bị danh sách jobs và auto-provision các học sinh chưa có trong DB
      const targetJobs: Array<{
        studentId: number;
        classId?: number | undefined;
        aliasId: string;
        newAlias: string;
        personId: string;
        studentName: string;
        departmentId: string | number;
      }> = [];

      for (const item of validItems) {
        let studentId: number;
        let classId: number | undefined;
        const faceUrl = item.file || null;
        const normalizedName = normalizeVietnameseStudentName(item.name);

        const matchedClassId = item.maLopChuanHoa ? classByCode.get(item.maLopChuanHoa.toUpperCase()) : undefined;
        classId = matchedClassId || defaultClassId || undefined;

        if (studentByPersonId.has(item.personID)) {
          const existing = studentByPersonId.get(item.personID)!;
          studentId = existing.id;
          await fastify.pg.query(
            `UPDATE students
             SET status = 'pending',
                 face_url = COALESCE($2, face_url),
                 class_id = COALESCE($3, class_id),
                 normalized_name = COALESCE(normalized_name, $4),
                 updated_at = NOW()
             WHERE id = $1`,
            [studentId, faceUrl, matchedClassId || null, normalizedName]
          );
        } else {
          // Kiểm tra xem trong lớp đã có bản ghi 'empty' (chưa có person_id) trùng tên chuẩn hóa chưa để gộp trực tiếp
          const existingEmptyRes = classId
            ? await fastify.pg.query<{ id: number }>(
                `SELECT id FROM students
                 WHERE class_id = $1 AND normalized_name = $2 AND person_id IS NULL
                 ORDER BY id ASC LIMIT 1`,
                [classId, normalizedName]
              )
            : { rows: [] };

          if (existingEmptyRes.rows.length > 0 && existingEmptyRes.rows[0]) {
            studentId = existingEmptyRes.rows[0].id;
            await fastify.pg.query(
              `UPDATE students
               SET person_id = $2,
                   face_url = COALESCE($3, face_url),
                   status = 'pending',
                   updated_at = NOW()
               WHERE id = $1`,
              [studentId, item.personID, faceUrl]
            );
          } else {
            // Auto-provision học sinh thiếu nhi chưa có trong DB VPS (kèm qr_token 16 ký tự, normalized_name & face_url)
            const qrToken = generateQrToken();
            const insertRes = await fastify.pg.query<{ id: number }>(
              `INSERT INTO students (name, normalized_name, alias_id, qr_token, person_id, face_url, class_id, status, cloud_alias_synced, created_at, updated_at)
               VALUES ($1, $2, NULL, $3, $4, $5, $6, 'pending', FALSE, NOW(), NOW())
               ON CONFLICT (person_id) DO UPDATE 
               SET name = EXCLUDED.name,
                   normalized_name = EXCLUDED.normalized_name,
                   face_url = COALESCE(EXCLUDED.face_url, students.face_url),
                   class_id = COALESCE(EXCLUDED.class_id, students.class_id),
                   status = 'pending',
                   updated_at = NOW()
               RETURNING id`,
              [item.name, normalizedName, qrToken, item.personID, faceUrl, classId || null]
            );
            studentId = insertRes.rows[0]!.id;
          }
        }

        const resolvedNewAlias = resolveDeterministicAliasInMemory(
          item.maLopChuanHoa || 'TS1A',
          item.personID,
          usedAliases
        ).aliasId;

        // Risk A: Xác định departmentId an toàn
        const finalDeptId = (item.departmentID && String(item.departmentID) !== '0')
          ? String(item.departmentID)
          : (item.nhom1_nganh === 'LM' ? '990730' : '990653');

        targetJobs.push({
          studentId,
          classId,
          aliasId: item.rawAliasID,
          newAlias: resolvedNewAlias,
          personId: item.personID,
          studentName: item.name,
          departmentId: finalDeptId,
        });
      }

      // 5. Khởi tạo Batch ID và Redis Hash với TTL 7200s (2 giờ)
      const batchId = `batch_cloud_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
      const batchKey = `batch:${batchId}`;
      await redis.hset(batchKey, {
        batch_id: batchId,
        total: targetJobs.length,
        processed: 0,
        success: 0,
        failed: 0,
        is_done: '0',
        created_at: new Date().toISOString(),
      });
      await redis.expire(batchKey, 7200);

      // 6. Enqueue từng job vào BullMQ registration_queue
      // Level 1 (SINGLE: 1 person) -> Priority = 1; Level 2/3 (Batch) -> Priority = 20 để nhường Học sinh nộp ảnh mới (Priority = 5)
      const jobPriority = selectedPersonIds && selectedPersonIds.size === 1 ? 1 : 20;

      for (const j of targetJobs) {
        await registrationQueue.add(
          'update_alias',
          {
            batchId,
            studentId: j.studentId,
            classId: j.classId,
            aliasId: j.aliasId,
            newAlias: j.newAlias,
            personId: j.personId,
            studentName: j.studentName,
            departmentId: j.departmentId,
          },
          {
            jobId: `update_alias_cloud_${batchId}_${j.personId}`,
            priority: jobPriority,
          }
        );
      }

      return reply.status(202).send({
        success: true,
        batchId,
        queuedCount: targetJobs.length,
        message: `Đã đưa ${targetJobs.length} khuôn mặt vào hàng đợi chuẩn hóa AliasID 9 ký tự trên Cloud HANET`,
      });
    });

    // 14c. POST /api/admin/hanet/retry-unsynced-aliases (Quét các bản ghi cloud_alias_synced = FALSE quá 30 giây và đẩy vào hàng đợi Priority = 20)
    protectedRoutes.post('/hanet/retry-unsynced-aliases', async (_request, reply) => {
      const unsyncedStudents = await studentRepo.getUnsyncedCloudAliasesForRetry(100);
      if (unsyncedStudents.length === 0) {
        return reply.send({
          success: true,
          queuedCount: 0,
          message: 'Tất cả học sinh đã đồng bộ AliasID 9 ký tự lên Cloud HANET.',
        });
      }


      const classesRes = await fastify.pg.query<{ id: number; code: string }>(
        'SELECT id, code FROM classes'
      );
      const classById = new Map(classesRes.rows.map((c) => [c.id, c.code]));

      const batchId = `batch_retry_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
      const batchKey = `batch:${batchId}`;
      await redis.hset(batchKey, {
        batch_id: batchId,
        total: unsyncedStudents.length,
        processed: 0,
        success: 0,
        failed: 0,
        is_done: '0',
        created_at: new Date().toISOString(),
      });
      await redis.expire(batchKey, 7200);

      for (const s of unsyncedStudents) {
        if (!s.person_id || !s.alias_id) continue;
        const classCode = classById.get(s.class_id) || 'TS1A';
        await registrationQueue.add(
          'update_alias',
          {
            batchId,
            studentId: s.id,
            classId: s.class_id,
            aliasId: s.alias_id,
            newAlias: s.alias_id,
            personId: s.person_id,
            studentName: s.name,
            departmentId: classCode.startsWith('LM') ? '990730' : '990653',
          },
          {
            jobId: `retry_alias_${batchId}_${s.id}`,
            priority: 20, // Background retry priority = 20
          }
        );
      }

      return reply.status(202).send({
        success: true,
        batchId,
        queuedCount: unsyncedStudents.length,
        message: `Đã đưa ${unsyncedStudents.length} bản ghi chưa đồng bộ Cloud Alias (quá 30s) vào hàng đợi chạy nền (Priority 20).`,
      });
    });

    // 14d. POST /api/admin/staging/cleanup (Chính sách dọn dẹp bảng nháp sau 7 ngày vận hành ổn định)
    protectedRoutes.post('/staging/cleanup', async (_request, reply) => {
      await cleanupStagingCloudFaces(fastify.pg);
      return reply.send({
        success: true,
        message: 'Đã thực thi TRUNCATE TABLE staging_cloud_faces để giải phóng dung lượng SSD.',
      });
    });

    // 14e. POST /api/admin/stage1/snapshot-seed (Nạp hàng loạt 1.200 học sinh Excel/CSV/JSON & Đối soát Offline 100% với staging_cloud_faces)
    protectedRoutes.post('/stage1/snapshot-seed', async (request, reply) => {
      const startTime = Date.now();
      try {
        const body = (request.body || {}) as {
          items?: Array<{ classCode?: string; name?: string }>;
        };
        const items = body.items;

        if (!Array.isArray(items) || items.length === 0) {
          return reply.status(400).send({
            success: false,
            message: 'Danh sách học sinh không hợp lệ hoặc rỗng.',
          });
        }

        if (items.length > 5000) {
          return reply.status(400).send({
            success: false,
            message: 'Tối đa 5.000 học sinh trong một lần nạp hàng loạt.',
          });
        }

        const CODE_REGEX = /^[A-Z0-9_-]{2,20}$/;
        const sanitizedItems: Array<{ classCode: string; name: string }> = [];
        let invalidCount = 0;

        for (const it of items) {
          const cleanCode = String(it?.classCode || '').trim().toUpperCase();
          const cleanName = sanitizeStudentName(String(it?.name || ''));
          if (!cleanCode || !CODE_REGEX.test(cleanCode) || cleanName.length < 2 || cleanName.length > 100) {
            invalidCount++;
            continue;
          }
          sanitizedItems.push({ classCode: cleanCode, name: cleanName });
        }

        if (invalidCount > 0 || sanitizedItems.length === 0) {
          return reply.status(422).send({
            success: false,
            message:
              invalidCount > 0
                ? `Có ${invalidCount} dòng dữ liệu bị thiếu hoặc sai định dạng Mã lớp (2-20 ký tự) / Họ tên (2-100 ký tự).`
                : 'Không có dòng dữ liệu học sinh hợp lệ để nạp.',
          });
        }

        // Thực thi Transaction nguyên khối Offline 100% với bảng staging_cloud_faces (< 100ms)
        const result = await executeStage1SnapshotAndSeed(fastify.pg, sanitizedItems);
        const executionDurationMs = result.transactionDurationMs || (Date.now() - startTime);

        const ip = request.ip || (request.headers['x-forwarded-for'] as string) || null;
        await logRepo.recordLog({
          action: 'STAGE1_BATCH_SEED',
          result_code: '1',
          result_message: `Admin nạp hàng loạt Giai đoạn 1: Tổng ${result.totalExcelInput} em (Thêm mới: ${result.insertedStudentsCount}, Bỏ qua trùng: ${result.skippedDuplicateCount}, Khớp Cloud: ${result.matchedFromExcelCount}, Auto-INSERT Cloud: ${result.autoInsertedFromCloudCount}) trong ${executionDurationMs}ms`,
          ip,
        });

        return reply.status(200).send({
          success: true,
          data: {
            totalImported: result.totalExcelInput,
            insertedStudentsCount: result.insertedStudentsCount,
            skippedDuplicateCount: result.skippedDuplicateCount,
            classesCreated: result.classesCreatedCount,
            matchedCloudFaces: result.matchedFromExcelCount + result.autoInsertedFromCloudCount,
            matchedFromExcelCount: result.matchedFromExcelCount,
            autoInsertedFromCloudCount: result.autoInsertedFromCloudCount,
            emptyNewStudents: result.emptyNewStudentsCount,
            executionDurationMs,
          },
          message: `Đã xử lý thành công ${result.totalExcelInput} học sinh trong ${executionDurationMs}ms.`,
        });
      } catch (error: any) {
        request.log.error({ err: error }, '[STAGE 1 SEED ERROR]');
        return reply.status(500).send({
          success: false,
          message: error.message || 'Lỗi hệ thống khi nạp dữ liệu Giai đoạn 1.',
        });
      }
    });

    // 15. GET /api/admin/sync-batches/:batchId/status (Short Polling tiến độ batch 3s)
    protectedRoutes.get('/sync-batches/:batchId/status', async (request, reply) => {
      const { batchId } = request.params as { batchId: string };
      const batchKey = `batch:${batchId}`;
      const data = await redis.hgetall(batchKey);

      if (!data || Object.keys(data).length === 0) {
        return reply.status(404).send({
          success: false,
          message: 'Không tìm thấy batch tiến trình hoặc đã hết hạn lưu trữ',
        });
      }

      return reply.send({
        success: true,
        data: {
          batchId,
          total: Number(data.total || 0),
          processed: Number(data.processed || 0),
          success: Number(data.success || 0),
          failed: Number(data.failed || 0),
          isDone: data.is_done === '1' || data.is_done === 'true',
          createdAt: data.created_at,
        },
      });
    });

    // 16. POST /api/admin/reconcile-cloud (Kích hoạt nạp cache Cloud 10 phút & đối soát)
    protectedRoutes.post('/reconcile-cloud', async (request, reply) => {
      const cacheKey = 'cache:hanet:real_cloud_faces';
      const token = process.env.HANET_ACCESS_TOKEN || process.env.HANET_TOKEN || '';
      const placeID = process.env.HANET_PLACE_ID || '998577';
      const primaryUrl = (process.env.HANET_API_BASE_URL || 'https://partner.hanet.ai').replace(/\/$/, '');

      if (!token) {
        return reply.status(500).send({
          success: false,
          message: 'Thiếu cấu hình HANET_ACCESS_TOKEN trong .env',
        });
      }

      try {
        const { rawList, isLiveCloud, resolvedPlaceID, isAutoCorrected, warningMessage } =
          await fetchAllRawCloudFaces(token, placeID, primaryUrl, request.log);
        const responsePayload = processCloudFaces(
          rawList,
          resolvedPlaceID,
          isLiveCloud,
          isAutoCorrected,
          warningMessage
        );

        // Đồng bộ vào bảng staging_cloud_faces để phục vụ đối soát Offline Giai đoạn 1
        try {
          const validStagingInputs = responsePayload.items
            .filter((item) => !item.isError && item.personID)
            .map((item) => ({
              personID: item.personID,
              aliasID: item.aliasChuanHoaDuKien || item.rawAliasID,
              name: item.name,
              faceUrl: item.file || null,
              classCode: item.maLopChuanHoa,
            }));
          await upsertStagingCloudFaces(fastify.pg, validStagingInputs);
        } catch (stgErr) {
          request.log.warn({ err: stgErr }, 'Upsert staging_cloud_faces failed in reconcile-cloud');
        }

        // Lưu Cache 1800s (30 phút)
        await redis.set(cacheKey, JSON.stringify(responsePayload), 'EX', 1800);

        return reply.send({
          success: true,
          message: `Đã tải và cache ${responsePayload.total} khuôn mặt từ Cloud (TTL 30 phút)`,
          data: {
            totalFaces: responsePayload.total,
            validCount: responsePayload.validCount,
            errorCount: responsePayload.errorCount,
          },
        });
      } catch (err: any) {
        if (err.returnCode === -103 || err.message === 'HANET_TOKEN_EXPIRED') {
          return reply.status(401).send({
            success: false,
            returnCode: -103,
            message: 'HANET Access Token đã hết hạn (-103)',
          });
        }
        return reply.status(502).send({
          success: false,
          message: `Lỗi kết nối HANET Cloud: ${err.message || 'Không thể đồng bộ'}`,
        });
      }
    });
  });
};

