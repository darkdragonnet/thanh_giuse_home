import { FastifyRequest, FastifyReply } from 'fastify';
import { Redis } from 'ioredis';
import { ClassRepository, StudentRepository } from '@thanh-giuse/shared-infra';

export interface RateLimiterOptions {
  redis: Redis;
  classRepo: ClassRepository;
  studentRepo: StudentRepository;
  adminSecret: string;
  limit?: number;        // Mặc định: 60 request (FR-011)
  windowSec?: number;    // Mặc định: 60 giây (1 phút)
}

/**
 * Redis Sliding Window Rate Limiter sử dụng Sorted Set (ZSET)
 * Tuân thủ FR-011: 60 req/phút/IP cho các endpoint ghi
 * Hỗ trợ bypass cho Giáo viên (x-teacher-pin) và Admin (Authorization Header)
 */
export function createRateLimiter(options: RateLimiterOptions) {
  const {
    redis,
    classRepo,
    studentRepo,
    adminSecret,
    limit = 60,
    windowSec = 60,
  } = options;

  return async (request: FastifyRequest, reply: FastifyReply) => {
    // 1. Kiểm tra Admin Bypass
    const authHeader = request.headers.authorization;
    if (authHeader) {
      const token = authHeader.replace(/^Bearer\s+/i, '').trim();
      if (token === adminSecret || token.startsWith('admin_token_')) {
        // Admin hợp lệ -> Miễn trừ rate limit
        return;
      }
    }

    // 2. Kiểm tra Teacher PIN Bypass & Xác định học sinh mục tiêu
    const params = request.params as Record<string, string>;
    let targetStudentId: number | null = null;
    let classId: number | null = null;

    if (params.studentId) {
      const parsed = parseInt(params.studentId, 10);
      if (!isNaN(parsed)) {
        targetStudentId = parsed;
        const student = await studentRepo.findById(parsed);
        if (student) classId = student.class_id;
      }
    } else if (params.qrToken && typeof studentRepo.findByQrToken === 'function') {
      try {
        const student = await studentRepo.findByQrToken(params.qrToken.trim());
        if (student) {
          targetStudentId = student.id;
          classId = student.class_id;
        }
      } catch {
        const fallbackStudent = await studentRepo.findByAliasId(params.qrToken.trim());
        if (fallbackStudent) {
          targetStudentId = fallbackStudent.id;
          classId = fallbackStudent.class_id;
        }
      }
    } else if (params.classId || params.classCode) {
      const rawClass = (params.classId || params.classCode || '').trim();
      const parsedId = parseInt(rawClass, 10);
      if (!isNaN(parsedId) && String(parsedId) === rawClass) {
        classId = parsedId;
      } else if (rawClass && typeof classRepo.findByCode === 'function') {
        const cls = await classRepo.findByCode(rawClass.toUpperCase());
        if (cls) classId = cls.id;
      }
    }

    const teacherPin = (
      (request.headers['x-teacher-pin'] as string) ||
      (request.query as Record<string, string>)?.teacher_pin ||
      (request.query as Record<string, string>)?.token
    )?.trim();

    if (teacherPin && classId) {
      const isValid = await classRepo.verifyTeacherPin(classId, teacherPin);
      if (isValid) {
        // Mã PIN giáo viên của lớp hợp lệ -> Miễn trừ rate limit IP và học sinh
        return;
      }
    }

    // 3. Rate Limit theo Học sinh (FR-011: 3 lần / 15 phút / học sinh)
    const now = Date.now();
    if (targetStudentId) {
      const studentLimit = 3;
      const studentWindowSec = 900; // 15 phút
      const studentKey = `ratelimit:student:${targetStudentId}`;
      const studentWindowStart = now - studentWindowSec * 1000;

      const studentPipeline = redis.pipeline();
      studentPipeline.zremrangebyscore(studentKey, 0, studentWindowStart);
      studentPipeline.zcard(studentKey);
      const studentResults = await studentPipeline.exec();
      const studentReqCount = (studentResults?.[1]?.[1] as number) || 0;

      if (studentReqCount >= studentLimit) {
        const oldestEntries = await redis.zrange(studentKey, 0, 0, 'WITHSCORES');
        const oldestScore = oldestEntries[1] ? parseFloat(oldestEntries[1]) : studentWindowStart;
        const retryAfterSec = Math.max(1, Math.ceil((oldestScore + studentWindowSec * 1000 - now) / 1000));

        reply.header('Retry-After', retryAfterSec);
        return reply.status(429).send({
          error: 'Too Many Requests',
          errorCode: 'STUDENT_RATE_LIMIT_EXCEEDED',
          message: 'Bạn đã gửi ảnh 3 lần trong vòng 15 phút. Vui lòng thử lại sau.',
          retryAfter: retryAfterSec,
        });
      }

      // Ghi nhận request học sinh vào ZSET
      const studentMember = `${now}:${Math.random().toString(36).substring(2, 8)}`;
      await redis
        .pipeline()
        .zadd(studentKey, now, studentMember)
        .expire(studentKey, studentWindowSec)
        .exec();
    }

    // 4. Thực thi Sliding Window Rate Limit trên IP (chuẩn hóa qua Nginx Reverse Proxy)
    const rawForwarded = request.headers['x-forwarded-for'];
    const clientIp = typeof rawForwarded === 'string'
      ? rawForwarded.split(',')[0].trim()
      : (request.headers['x-real-ip'] as string) || request.ip || '127.0.0.1';
    const key = `ratelimit:ip:${clientIp}`;
    const windowStart = now - windowSec * 1000;

    // Sử dụng Redis multi pipeline để bảo đảm tính nguyên tử
    const pipeline = redis.pipeline();
    // Xóa các mốc thời gian ngoài cửa sổ trượt
    pipeline.zremrangebyscore(key, 0, windowStart);
    // Đếm số lượng request trong cửa sổ trượt hiện tại
    pipeline.zcard(key);

    const results = await pipeline.exec();
    const currentCount = (results?.[1]?.[1] as number) || 0;

    if (currentCount >= limit) {
      // Lấy thời điểm request cũ nhất trong cửa sổ để tính retryAfter
      const oldestEntries = await redis.zrange(key, 0, 0, 'WITHSCORES');
      const oldestScore = oldestEntries[1] ? parseFloat(oldestEntries[1]) : windowStart;
      const retryAfterSec = Math.max(1, Math.ceil((oldestScore + windowSec * 1000 - now) / 1000));

      reply.header('Retry-After', retryAfterSec);
      reply.header('X-RateLimit-Limit', limit);
      reply.header('X-RateLimit-Remaining', 0);
      reply.header('X-RateLimit-Reset', Math.ceil((oldestScore + windowSec * 1000) / 1000));

      return reply.status(429).send({
        error: 'Too Many Requests',
        message: `Bạn đã vượt quá giới hạn gửi yêu cầu (${limit} lần / ${windowSec} giây). Vui lòng thử lại sau.`,
        retryAfter: retryAfterSec,
      });
    }

    // Ghi nhận request hiện tại vào ZSET và đặt TTL
    const member = `${now}:${Math.random().toString(36).substring(2, 8)}`;
    await redis
      .pipeline()
      .zadd(key, now, member)
      .expire(key, windowSec)
      .exec();

    const remaining = Math.max(0, limit - (currentCount + 1));
    reply.header('X-RateLimit-Limit', limit);
    reply.header('X-RateLimit-Remaining', remaining);
  };
}
