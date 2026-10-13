import { Job, UnrecoverableError } from 'bullmq';
import { ProcessorContext, HanetServiceUnavailableError } from '../processor.js';

export interface UpdateAliasJobData {
  batchId?: string;
  studentId: number;
  classId?: number;
  aliasId: string;
  newAlias: string;
  personId: string;
  studentName: string;
  departmentId: string | number;
}

async function recordBatchProgress(
  redisClient: any,
  batchId: string | undefined,
  isSuccess: boolean
) {
  if (!batchId || !redisClient) return;
  const batchKey = `batch:${batchId}`;
  await redisClient.hincrby(batchKey, 'processed', 1);
  if (isSuccess) {
    await redisClient.hincrby(batchKey, 'success', 1);
  } else {
    await redisClient.hincrby(batchKey, 'failed', 1);
  }
  const [total, processed] = await Promise.all([
    redisClient.hget(batchKey, 'total'),
    redisClient.hget(batchKey, 'processed'),
  ]);
  if (total && processed && Number(processed) >= Number(total)) {
    await redisClient.hset(batchKey, 'is_done', '1');
    await redisClient.del('cache:hanet:real_cloud_faces');
    console.log(`[UPDATE_ALIAS] Batch ${batchId} hoàn tất. Đã chủ động xóa cache:hanet:real_cloud_faces.`);
  }
}

/**
 * Xử lý tác vụ đổi AliasID và bảo toàn phòng ban (Quy trình 2 bước)
 * Ràng buộc: Concurrency = 1, timeout 120s, bảo vệ VPS 3GB RAM
 */
export async function handleUpdateAlias(
  job: Job<UpdateAliasJobData>,
  context: ProcessorContext
): Promise<{ success: boolean; personId?: string; aliasId?: string; reason?: string }> {
  const { studentRepo, logRepo, settingsRepo, redisClient, hanetClient, pauseWorker } = context;
  const {
    batchId,
    studentId,
    aliasId,
    newAlias,
    personId,
    studentName,
    departmentId,
  } = job.data;

  console.log(`[UPDATE_ALIAS START] Job: ${job.id} | Student: ${studentName} | personID: ${personId} | newAlias: ${newAlias}`);

  // ═══════════════════════════════════════════════════════════════════════════
  // CHỐT CHẶN ĐỘ DÀI TRẦN (CLOUD CEILING GUARD - HIẾN PHÁP ĐIỀU 4 KHOẢN 1)
  // Bắt buộc chuỗi đúng 9 ký tự: ^[A-Za-z]{2}[A-Za-z0-9]{2}_[A-Za-z0-9]{4}$
  // ═══════════════════════════════════════════════════════════════════════════
  const FIXED_ALIAS_REGEX = /^[A-Za-z]{2}[A-Za-z0-9]{2}_[A-Za-z0-9]{4}$/;
  if (!FIXED_ALIAS_REGEX.test(newAlias)) {
    console.error(`[UPDATE_ALIAS] BÁO ĐỎ: newAlias "${newAlias}" không khớp chuẩn 9 ký tự.`);
    await studentRepo.markFailure(
      studentId,
      'manual_review',
      'LEGACY_FORMAT_QUARANTINED',
      `Mã alias "${newAlias}" không khớp chuẩn 9 ký tự.`
    );
    await recordBatchProgress(redisClient, batchId, false);
    throw new UnrecoverableError(`AliasID "${newAlias}" không khớp chuẩn 9 ký tự: vi phạm Hiến pháp.`);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // BƯỚC 1: CẬP NHẬT MÃ ALIAS MỚI TRÊN HANET CLOUD
  // ═══════════════════════════════════════════════════════════════════════════
  const aliasRes = await hanetClient.updateAliasID({
    personID: personId,
    aliasID: newAlias,
  });

  const { evaluation, rawResponse } = aliasRes;
  const returnCode = rawResponse?.returnCode ?? (aliasRes.error ? -503 : -1);

  // Xử lý các mã lỗi hệ thống từ Bước 1
  if (!aliasRes.success) {
    console.warn(`[UPDATE_ALIAS] Bước 1 thất bại với returnCode: ${returnCode}`);

    // 1. Mã -103: Hết hạn Token (Hiến pháp Điều 4 Khoản 4)
    if (returnCode === -103 || evaluation.action === 'REFRESH_TOKEN') {
      if (pauseWorker) await pauseWorker();
      const maintenanceMsg = 'Hệ thống đang tạm khóa để bảo trì kết nối máy chủ';
      if (redisClient) {
        await redisClient.set('setting:kill_switch', 'true');
        await redisClient.set('setting:maintenance_message', maintenanceMsg);
      }
      if (settingsRepo) {
        await settingsRepo.setRegistrationEnabled(false);
        await settingsRepo.setSetting('maintenance_message', maintenanceMsg);
      }
      await logRepo.recordLog({
        alias_id: newAlias,
        action: 'SYSTEM_TOKEN_EXPIRED',
        result_code: 'CRITICAL_TOKEN_EXPIRED',
        result_message: `[SYSTEM_TOKEN_EXPIRED] Lỗi -103 khi đổi aliasID. Đã kích hoạt Kill Switch và tạm dừng hàng đợi. Admin cập nhật token mới trong .env trên VPS.`,
      });
      // Giữ nguyên trạng thái bản ghi học sinh, không tăng retry count, không markFailure
      return { success: false, reason: 'SYSTEM_TOKEN_EXPIRED' };
    }

    // 2. Mã -9008: Hết Quota Face ID
    if (returnCode === -9008 || evaluation.action === 'QUOTA_EXCEEDED') {
      if (pauseWorker) await pauseWorker();
      if (redisClient) {
        await redisClient.set('system:registration_disabled', '1');
        await redisClient.set('setting:kill_switch', 'true');
      }
      if (settingsRepo) await settingsRepo.setRegistrationEnabled(false);
      await studentRepo.markFailure(studentId, 'manual_review', '-9008', 'Hết quota Face ID trên HANET Cloud');
      await recordBatchProgress(redisClient, batchId, false);
      throw new UnrecoverableError('HANET Cloud đã hết quota Face ID (-9008). Tạm ngắt hàng đợi.');
    }

    // 3. Mã -5011: Không tìm thấy người dùng (PERSON_NOT_FOUND)
    if (returnCode === -5011) {
      console.warn(`[UPDATE_ALIAS] -5011 Không tìm thấy personID "${personId}" trên HANET. Chuyển sang manual_review, bảo tồn person_id.`);
      await studentRepo.markFailure(
        studentId,
        'manual_review',
        '-5011',
        `Không tìm thấy personID "${personId}" trên HANET Cloud. Cần Admin đối soát thủ công.`
      );
      await logRepo.recordLog({
        alias_id: newAlias,
        action: 'SYNC_ALIAS',
        result_code: 'PERSON_NOT_FOUND',
        result_message: `Lỗi -5011: personID ${personId} không tồn tại trên Cloud. Đã bảo tồn person_id và chuyển manual_review.`,
      });
      await recordBatchProgress(redisClient, batchId, false);
      return { success: false, reason: 'PERSON_NOT_FOUND' };
    }

    // 4. Mã -9005: Đã tồn tại người dùng/khuôn mặt
    if (returnCode === -9005) {
      const existingPerson = rawResponse?.data;
      const cloudAlias = existingPerson?.aliasID || existingPerson?.alias_id;
      if (cloudAlias && cloudAlias.trim().toUpperCase() === newAlias.trim().toUpperCase()) {
        // Idempotent Pass
        console.log(`[UPDATE_ALIAS] Idempotent Pass: Người dùng đã mang alias ${newAlias}.`);
      } else {
        // Xung đột mã alias
        console.warn(`[UPDATE_ALIAS] Xung đột mã: newAlias "${newAlias}" đã tồn tại trên nhân sự khác.`);
        await studentRepo.recordSyncConflict({
          studentId,
          aliasId: newAlias,
          cloudPersonId: existingPerson?.personID || null,
          cloudAliasId: cloudAlias || null,
          cloudName: existingPerson?.name || null,
          conflictType: 'ALIAS_ALREADY_EXISTS_ON_CLOUD',
        });
        await studentRepo.markFailure(
          studentId,
          'manual_review',
          '-9005',
          `Alias "${newAlias}" đã tồn tại trên Cloud với mã khác.`
        );
        await recordBatchProgress(redisClient, batchId, false);
        return { success: false, reason: 'CONFLICT_EXISTING' };
      }
    }

    // 5. Lỗi hạ tầng -503 / Network / Timeout -> Ném lỗi để BullMQ kích hoạt backoff 300s
    if (returnCode === -503 || evaluation.action === 'RETRY_LATER') {
      throw new HanetServiceUnavailableError(`Hạ tầng HANET bận (${returnCode}). BullMQ backoff 300s.`);
    }

    // Lỗi khác -> chuyển manual_review
    await studentRepo.markFailure(studentId, 'manual_review', String(returnCode), evaluation.userFacingMessage);
    await recordBatchProgress(redisClient, batchId, false);
    return { success: false, reason: `ERROR_${returnCode}` };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // BƯỚC 2: DELAY 120ms KIỂM SOÁT RATE LIMIT (TRÁNH NGHẼN HANET 30 REQ/PHÚT)
  // ═══════════════════════════════════════════════════════════════════════════
  await new Promise((resolve) => setTimeout(resolve, 120));

  // ═══════════════════════════════════════════════════════════════════════════
  // BƯỚC 3: GÁN LẠI NHÂN SỰ VÀO ĐÚNG PHÒNG BAN (KHÓA LẠI DEPARTMENT)
  // ═══════════════════════════════════════════════════════════════════════════
  if (departmentId && String(departmentId) !== '0') {
    const deptRes = await hanetClient.addPersonToDepartment({
      personID: personId,
      departmentID: departmentId,
    });
    if (!deptRes.success) {
      console.warn(`[UPDATE_ALIAS] Cảnh báo: Gán lại phòng ban ${departmentId} thất bại:`, deptRes.evaluation.returnMessage);
    } else {
      console.log(`[UPDATE_ALIAS] Đã khóa thành công nhân sự ${personId} vào phòng ban ${departmentId}.`);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // BƯỚC 4: CẬP NHẬT DATABASE VÀ GHI AUDIT LOG (BẢO TOÀN DỮ LIỆU & CHỐNG TREO 99% KHI TRÙNG KHÓA 23505)
  // ═══════════════════════════════════════════════════════════════════════════
  try {
    await studentRepo.updateAliasSuccess(studentId, newAlias);
  } catch (dbErr: any) {
    if (dbErr?.code === '23505') {
      console.error(`[UPDATE_ALIAS] Lỗi 23505 Unique Violation khi cập nhật newAlias "${newAlias}" cho học sinh ${studentId}.`);
      await studentRepo.recordSyncConflict({
        studentId,
        aliasId: newAlias,
        cloudPersonId: personId,
        cloudAliasId: newAlias,
        cloudName: studentName,
        conflictType: 'DB_UNIQUE_ALIAS_VIOLATION_23505',
      });
      await studentRepo.markFailure(
        studentId,
        'manual_review',
        '23505',
        `Xung đột khóa UNIQUE (23505): Mã alias "${newAlias}" đã được gán cho một học sinh khác trong DB nội bộ.`
      );
      await logRepo.recordLog({
        student_id: studentId,
        alias_id: newAlias,
        class_id: typeof job.data.classId === 'number' ? job.data.classId : null,
        action: 'SYNC_ALIAS_CONFLICT',
        result_code: '23505',
        result_message: `Lỗi 23505 Unique Violation khi đổi alias từ "${aliasId}" sang "${newAlias}" (personID: ${personId}). Đã chuyển manual_review và ghi nhận tiến độ batch.`,
      });
      await recordBatchProgress(redisClient, batchId, false);
      return { success: false, personId, aliasId: newAlias, reason: 'DB_UNIQUE_VIOLATION_23505' };
    }
    throw dbErr;
  }

  await logRepo.recordLog({
    student_id: studentId,
    alias_id: newAlias,
    class_id: typeof job.data.classId === 'number' ? job.data.classId : null,
    action: 'SYNC_ALIAS',
    result_code: 'SUCCESS',
    result_message: `Đổi aliasID thành công: [OLD_ALIAS: ${aliasId}] -> [NEW_ALIAS: ${newAlias}] | student_id: ${studentId} | personID: ${personId} | department: ${departmentId}`,
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // BƯỚC 5: CẬP NHẬT TIẾN ĐỘ REDIS BATCH HASH & TỰ ĐỘNG XÓA CACHE KHI XONG
  // ═══════════════════════════════════════════════════════════════════════════
  await recordBatchProgress(redisClient, batchId, true);

  // ═══════════════════════════════════════════════════════════════════════════
  // BƯỚC 6: COOLDOWN NGHỈ GIỮA CÁC JOB LIÊN TIẾP (BẢO VỆ RATE LIMIT 30 REQ/PHÚT CỦA HANET)
  // Với 2 requests/job, nghỉ 3.000ms đảm bảo tần suất toàn hệ thống luôn <= 20-25 req/phút
  // ═══════════════════════════════════════════════════════════════════════════
  const cooldownMs = process.env.NODE_ENV === 'test' ? 10 : 3000;
  await new Promise((resolve) => setTimeout(resolve, cooldownMs));

  console.log(`[UPDATE_ALIAS SUCCESS] Hoàn tất đồng bộ học sinh ${studentName} (${newAlias})!`);
  return { success: true, personId, aliasId: newAlias };
}

