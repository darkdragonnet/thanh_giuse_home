import { FastifyRequest, FastifyReply } from 'fastify';
import { SettingsRepository, ClassRepository, StudentRepository } from '@thanh-giuse/shared-infra';

export interface GuardOptions {
  settingsRepo: SettingsRepository;
  classRepo: ClassRepository;
  studentRepo: StudentRepository;
}

/**
 * Global Kill-Switch Guard: Kiểm tra bảng settings (registration_enabled)
 */
export function createKillSwitchGuard(settingsRepo: SettingsRepository) {
  return async (_request: FastifyRequest, reply: FastifyReply) => {
    const isEnabled = await settingsRepo.isRegistrationEnabled();
    if (!isEnabled) {
      const customMsg = await settingsRepo.getSetting('maintenance_message');
      return reply.status(403).send({
        error: 'Registration Closed',
        message: customMsg || 'Hệ thống đang tạm khóa để bảo trì kết nối máy chủ',
      });
    }
  };
}

/**
 * Class Lock Guard: Kiểm tra cờ is_locked của lớp (trả về HTTP 423)
 */
export function createClassLockGuard(
  classRepo: ClassRepository,
  studentRepo: StudentRepository
) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const params = request.params as Record<string, string>;
    let classId: number | null = null;
    let classCode: string | null = null;

    if (params.classId) {
      const parsed = parseInt(params.classId, 10);
      if (!isNaN(parsed) && String(parsed) === params.classId.trim()) {
        classId = parsed;
      } else {
        classCode = params.classId.trim().toUpperCase();
      }
    } else if (params.classCode) {
      classCode = params.classCode.trim().toUpperCase();
    } else if (params.studentId) {
      const studentId = parseInt(params.studentId, 10);
      if (!isNaN(studentId)) {
        const student = await studentRepo.findById(studentId);
        if (student) {
          classId = student.class_id;
        }
      }
    } else if (params.qrToken && typeof studentRepo.findByQrToken === 'function') {
      try {
        const student = await studentRepo.findByQrToken(params.qrToken);
        if (student) {
          classId = student.class_id;
        }
      } catch {
        const fallbackStudent = await studentRepo.findByAliasId(params.qrToken);
        if (fallbackStudent) {
          classId = fallbackStudent.class_id;
        }
      }
    }

    const classRecord = classId
      ? await classRepo.findById(classId)
      : classCode && typeof classRepo.findByCode === 'function'
      ? await classRepo.findByCode(classCode)
      : null;

    if (classRecord && classRecord.is_locked) {
      return reply.status(423).send({
        error: 'Class Locked',
        message: `Lớp học "${classRecord.name}" (${classRecord.code}) đã bị khóa đăng ký.`,
      });
    }
  };
}

