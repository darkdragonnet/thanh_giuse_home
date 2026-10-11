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
} from '@thanh-giuse/shared-types';
import type { Queue } from 'bullmq';
import type { Redis } from 'ioredis';
import type { Pool } from 'pg';
import type {
  ClassRepository,
  StudentRepository,
  LogRepository,
  AdminRequestRepository,
  SettingsRepository,
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

      // Đẩy job xử lý ưu tiên số 1 (High Priority)
      await registrationQueue.add(
        'SYNC_FACE',
        {
          studentId: student.id,
          aliasId: student.alias_id,
          name: student.name,
          studentName: student.name,
          rawImagePath: tempFilePath,
          tempFilename: tempFileName,
          actionType: student.person_id ? 'UPDATE_PHOTO' : 'REGISTER',
          personId: student.person_id,
          uploadedAt: Date.now(),
        },
        {
          priority: 1, // BullMQ: Priority thấp hơn = Chạy trước (Priority 1 > Priority 10)
          jobId: `override_${student.alias_id}_${Date.now()}`,
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
        class_id: student.class_id,
        alias_id: student.alias_id,
        action: 'DELETE_STUDENT',
        result_code: '1',
        result_message: `Admin đã xóa học sinh ${student.name} (${student.alias_id}) khỏi lớp`,
        ip,
      });

      return reply.send({
        success: true,
        message: `Đã xóa học sinh ${student.name} thành công`,
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

      // true: Tiếp tục mở nhận đăng ký; false: Chặn đăng ký (kích hoạt bảo trì)
      const registrationValue = body.enabled ? 'true' : 'false';
      const killSwitchRedisValue = body.enabled ? 'false' : 'true';

      await settingsRepo.set('registration_enabled', registrationValue);
      await redis.set('setting:kill_switch', killSwitchRedisValue);

      return reply.send({
        success: true,
        message: body.enabled
          ? 'Hệ thống đã MỞ LẠI cho phép học sinh nộp ảnh.'
          : 'Hệ thống đã BẬT CHẾ ĐỘ BẢO TRÌ (tạm dừng tiếp nhận ảnh mới).'
      });
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

    // Helper lấy danh sách đầy đủ Face ID (kèm Auto-Pagination)
    async function fetchAllRawCloudFaces(
      token: string,
      placeID: string,
      primaryUrl: string,
      _log?: any
    ): Promise<{ rawList: RawCloudFace[]; connectedBaseUrl: string; isLiveCloud: boolean }> {
      const candidateUrls = [
        primaryUrl,
        'http://app_mock:4000',
        'http://localhost:8001',
        'http://127.0.0.1:4000',
      ].filter(Boolean) as string[];

      let connectedBaseUrl = primaryUrl;
      let lastFetchError: any = null;
      let rawList: RawCloudFace[] = [];

      for (const baseUrl of candidateUrls) {
        try {
          let page = 1;
          const size = 50;
          const maxPages = 5; // Chốt an toàn 1: Tối đa 5 trang (250 người)
          const collected: RawCloudFace[] = [];
          let prevFirstPersonID: string | null = null;
          let encounteredError = false;

          while (page <= maxPages) {
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 15000);

            const postData = new URLSearchParams({
              token,
              placeID,
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
      };
    }

    // Helper xây dựng CloudInspectorResponse từ rawList
    function processCloudFaces(
      rawList: RawCloudFace[],
      placeID: string,
      isLiveCloud: boolean
    ): CloudInspectorResponse {
      const parsedItems: ParsedCloudResult[] = rawList.map((face) => parseAndClassifyAlias(face));

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

        const key = item.nhom2_lop!.toLowerCase();
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
            return reply.send({ success: true, data: JSON.parse(cached), fromCache: true });
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
        const { rawList, isLiveCloud } = await fetchAllRawCloudFaces(token, placeID, primaryUrl, request.log);
        const responsePayload = processCloudFaces(rawList, placeID, isLiveCloud);

        // Lưu Cache 60s
        try {
          await redis.set(cacheKey, JSON.stringify(responsePayload), 'EX', 60);
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
          const { rawList, isLiveCloud } = await fetchAllRawCloudFaces(token, placeID, primaryUrl, request.log);
          cloudData = processCloudFaces(rawList, placeID, isLiveCloud);
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
  });
};
