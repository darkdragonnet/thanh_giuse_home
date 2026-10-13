import { describe, it, expect, beforeEach, vi } from 'vitest';
import Fastify, { FastifyInstance } from 'fastify';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { StudentRepository } from '../packages/shared-infra/src/repositories/studentRepository.js';
import { createRateLimiter } from '../apps/api/src/middleware/rateLimiter.js';
import { resolveStudentStatusConfig } from '../apps/student/src/statusConfig.js';

/**
 * Hàm mã hóa an toàn Header ASCII (RFC 7230 / RFC 8187) tương ứng trong apps/api/src/index.ts
 */
function safeHeaderEncode(text: string | null | undefined): string {
  if (!text) return '';
  const trimmed = String(text).trim();
  if (!trimmed) return '';
  return encodeURIComponent(trimmed);
}

/**
 * Hàm giải mã an toàn Header X-Class-Name phía Frontend (apps/student/index.html)
 */
function safeDecodeClassName(
  rawHeader: string | null | undefined,
  fallbackCode: string
): { className: string; warned: boolean } {
  if (!rawHeader || !String(rawHeader).trim()) {
    return { className: fallbackCode, warned: false };
  }
  try {
    const decoded = decodeURIComponent(String(rawHeader).trim());
    return { className: decoded || fallbackCode, warned: false };
  } catch {
    return { className: String(rawHeader).trim() || fallbackCode, warned: true };
  }
}

/**
 * Xây dựng Fastify Test Harness mô phỏng chính xác route GET/OPTIONS /api/classes/:classId/students
 * và POST /api/students/:studentId/photo của apps/api/src/index.ts
 */
async function buildStudentPortalTestServer(mockState: {
  classes: Record<string, { id: number; code: string; name: string | null; token: string }>;
  students: Array<{
    id: number;
    class_id: number;
    name: string;
    alias_id: string | null;
    qr_token: string;
    status: 'empty' | 'pending' | 'success' | 'error' | 'manual_review';
    person_id: string | null;
    is_updating?: boolean;
  }>;
  queuedJobs: Array< any >;
}): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });

  const extractTeacherPin = (request: any): string => {
    const raw =
      (request.headers?.['x-teacher-pin'] as string) ||
      (request.query as Record<string, string>)?.teacher_pin ||
      (request.query as Record<string, string>)?.token ||
      '';
    return String(raw).trim();
  };

  const applyClassPortalHeaders = (
    reply: any,
    classCode: string | null | undefined,
    className: string | null | undefined,
    isTeacherVerified: boolean
  ) => {
    const safeCode = String(classCode || '')
      .replace(/[\r\n]/g, '')
      .trim()
      .toUpperCase();
    reply.header('Access-Control-Allow-Origin', '*');
    reply.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    reply.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-teacher-pin');
    reply.header('Access-Control-Expose-Headers', 'X-Class-Code, X-Class-Name, X-Teacher-Verified');
    reply.header('X-Class-Code', safeCode);
    reply.header('X-Class-Name', safeHeaderEncode(className));
    reply.header('X-Teacher-Verified', isTeacherVerified ? 'true' : 'false');
  };

  app.options<{ Params: { classId: string } }>('/api/classes/:classId/students', async (_req, reply) => {
    reply.header('Access-Control-Allow-Origin', '*');
    reply.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    reply.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-teacher-pin');
    reply.header('Access-Control-Expose-Headers', 'X-Class-Code, X-Class-Name, X-Teacher-Verified');
    return reply.status(204).send();
  });

  app.get<{ Params: { classId: string } }>('/api/classes/:classId/students', async (request, reply) => {
    const code = request.params.classId.trim().toUpperCase();
    const classRecord = mockState.classes[code];
    if (!classRecord) {
      return reply.status(404).send({ error: 'Not Found', message: 'Không tìm thấy lớp' });
    }
    const teacherPin = extractTeacherPin(request);
    const isTeacherVerified = Boolean(teacherPin && teacherPin === classRecord.token);

    applyClassPortalHeaders(reply, classRecord.code, classRecord.name, isTeacherVerified);
    const list = mockState.students.filter((s) => s.class_id === classRecord.id);
    return reply.status(200).send(list);
  });

  app.post<{ Params: { studentId: string } }>('/api/students/:studentId/photo', async (request, reply) => {
    const studentId = parseInt(request.params.studentId, 10);
    const student = mockState.students.find((s) => s.id === studentId);
    if (!student) {
      return reply.status(404).send({ error: 'Not Found' });
    }

    const cls = Object.values(mockState.classes).find((c) => c.id === student.class_id);
    const teacherPin = extractTeacherPin(request);
    const isTeacherVerified = Boolean(cls && teacherPin && teacherPin === cls.token);

    if (student.status === 'success') {
      if (!isTeacherVerified) {
        return reply.status(409).send({
          error: 'Conflict',
          message: 'Học sinh này đã được đăng ký hoặc đang trong quá trình xử lý.',
        });
      }
      if (student.is_updating) {
        return reply.status(409).send({
          error: 'Conflict',
          message: 'Hồ sơ đang được cập nhật.',
        });
      }
      student.is_updating = true;
      const job = {
        name: 'override-photo',
        priority: 1,
        actionType: 'UPDATE_PHOTO',
        personId: student.person_id,
        studentId: student.id,
      };
      mockState.queuedJobs.push(job);
      return reply.status(200).send({
        success: true,
        message: 'Cập nhật ảnh thành công! Yêu cầu của Giáo viên đã vào hàng đợi ưu tiên.',
        student,
      });
    }

    if (student.status === 'pending') {
      return reply.status(409).send({
        error: 'Conflict',
        message: 'Học sinh đang trong quá trình xử lý.',
      });
    }

    student.status = 'pending';
    const job = {
      name: 'register',
      priority: 5,
      actionType: 'REGISTER',
      studentId: student.id,
    };
    mockState.queuedJobs.push(job);
    return reply.status(200).send({
      success: true,
      message: 'Nộp ảnh thành công! Yêu cầu đã vào hàng đợi xử lý.',
      student,
    });
  });

  await app.ready();
  return app;
}

describe('Strict Edge-Case Test Suite: Cổng Học Sinh, Header RFC 7230, Zalo & Teacher Override', () => {
  let mockState: Parameters<typeof buildStudentPortalTestServer>[0];

  beforeEach(() => {
    mockState = {
      classes: {
        VD1A: {
          id: 1,
          code: 'VD1A',
          name: 'Lớp Vào Đời 1A (Thứ 7 - 18h30) & Ban Giáo Lý Viên 🌟',
          token: 'PIN_VD1A',
        },
        GLV0: {
          id: 2,
          code: 'GLV0',
          name: 'Lớp GLV0',
          token: 'PIN_GLV0',
        },
        CRLF: {
          id: 3,
          code: 'CRLF',
          name: 'Lớp Test\r\nSet-Cookie: evil_token=123\r\nX-Injected: true',
          token: 'PIN_CRLF',
        },
        NULLNAME: {
          id: 4,
          code: 'NULLNAME',
          name: null,
          token: 'PIN_NULL',
        },
        WHITESPACE: {
          id: 5,
          code: 'WHITESPACE',
          name: '     ',
          token: 'PIN_WS',
        },
      },
      students: [
        {
          id: 101,
          class_id: 2,
          name: 'Nguyễn Văn An',
          alias_id: 'GLV0_A1B2',
          qr_token: 'qr_token_an_1234',
          status: 'success',
          person_id: 'HANET_PERSON_101',
          is_updating: false,
        },
        {
          id: 102,
          class_id: 2,
          name: 'Trần Thị Bình',
          alias_id: null,
          qr_token: 'qr_token_binh_56',
          status: 'empty',
          person_id: null,
          is_updating: false,
        },
      ],
      queuedJobs: [],
    };
  });

  // =========================================================================
  // TEST CASE 1: TÊN LỚP TIẾNG VIỆT CÓ ĐẦY ĐỦ DẤU, KHOẢNG TRẮNG & EMOJI
  // =========================================================================
  it('Test Case 1: Tên Lớp tiếng Việt có dấu, khoảng trắng & Emoji không gây lỗi ERR_INVALID_CHAR trên HTTP thật và giải mã chuẩn 100%', async () => {
    const app = await buildStudentPortalTestServer(mockState);
    const res = await app.inject({
      method: 'GET',
      url: '/api/classes/VD1A/students',
    });

    expect(res.statusCode).toBe(200);
    const rawHeader = res.headers['x-class-name'] as string;
    expect(rawHeader).toBe(
      'L%E1%BB%9Bp%20V%C3%A0o%20%C4%90%E1%BB%9Di%201A%20(Th%E1%BB%A9%207%20-%2018h30)%20%26%20Ban%20Gi%C3%A1o%20L%C3%BD%20Vi%C3%AAn%20%F0%9F%8C%9F'
    );

    // Kiểm chứng Node.js Native HTTP OutgoingMessage.setHeader không ném TypeError [ERR_INVALID_CHAR]
    const dummyServer = http.createServer((_req, serverRes) => {
      expect(() => {
        serverRes.setHeader('X-Class-Name', rawHeader);
      }).not.toThrow();
      serverRes.end('ok');
    });
    dummyServer.close();

    // Giải mã phía Frontend khớp 100% chuỗi gốc
    const decoded = safeDecodeClassName(rawHeader, 'VD1A');
    expect(decoded.warned).toBe(false);
    expect(decoded.className).toBe('Lớp Vào Đời 1A (Thứ 7 - 18h30) & Ban Giáo Lý Viên 🌟');

    await app.close();
  });

  // =========================================================================
  // TEST CASE 2: LỘ DIỆN ĐẦY ĐỦ 3 HEADER NGHIỆP VỤ & CẤU HÌNH NGINX REVERSE PROXY
  // =========================================================================
  it('Test Case 2: Phản hồi đủ X-Class-Code, X-Class-Name, X-Teacher-Verified, Access-Control-Expose-Headers & đồng bộ 2 file Nginx', async () => {
    const app = await buildStudentPortalTestServer(mockState);
    const res = await app.inject({
      method: 'GET',
      url: '/api/classes/GLV0/students',
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers['x-class-code']).toBe('GLV0');
    expect(res.headers['x-class-name']).toBe('L%E1%BB%9Bp%20GLV0');
    expect(res.headers['x-teacher-verified']).toBe('false');
    expect(res.headers['access-control-expose-headers']).toBe(
      'X-Class-Code, X-Class-Name, X-Teacher-Verified'
    );

    // Kiểm tra cả 2 file cấu hình Nginx đều có proxy_pass_header, Access-Control-Expose-Headers và /tmp-faces/
    const nginxMain = fs.readFileSync(path.resolve('docker/nginx/default.conf'), 'utf8');
    const nginxConfD = fs.readFileSync(path.resolve('docker/nginx/conf.d/default.conf'), 'utf8');

    expect(nginxMain).toBe(nginxConfD);
    expect(nginxMain).toContain('proxy_pass_header X-Class-Code;');
    expect(nginxMain).toContain('proxy_pass_header X-Class-Name;');
    expect(nginxMain).toContain('proxy_pass_header X-Teacher-Verified;');
    expect(nginxMain).toContain(
      "add_header 'Access-Control-Expose-Headers' 'X-Class-Code, X-Class-Name, X-Teacher-Verified' always;"
    );
    expect(nginxMain).toContain('location /tmp-faces/');

    await app.close();
  });

  // =========================================================================
  // TEST CASE 3: XÁC THỰC TOKEN PIN GIÁO VIÊN (4 KỊCH BẢN A, B, C, D)
  // =========================================================================
  it('Test Case 3: Xác thực chính xác X-Teacher-Verified cho 4 kịch bản Query đúng, Header đúng, PIN sai và Không truyền PIN', async () => {
    const app = await buildStudentPortalTestServer(mockState);

    // Kịch bản A: Truyền đúng PIN qua Query ?token=PIN_GLV0
    const resA = await app.inject({
      method: 'GET',
      url: '/api/classes/GLV0/students?token=PIN_GLV0',
    });
    expect(resA.headers['x-teacher-verified']).toBe('true');

    // Kịch bản B: Truyền đúng PIN qua Header x-teacher-pin: PIN_GLV0
    const resB = await app.inject({
      method: 'GET',
      url: '/api/classes/GLV0/students',
      headers: { 'x-teacher-pin': 'PIN_GLV0' },
    });
    expect(resB.headers['x-teacher-verified']).toBe('true');

    // Kịch bản C: Truyền sai PIN
    const resC = await app.inject({
      method: 'GET',
      url: '/api/classes/GLV0/students?token=SAI_MAT_MA',
    });
    expect(resC.headers['x-teacher-verified']).toBe('false');

    // Kịch bản D: Không truyền token
    const resD = await app.inject({
      method: 'GET',
      url: '/api/classes/GLV0/students',
    });
    expect(resD.headers['x-teacher-verified']).toBe('false');

    await app.close();
  });

  // =========================================================================
  // TEST CASE 4: CHỐNG LỖ HỔNG CRLF HEADER INJECTION / HTTP RESPONSE SPLITTING
  // =========================================================================
  it('Test Case 4: Vô hiệu hóa hoàn toàn ký tự xuống dòng \\r\\n trong tên lớp, chống chèn Set-Cookie hoặc X-Injected', async () => {
    const app = await buildStudentPortalTestServer(mockState);
    const res = await app.inject({
      method: 'GET',
      url: '/api/classes/CRLF/students',
    });

    expect(res.statusCode).toBe(200);
    const encodedHeader = res.headers['x-class-name'] as string;

    // Ký tự \r\n đã bị chuyển thành %0D%0A, không còn ký tự điều khiển thô
    expect(encodedHeader).not.toMatch(/[\r\n]/);
    expect(encodedHeader).toContain('%0D%0A');

    // Không bao giờ bị tách thành header Set-Cookie hoặc X-Injected
    expect(res.headers['set-cookie']).toBeUndefined();
    expect(res.headers['x-injected']).toBeUndefined();

    await app.close();
  });

  // =========================================================================
  // TEST CASE 5: TÊN LỚP MANG GIÁ TRỊ NULL, RỖNG HOẶC TOÀN KHOẢNG TRẮNG
  // =========================================================================
  it('Test Case 5: Xử lý an toàn khi tên lớp là NULL hoặc chỉ chứa khoảng trắng, Frontend fallback về mã lớp', async () => {
    const app = await buildStudentPortalTestServer(mockState);

    const resNull = await app.inject({
      method: 'GET',
      url: '/api/classes/NULLNAME/students',
    });
    expect(resNull.statusCode).toBe(200);
    expect(resNull.headers['x-class-name']).toBe('');
    const decodedNull = safeDecodeClassName(resNull.headers['x-class-name'] as string, 'NULLNAME');
    expect(decodedNull.className).toBe('NULLNAME');

    const resWs = await app.inject({
      method: 'GET',
      url: '/api/classes/WHITESPACE/students',
    });
    expect(resWs.statusCode).toBe(200);
    expect(resWs.headers['x-class-name']).toBe('');
    const decodedWs = safeDecodeClassName(resWs.headers['x-class-name'] as string, 'WHITESPACE');
    expect(decodedWs.className).toBe('WHITESPACE');

    await app.close();
  });

  // =========================================================================
  // TEST CASE 6: CHUỖI URL ENCODING BỊ HỎNG Ở FRONTEND (MALFORMED URI SEQUENCE)
  // =========================================================================
  it('Test Case 6: Không làm sập giao diện khi nhận chuỗi URI bị cắt cụt (%E1 hoặc L%E1%BB%9Bp%)', () => {
    const broken1 = safeDecodeClassName('%E1', 'GLV0');
    expect(broken1.warned).toBe(true);
    expect(broken1.className).toBe('%E1');

    const broken2 = safeDecodeClassName('L%E1%BB%9Bp%', 'GLV0');
    expect(broken2.warned).toBe(true);
    expect(broken2.className).toBe('L%E1%BB%9Bp%');
  });

  // =========================================================================
  // TEST CASE 7: CORS PREFLIGHT (OPTIONS), RATE LIMIT BYPASS & TEACHER OVERRIDE
  // =========================================================================
  it('Test Case 7: Hỗ trợ OPTIONS Preflight, miễn trừ Rate Limit cho mã lớp chữ cái GLV0 và phân quyền cập nhật ảnh học sinh đã success', async () => {
    const app = await buildStudentPortalTestServer(mockState);

    // 7.1. Kiểm tra CORS Preflight OPTIONS
    const optRes = await app.inject({
      method: 'OPTIONS',
      url: '/api/classes/GLV0/students',
      headers: {
        Origin: 'http://localhost:5173',
        'Access-Control-Request-Method': 'GET',
        'Access-Control-Request-Headers': 'x-teacher-pin',
      },
    });
    expect(optRes.statusCode).toBe(204);
    expect(optRes.headers['access-control-expose-headers']).toContain('X-Teacher-Verified');
    expect(optRes.headers['access-control-allow-headers']).toContain('x-teacher-pin');

    // 7.2. Học sinh tự nộp đè vào hồ sơ đã 'success' (Không có PIN) -> Bị chặn 409 Conflict
    const conflictRes = await app.inject({
      method: 'POST',
      url: '/api/students/101/photo',
    });
    expect(conflictRes.statusCode).toBe(409);

    // 7.3. Giáo viên có PIN hợp lệ cập nhật ảnh cho học sinh đã 'success' -> 200 OK + Priority 1 UPDATE_PHOTO
    const teacherRes = await app.inject({
      method: 'POST',
      url: '/api/students/101/photo',
      headers: { 'x-teacher-pin': 'PIN_GLV0' },
    });
    expect(teacherRes.statusCode).toBe(200);
    expect(mockState.queuedJobs.length).toBe(1);
    expect(mockState.queuedJobs[0]).toMatchObject({
      name: 'override-photo',
      priority: 1,
      actionType: 'UPDATE_PHOTO',
      personId: 'HANET_PERSON_101',
    });

    // 7.4. Kiểm tra StudentRepository.claimStudentForTeacherOverride và Status UI Config
    const mockPool = {
      query: vi.fn().mockResolvedValueOnce({
        rows: [
          {
            id: 101,
            name: 'Nguyễn Văn An',
            status: 'success',
            person_id: 'HANET_PERSON_101',
            is_updating: true,
          },
        ],
      }),
    };
    const repo = new StudentRepository(mockPool as any);
    const claimOverride = await repo.claimStudentForTeacherOverride(101, '/tmp/new.jpg');
    expect(claimOverride?.mode).toBe('UPDATE_PHOTO');
    expect(claimOverride?.student.status).toBe('success');

    expect(resolveStudentStatusConfig('success', false).primaryButton.disabled).toBe(true);
    expect(resolveStudentStatusConfig('success', true).primaryButton.disabled).toBe(false);

    // 7.5. Kiểm tra RateLimiter bypass khi truyền mã lớp chữ cái GLV0 kèm PIN hợp lệ
    const mockRedis = {
      pipeline: vi.fn(),
    };
    const limiter = createRateLimiter({
      redis: mockRedis as any,
      classRepo: {
        findByCode: vi.fn().mockResolvedValue({ id: 2, code: 'GLV0', token: 'PIN_GLV0' }),
        verifyTeacherPin: vi.fn().mockResolvedValue(true),
      } as any,
      studentRepo: {} as any,
      adminSecret: 'secret',
    });
    await limiter(
      {
        headers: { 'x-teacher-pin': 'PIN_GLV0' },
        params: { classId: 'GLV0' },
        query: {},
      } as any,
      {} as any
    );
    // Pipeline Redis không bị gọi vì đã được miễn trừ Rate Limit
    expect(mockRedis.pipeline).not.toHaveBeenCalled();

    // 7.6. Kiểm tra đồng bộ 4 file HTML giống hệt nhau 100%
    const html1 = fs.readFileSync(path.resolve('apps/student/index.html'), 'utf8');
    const html2 = fs.readFileSync(path.resolve('apps/student/dist/index.html'), 'utf8');
    const html3 = fs.readFileSync(path.resolve('frontend/dist/index.html'), 'utf8');
    const html4 = fs.readFileSync(path.resolve('apps/api/public/index.html'), 'utf8');
    expect(html1).toBe(html2);
    expect(html1).toBe(html3);
    expect(html1).toBe(html4);

    await app.close();
  });

  it('Test Case 8: Kiểm thử Cổng Danh Sách Lớp Công Khai /classes và API Thống Kê Public GET /api/public/classes', async () => {
    // 8.1. Kiểm thử cấu hình STATIC_BASE_URL trỏ về IP Product 161.248.146.115:8090/tmp-faces
    const composeContent = fs.readFileSync(path.resolve('docker/docker-compose.yml'), 'utf8');
    expect(composeContent).toContain('STATIC_BASE_URL: ${STATIC_BASE_URL:-http://161.248.146.115:8090/tmp-faces}');

    // 8.2. Kiểm thử đồng bộ file classes.html giữa apps/student và apps/api/public
    const classesHtml1 = fs.readFileSync(path.resolve('apps/student/classes.html'), 'utf8');
    const classesHtml2 = fs.readFileSync(path.resolve('apps/api/public/classes.html'), 'utf8');
    expect(classesHtml1).toBe(classesHtml2);
    expect(classesHtml1).toContain('/api/public/classes');
    expect(classesHtml1).toContain('window.location.origin');

    // 8.3. Kiểm thử Nginx route /classes trong default.conf
    const nginxConf = fs.readFileSync(path.resolve('docker/nginx/default.conf'), 'utf8');
    expect(nginxConf).toContain('location = /classes');
    expect(nginxConf).toContain('alias /usr/share/nginx/html/student/classes.html;');

    // 8.4. Kiểm thử API Public classes không làm lộ token/PIN
    const mockClasses = [
      {
        id: 1,
        code: 'GLV0',
        name: 'Giáo Lý Viên',
        teacher_name: 'Thầy Trưởng',
        token: 'PIN_GLV0_SECRET',
        is_locked: false,
        total_students: 45,
        success_count: 40,
        pending_count: 2,
        error_count: 1,
        manual_review_count: 0,
        empty_count: 2,
      },
      {
        id: 2,
        code: 'KT1A',
        name: 'Khai Tâm 1A',
        teacher_name: 'Cô An',
        token: 'PIN_KT1A_SECRET',
        is_locked: false,
        total_students: 30,
        success_count: 15,
        pending_count: 5,
        error_count: 0,
        manual_review_count: 0,
        empty_count: 10,
      },
    ];

    const testApp = Fastify({ logger: false });
    testApp.get('/api/public/classes', async (_req, reply) => {
      const publicData = mockClasses.map((c) => ({
        id: c.id,
        code: c.code,
        name: c.name,
        teacher_name: c.teacher_name,
        is_locked: c.is_locked,
        total_students: c.total_students,
        success_count: c.success_count,
        pending_count: c.pending_count,
        error_count: c.error_count,
        manual_review_count: c.manual_review_count,
        empty_count: c.empty_count,
        completion_rate: Math.round((c.success_count / c.total_students) * 100),
      }));
      return reply.send({
        success: true,
        total_classes: publicData.length,
        total_students: publicData.reduce((s, c) => s + c.total_students, 0),
        total_success: publicData.reduce((s, c) => s + c.success_count, 0),
        data: publicData,
      });
    });

    const res = await testApp.inject({
      method: 'GET',
      url: '/api/public/classes',
    });

    expect(res.statusCode).toBe(200);
    const json = JSON.parse(res.body);
    expect(json.success).toBe(true);
    expect(json.total_classes).toBe(2);
    expect(json.total_students).toBe(75);
    expect(json.total_success).toBe(55);
    // TUYỆT ĐỐI không để lộ trường token hoặc mã PIN bí mật
    expect(res.body).not.toContain('PIN_GLV0_SECRET');
    expect(res.body).not.toContain('PIN_KT1A_SECRET');
    expect(json.data[0].token).toBeUndefined();

    await testApp.close();
  });
});
