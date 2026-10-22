import { FastifyPluginAsync } from 'fastify';
import type { StudentRepository, SettingsRepository } from '@thanh-giuse/shared-infra';
import type { Queue, Job } from 'bullmq';
import type pg from 'pg';

export interface StatusRouteDependencies {
  studentRepo: StudentRepository;
  settingsRepo: SettingsRepository;
  registrationQueue: Queue;
  pg: pg.Pool;
}

export const statusRoutes: FastifyPluginAsync = async (fastify) => {
  const studentRepo = fastify.studentRepo as StudentRepository;
  const settingsRepo = fastify.settingsRepo as SettingsRepository;
  const registrationQueue = fastify.registrationQueue as Queue;
  const pool = fastify.pg as pg.Pool;

  /**
   * T024: Tra cứu trạng thái tiến trình & vị trí hàng đợi (Short Polling 3s)
   * GET /api/students/:id/status
   */
  fastify.get<{ Params: { id: string } }>('/api/students/:id/status', async (request, reply) => {
    const rawId = request.params.id;
    const studentId = parseInt(rawId, 10);

    if (isNaN(studentId) || studentId <= 0) {
      return reply.status(404).send({
        error: 'Not Found',
        message: 'Mã học sinh không hợp lệ.',
      });
    }

    const student = await studentRepo.findById(studentId);
    if (!student) {
      return reply.status(404).send({
        error: 'Not Found',
        message: 'Không tìm thấy học sinh.',
      });
    }

    // Đọc cấu hình nhịp xử lý hanet_sync_rate_limit từ settings (mặc định 1 em/phút)
    let syncRateLimit = 1;
    try {
      const syncRateRaw = await settingsRepo.getSetting('hanet_sync_rate_limit');
      if (syncRateRaw) {
        const parsedRate = parseInt(syncRateRaw, 10);
        if (!isNaN(parsedRate) && parsedRate > 0) {
          syncRateLimit = parsedRate;
        }
      }
    } catch {
      syncRateLimit = 1;
    }

    // Nếu học sinh không ở trạng thái pending -> trả về DTO chuẩn không kèm thông tin hàng đợi
    if (student.status !== 'pending') {
      let defaultMessage = '';
      switch (student.status) {
        case 'success':
        case 'synced':
          defaultMessage = 'Đã hoàn tất đăng ký';
          break;
        case 'empty':
          defaultMessage = 'Chưa nộp ảnh';
          break;
        case 'error':
          defaultMessage = student.last_error_message || 'Có lỗi trong quá trình xử lý';
          break;
        case 'manual_review':
          defaultMessage = student.last_error_message || 'Hồ sơ đang chờ Quản trị viên duyệt';
          break;
        case 'conflict_pending_review':
          defaultMessage = student.last_error_message || 'Hồ sơ đang chờ duyệt xung đột';
          break;
        case 'failed_quota_exceeded':
          defaultMessage = student.last_error_message || 'Tạm khóa do cạn hạn mức khuôn mặt';
          break;
        default:
          defaultMessage = student.status;
      }

      return reply.status(200).send({
        id: student.id,
        status: student.status,
        queue_position: null,
        estimated_wait_minutes: null,
        message: defaultMessage,
        last_error_message: student.last_error_message || null,
      });
    }

    // ═════════════════════════════════════════════════════════════════════════
    // TÍNH TOÁN VỊ TRÍ HÀNG ĐỢI KHI HỌC SINH ĐANG PENDING
    // ═════════════════════════════════════════════════════════════════════════
    let queuePosition: number | null = null;

    try {
      // 1. Kiểm tra các job đang chạy (active)
      const activeJobs = await registrationQueue.getActive();
      const isTargetJobActive = activeJobs.some(
        (j: Job) =>
          j.data?.studentId === student.id ||
          (student.alias_id && j.id?.includes(student.alias_id)) ||
          j.id === `student_${student.id}` ||
          j.id === `teacher_override_${student.id}`
      );

      if (isTargetJobActive) {
        // Đang được worker xử lý trực tiếp
        queuePosition = 1;
      } else {
        // 2. Kiểm tra các job đang chờ (BullMQ phân loại job có priority vào 'prioritized', 'waiting', 'paused')
        const waitingJobs = await registrationQueue.getJobs(['waiting', 'prioritized', 'paused']);
        const targetWaitingJob = waitingJobs.find(
          (j: Job) =>
            j.data?.studentId === student.id ||
            (student.alias_id && j.id?.includes(student.alias_id)) ||
            (student.qr_token && j.id?.includes(student.qr_token)) ||
            j.id === `student_${student.id}` ||
            j.id === `teacher_override_${student.id}`
        );

        if (targetWaitingJob) {
          const hasActiveRunning = activeJobs.length > 0 ? 1 : 0;
          const targetPriority = targetWaitingJob.opts?.priority ?? 5;
          const targetTimestamp = targetWaitingJob.timestamp;

          let aheadCount = 0;
          for (const j of waitingJobs) {
            if (j.id === targetWaitingJob.id) continue;

            const jPriority = j.opts?.priority ?? (j.id?.startsWith('teacher_override_') ? 1 : 5);

            if (targetPriority === 1) {
              // Nếu job này là giáo viên (priority 1), chỉ tính các job giáo viên (priority 1) enqueue trước
              if (jPriority === 1 && j.timestamp < targetTimestamp) {
                aheadCount++;
              }
            } else {
              // Job học sinh bình thường (priority 5):
              // a) Toàn bộ job giáo viên (priority 1) được chen hàng trước
              if (jPriority === 1 || j.id?.startsWith('teacher_override_')) {
                aheadCount++;
              } else if (j.timestamp < targetTimestamp) {
                // b) Các job học sinh (priority 5) được enqueue trước job này
                aheadCount++;
              }
            }
          }

          queuePosition = hasActiveRunning + aheadCount + 1;
        }
      }
    } catch (bullErr) {
      fastify.log.warn(bullErr, '[StatusRoute] Lỗi khi truy vấn BullMQ, chuyển sang Fallback CSDL');
    }

    // 3. Fallback CSDL nếu không tìm thấy job trong BullMQ (hoặc lỗi Redis)
    // Công thức fallback: COUNT(học sinh pending có updated_at sớm hơn) + 1
    if (queuePosition === null) {
      const fallbackQuery = `
        SELECT COUNT(*)::int AS count
        FROM students
        WHERE status = 'pending'
          AND (updated_at < $1 OR (updated_at = $1 AND id < $2))
      `;
      const fallbackRes = await pool.query(fallbackQuery, [student.updated_at, student.id]);
      const earlierPendingCount = fallbackRes.rows[0]?.count ?? 0;
      queuePosition = earlierPendingCount + 1;
    }

    const resolvedPosition = queuePosition ?? 1;
    const estimatedWaitMinutes = Math.ceil(resolvedPosition / syncRateLimit);
    const message = `Đang xếp hàng vị trí thứ ${resolvedPosition} (nhịp đồng bộ ${syncRateLimit} em/phút)`;

    return reply.status(200).send({
      id: student.id,
      status: 'pending',
      queue_position: resolvedPosition,
      estimated_wait_minutes: estimatedWaitMinutes,
      message,
      last_error_message: student.last_error_message || null,
    });
  });
};
