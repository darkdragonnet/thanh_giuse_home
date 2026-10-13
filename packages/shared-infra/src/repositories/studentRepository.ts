import { Pool } from 'pg';
import crypto from 'node:crypto';
import {
  StudentStatus,
  generateFinalAliasId,
} from '@thanh-giuse/shared-types';

export { StudentStatus };

/**
 * Sinh chuỗi qr_token cố định 16 ký tự URL-safe từ CSPRNG (2^96 tổ hợp)
 */
export function generateStudentQrToken(): string {
  return crypto.randomBytes(12).toString('base64url');
}

/**
 * Thuật toán sinh alias_id chuẩn hóa cố định đúng 9 ký tự (Hiến pháp Điều 3 Khoản 2):
 * Tiền tố (4 ký tự) + Dấu gạch dưới (_) + Hậu tố (4 ký tự) = 9 ký tự
 * Biểu thức chính quy: ^[A-Za-z]{2}[A-Za-z0-9]{2}_[A-Za-z0-9]{4}$
 * Padded Prefix cho mã ngắn: GLV -> GLV0, LM -> LM01
 * Bảo toàn 100% hậu tố 4 ký tự (Điều 3 Khoản 3) khi học sinh chuyển lớp/phòng ban.
 */
export function generateAliasId(
  classCode: string,
  usedSet?: Set<string>,
  existingSuffix?: string
): string {
  const cleanCode = classCode.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
  let paddedPrefix = cleanCode;
  if (paddedPrefix.length === 2) {
    paddedPrefix = `${paddedPrefix}01`;
  } else if (paddedPrefix.length === 3) {
    paddedPrefix = `${paddedPrefix}0`;
  } else if (paddedPrefix.length > 4) {
    paddedPrefix = paddedPrefix.substring(0, 4);
  } else if (paddedPrefix.length < 2) {
    paddedPrefix = `${paddedPrefix.padEnd(2, 'X')}01`;
  }

  // Bảo toàn hậu tố học sinh nếu có sẵn (Student Suffix Invariant)
  if (existingSuffix && /^[A-Za-z0-9]{4}$/.test(existingSuffix)) {
    return `${paddedPrefix}_${existingSuffix.toUpperCase()}`;
  }

  let alias = '';
  do {
    const randomSuffix = crypto.randomBytes(2).toString('hex').toUpperCase(); // Đúng 4 ký tự hex
    alias = `${paddedPrefix}_${randomSuffix}`;
  } while (usedSet && usedSet.has(alias));

  if (usedSet) usedSet.add(alias);
  return alias;
}

export interface StudentRecord {
  id: number;
  class_id: number;
  name: string;
  qr_token: string;
  alias_id: string | null;
  status: StudentStatus;
  person_id: string | null;
  face_url: string | null;
  local_image_path: string | null;
  cloud_alias_synced?: boolean;
  is_updating?: boolean;
  last_error_code: string | null;
  last_error_message: string | null;
  retry_count: number;
  created_at: Date;
  updated_at: Date;
}

export interface StudentFilterParams {
  classId?: number | undefined;
  status?: StudentStatus | undefined;
  search?: string | undefined;
  page: number;
  limit: number;
}

export class StudentRepository {
  constructor(private readonly pool: Pool) {}

  public async getPaginatedStudents(filter: StudentFilterParams) {
    const { classId, status, search, page, limit } = filter;
    const offset = (page - 1) * limit;
    const conditions: string[] = ['1=1'];
    const values: any[] = [];

    if (classId) {
      values.push(classId);
      conditions.push(`s.class_id = $${values.length}`);
    }

    if (status) {
      values.push(status);
      conditions.push(`s.status = $${values.length}`);
    }

    if (search) {
      values.push(`%${search}%`);
      conditions.push(`(s.name ILIKE $${values.length} OR COALESCE(s.alias_id, '') ILIKE $${values.length} OR COALESCE(s.qr_token, '') ILIKE $${values.length})`);
    }

    const whereClause = conditions.join(' AND ');

    const countQuery = `SELECT COUNT(*)::int AS total FROM students s WHERE ${whereClause}`;
    const totalRes = await this.pool.query(countQuery, values);
    const total = totalRes.rows[0]?.total ?? 0;

    const dataValues = [...values, limit, offset];
    const dataQuery = `
      SELECT 
        s.*,
        c.code AS class_code,
        c.name AS class_name
      FROM students s
      LEFT JOIN classes c ON c.id = s.class_id
      WHERE ${whereClause}
      ORDER BY s.id ASC
      LIMIT $${dataValues.length - 1} OFFSET $${dataValues.length}
    `;
    const dataRes = await this.pool.query(dataQuery, dataValues);

    return {
      items: dataRes.rows,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit) || 1,
    };
  }

  public async resetStudentStatus(studentId: number): Promise<boolean> {
    const res = await this.pool.query(
      `UPDATE students 
       SET 
         status = 'empty',
         local_image_path = NULL,
         last_error_code = NULL,
         last_error_message = NULL,
         retry_count = 0,
         is_updating = FALSE,
         updated_at = NOW()
       WHERE id = $1
       RETURNING id`,
      [studentId]
    );
    return (res.rowCount ?? 0) > 0;
  }

  public async getOverallMetrics() {
    const res = await this.pool.query(`
      SELECT 
        COUNT(*)::int AS total_students,
        COUNT(CASE WHEN status = 'success' THEN 1 END)::int AS total_success,
        COUNT(CASE WHEN status = 'pending' THEN 1 END)::int AS total_pending,
        COUNT(CASE WHEN status = 'error' THEN 1 END)::int AS total_error,
        COUNT(CASE WHEN status = 'manual_review' THEN 1 END)::int AS total_manual_review,
        COUNT(CASE WHEN status = 'empty' THEN 1 END)::int AS total_empty
      FROM students
    `);
    return res.rows[0];
  }

  /**
   * Luồng 1 (QR Lớp /c/:class_code) - Khóa nguyên tử (Atomic Conditional Lock):
   * Chỉ cập nhật sang 'pending' nếu trạng thái hiện tại là 'empty', 'error' hoặc 'manual_review'.
   * TUYỆT ĐỐI CHẶN 'success' và 'pending' để chống học sinh nộp đè lên bạn cùng lớp.
   */
  public async claimStudentForClassRegister(
    studentId: number,
    localImagePath: string
  ): Promise<StudentRecord | null> {
    const query = `
      UPDATE students 
       SET 
         status = 'pending',
         local_image_path = $1,
         retry_count = 0,
         updated_at = NOW()
       WHERE id = $2 
         AND status IN ('empty', 'error', 'manual_review')
       RETURNING *;
    `;
    const res = await this.pool.query(query, [localImagePath, studentId]);
    return (res.rows[0] as StudentRecord) || null;
  }

  /**
   * Alias tương thích ngược cho claimStudentForClassRegister
   */
  public async claimStudentForUpload(
    studentId: number,
    localImagePath: string
  ): Promise<StudentRecord | null> {
    return this.claimStudentForClassRegister(studentId, localImagePath);
  }

  /**
   * Luồng 2 (Kênh Cá nhân /u/:qr_token) - Khóa nguyên tử bằng mã bí mật qr_token:
   * - Nếu status IN ('empty', 'error', 'manual_review'): chuyển sang 'pending' (mode = 'REGISTER').
   * - Nếu status = 'success' (muốn đổi ảnh): giữ nguyên status = 'success', bật cờ is_updating = TRUE
   *   để bảo toàn trạng thái điểm danh nếu ảnh mới bị lỗi (mode = 'UPDATE_PHOTO').
   */
  public async claimStudentForTokenSelfService(
    qrToken: string,
    localImagePath: string
  ): Promise<{ student: StudentRecord; mode: 'REGISTER' | 'UPDATE_PHOTO' } | null> {
    // 1. Thử khóa ở chế độ Đổi ảnh khi đã 'success' (giữ nguyên status = 'success', bật is_updating = TRUE)
    try {
      const updatePhotoQuery = `
        UPDATE students
        SET
          is_updating = TRUE,
          local_image_path = $1,
          updated_at = NOW()
        WHERE qr_token = $2
          AND status = 'success'
          AND COALESCE(is_updating, FALSE) = FALSE
        RETURNING *;
      `;
      const updateRes = await this.pool.query(updatePhotoQuery, [localImagePath, qrToken]);
      if (updateRes.rows[0]) {
        return {
          student: updateRes.rows[0] as StudentRecord,
          mode: 'UPDATE_PHOTO',
        };
      }
    } catch {
      // Fallback nếu DB cũ chưa có cột is_updating
    }

    // 2. Thử khóa ở chế độ Đăng ký / Sửa lỗi ('empty', 'error', 'manual_review' -> 'pending')
    const registerQuery = `
      UPDATE students
      SET
        status = 'pending',
        local_image_path = $1,
        retry_count = 0,
        updated_at = NOW()
      WHERE qr_token = $2
        AND status IN ('empty', 'error', 'manual_review')
      RETURNING *;
    `;
    const regRes = await this.pool.query(registerQuery, [localImagePath, qrToken]);
    if (regRes.rows[0]) {
      return {
        student: regRes.rows[0] as StudentRecord,
        mode: 'REGISTER',
      };
    }

    return null;
  }

  /**
   * Tính toán finalAliasId ở Pha 2 kèm Deterministic Linear Probing (attempt = 0..3)
   * chống va chạm Hash giữa 2 học sinh trong cùng một lớp.
   */
  public async resolveUniqueFinalAliasId(
    classCode: string,
    personId: string,
    excludeStudentId?: number,
    maxAttempts = 3
  ): Promise<string> {
    for (let attempt = 0; attempt <= maxAttempts; attempt++) {
      const candidate = generateFinalAliasId(classCode, personId, attempt);
      const checkRes = await this.pool.query(
        `SELECT id FROM students 
         WHERE UPPER(alias_id) = UPPER($1) 
           AND ($2::int IS NULL OR id <> $2)
         LIMIT 1`,
        [candidate, excludeStudentId ?? null]
      );
      if (checkRes.rowCount === 0) {
        return candidate;
      }
    }
    throw new Error(
      `HANET_SYNC_EXCEPTION: Không thể tìm được alias_id duy nhất sau ${maxAttempts + 1} lần thử cho personId=${personId} (class=${classCode})`
    );
  }

  public async findById(id: number): Promise<StudentRecord | null> {
    const res = await this.pool.query('SELECT * FROM students WHERE id = $1', [id]);
    return (res.rows[0] as StudentRecord) || null;
  }

  public async findByAliasId(aliasId: string): Promise<StudentRecord | null> {
    const res = await this.pool.query('SELECT * FROM students WHERE alias_id = $1', [aliasId]);
    return (res.rows[0] as StudentRecord) || null;
  }

  public async findByQrToken(qrToken: string): Promise<(StudentRecord & { class_code?: string; class_name?: string }) | null> {
    const query = `
      SELECT s.*, c.code AS class_code, c.name AS class_name
      FROM students s
      LEFT JOIN classes c ON c.id = s.class_id
      WHERE s.qr_token = $1
      LIMIT 1;
    `;
    const res = await this.pool.query(query, [qrToken]);
    return res.rows[0] || null;
  }

  public async getStudentsByClassId(classId: number): Promise<StudentRecord[]> {
    const query = `
      SELECT *
      FROM students 
      WHERE class_id = $1 
      ORDER BY name ASC;
    `;
    const res = await this.pool.query(query, [classId]);
    return res.rows as StudentRecord[];
  }

  public async getStudentsByClassCode(classCode: string): Promise<StudentRecord[]> {
    const query = `
      SELECT s.*
      FROM students s
      JOIN classes c ON c.id = s.class_id
      WHERE UPPER(c.code) = UPPER($1)
      ORDER BY s.name ASC;
    `;
    const res = await this.pool.query(query, [classCode.trim()]);
    return res.rows as StudentRecord[];
  }

  /**
   * Pha 2 (Local-first): Cập nhật thành công nội bộ với finalAliasId và cờ cloud_alias_synced
   */
  public async markPhase2LocalSuccess(
    studentId: number,
    personId: string,
    faceUrl: string,
    finalAliasId: string,
    cloudAliasSynced = false
  ): Promise<StudentRecord | null> {
    try {
      const query = `
        UPDATE students 
        SET 
          status = 'success',
          person_id = $1,
          face_url = $2,
          alias_id = $3,
          cloud_alias_synced = $4,
          is_updating = FALSE,
          last_error_code = NULL,
          last_error_message = NULL,
          updated_at = NOW()
        WHERE id = $5
        RETURNING *;
      `;
      const res = await this.pool.query(query, [
        personId,
        faceUrl,
        finalAliasId,
        cloudAliasSynced,
        studentId,
      ]);
      return (res.rows[0] as StudentRecord) || null;
    } catch {
      return this.markSuccess(studentId, personId, faceUrl);
    }
  }

  /**
   * Đánh dấu đã hoàn tất đồng bộ finalAliasId lên HANET Cloud
   */
  public async markCloudAliasSynced(studentId: number, synced = true): Promise<boolean> {
    try {
      const res = await this.pool.query(
        `UPDATE students SET cloud_alias_synced = $1, updated_at = NOW() WHERE id = $2 RETURNING id`,
        [synced, studentId]
      );
      return (res.rowCount ?? 0) > 0;
    } catch {
      return false;
    }
  }

  /**
   * Lấy danh sách các bản ghi đã 'success' local nhưng cloud_alias_synced = FALSE
   * Kèm chốt chặn an toàn: updated_at < NOW() - INTERVAL '30 seconds' để không đè lên job vừa hoàn tất Pha 2.
   */
  public async getUnsyncedCloudAliasesForRetry(limit = 50): Promise<
    Array<StudentRecord & { class_code?: string; department_code?: string }>
  > {
    const query = `
      SELECT s.*, c.code AS class_code, c.department_code
      FROM students s
      LEFT JOIN classes c ON c.id = s.class_id
      WHERE s.status = 'success'
        AND COALESCE(s.cloud_alias_synced, FALSE) = FALSE
        AND s.person_id IS NOT NULL
        AND s.alias_id IS NOT NULL
        AND s.updated_at < NOW() - INTERVAL '30 seconds'
      ORDER BY s.updated_at ASC
      LIMIT $1;
    `;
    const res = await this.pool.query(query, [limit]);
    return res.rows;
  }

  /**
   * Cập nhật khi đăng ký hoặc đổi ảnh thành công trên HANET Cloud
   */
  public async markSuccess(
    studentId: number,
    personId: string,
    faceUrl: string
  ): Promise<StudentRecord | null> {
    try {
      const query = `
        UPDATE students 
         SET 
           status = 'success',
           person_id = $1,
           face_url = $2,
           is_updating = FALSE,
           last_error_code = NULL,
           last_error_message = NULL,
           updated_at = NOW()
         WHERE id = $3
         RETURNING *;
      `;
      const res = await this.pool.query(query, [personId, faceUrl, studentId]);
      return (res.rows[0] as StudentRecord) || null;
    } catch {
      const fallbackQuery = `
        UPDATE students 
         SET 
           status = 'success',
           person_id = $1,
           face_url = $2,
           last_error_code = NULL,
           last_error_message = NULL,
           updated_at = NOW()
         WHERE id = $3
         RETURNING *;
      `;
      const res = await this.pool.query(fallbackQuery, [personId, faceUrl, studentId]);
      return (res.rows[0] as StudentRecord) || null;
    }
  }

  /**
   * Khi học sinh đang ở status = 'success' dùng link /u/:qr_token đổi ảnh mới nhưng ảnh mới bị lỗi (VD: -9006):
   * Giữ nguyên status = 'success', bảo lưu person_id và face_url cũ, tắt is_updating = FALSE và ghi nhận lỗi.
   */
  public async markSelfServiceUpdateFailure(
    studentId: number,
    errorCode: string,
    errorMessage: string
  ): Promise<StudentRecord | null> {
    try {
      const query = `
        UPDATE students
        SET
          status = 'success',
          is_updating = FALSE,
          last_error_code = $1,
          last_error_message = $2,
          updated_at = NOW()
        WHERE id = $3
        RETURNING *;
      `;
      const res = await this.pool.query(query, [errorCode, errorMessage, studentId]);
      return (res.rows[0] as StudentRecord) || null;
    } catch {
      return null;
    }
  }

  /**
   * Đánh dấu lỗi hoặc đưa vào diện kiểm tra thủ công (manual_review / conflict_pending_review)
   */
  public async markFailure(
    studentId: number,
    status: 'error' | 'manual_review' | 'conflict_pending_review',
    errorCode: string,
    errorMessage: string
  ): Promise<StudentRecord | null> {
    const query = `
      UPDATE students 
       SET 
         status = $1,
         last_error_code = $2,
         last_error_message = $3,
         retry_count = retry_count + 1,
         updated_at = NOW()
       WHERE id = $4
       RETURNING *;
    `;
    const res = await this.pool.query(query, [status, errorCode, errorMessage, studentId]);
    return (res.rows[0] as StudentRecord) || null;
  }

  /**
   * Cập nhật alias_id mới và đánh dấu thành công sau khi hoàn tất quy trình 2 bước trên HANET
   */
  public async updateAliasSuccess(
    studentId: number,
    newAlias: string
  ): Promise<StudentRecord | null> {
    try {
      const query = `
        UPDATE students 
         SET 
           alias_id = $1,
           status = 'success',
           cloud_alias_synced = TRUE,
           last_error_code = NULL,
           last_error_message = NULL,
           updated_at = NOW()
         WHERE id = $2
         RETURNING *;
      `;
      const res = await this.pool.query(query, [newAlias, studentId]);
      return (res.rows[0] as StudentRecord) || null;
    } catch (err: any) {
      if (err?.code === '23505') {
        throw err; // Ném tiếp mã lỗi 23505 để Worker bắt và đưa vào sync_conflicts
      }
      const fallbackQuery = `
        UPDATE students 
         SET 
           alias_id = $1,
           status = 'success',
           last_error_code = NULL,
           last_error_message = NULL,
           updated_at = NOW()
         WHERE id = $2
         RETURNING *;
      `;
      const res = await this.pool.query(fallbackQuery, [newAlias, studentId]);
      return (res.rows[0] as StudentRecord) || null;
    }
  }

  /**
   * Ghi nhận xung đột khuôn mặt vào bảng sync_conflicts
   */
  public async recordSyncConflict(params: {
    studentId: number;
    aliasId: string;
    cloudPersonId?: string | null;
    cloudAliasId?: string | null;
    cloudName?: string | null;
    cloudFaceUrl?: string | null;
    conflictType?: string;
  }): Promise<void> {
    const query = `
      INSERT INTO sync_conflicts (
        student_id, alias_id, cloud_person_id, cloud_alias_id, cloud_name, cloud_face_url, conflict_type
      ) VALUES ($1, $2, $3, $4, $5, $6, $7);
    `;
    try {
      await this.pool.query(query, [
        params.studentId,
        params.aliasId,
        params.cloudPersonId || null,
        params.cloudAliasId || null,
        params.cloudName || null,
        params.cloudFaceUrl || null,
        params.conflictType || 'FACE_EXISTING_DIFFERENT_ALIAS',
      ]);
    } catch (err: any) {
      console.warn(`[SyncConflict] Không thể ghi bảng sync_conflicts: ${err.message}`);
    }
  }

  /**
   * Ghi nhận số lần thử lại khi gặp lỗi tạm thời (giữ nguyên trạng thái 'pending')
   */
  public async recordRetryAttempt(
    studentId: number,
    errorCode: string,
    errorMessage: string
  ): Promise<StudentRecord | null> {
    const query = `
      UPDATE students 
       SET 
         retry_count = retry_count + 1,
         last_error_code = $1,
         last_error_message = $2,
         updated_at = NOW()
       WHERE id = $3
       RETURNING *;
    `;
    const res = await this.pool.query(query, [errorCode, errorMessage, studentId]);
    return (res.rows[0] as StudentRecord) || null;
  }

  /**
   * Tạo 1 học sinh mới trong lớp (tự động cấp qr_token 16 ký tự cố định)
   */
  public async createStudent(
    classId: number,
    name: string,
    classCode: string,
    options?: { nullAlias?: boolean }
  ): Promise<StudentRecord> {
    const aliasId = options?.nullAlias ? null : generateAliasId(classCode);
    const qrToken = generateStudentQrToken();
    try {
      const query = `
        INSERT INTO students (class_id, name, qr_token, alias_id, status)
        VALUES ($1, $2, $3, $4, 'empty')
        RETURNING *;
      `;
      const res = await this.pool.query(query, [classId, name, qrToken, aliasId]);
      return res.rows[0] as StudentRecord;
    } catch {
      const fallbackQuery = `
        INSERT INTO students (class_id, name, alias_id, status)
        VALUES ($1, $2, $3, 'empty')
        RETURNING *;
      `;
      const res = await this.pool.query(fallbackQuery, [classId, name, aliasId || generateAliasId(classCode)]);
      return res.rows[0] as StudentRecord;
    }
  }

  /**
   * Nhập danh sách học sinh hàng loạt (Batch multi-row INSERT trong Transaction)
   */
  public async bulkCreateStudents(
    classId: number,
    names: string[],
    classCode: string,
    options?: { nullAlias?: boolean }
  ): Promise<StudentRecord[]> {
    if (!names.length) return [];

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      const values: any[] = [];
      const rowPlaceholders: string[] = [];
      const usedSet = new Set<string>();

      names.forEach((name, index) => {
        const offset = index * 4;
        const qrToken = generateStudentQrToken();
        const aliasId = options?.nullAlias ? null : generateAliasId(classCode, usedSet);
        values.push(classId, name, qrToken, aliasId);
        rowPlaceholders.push(`($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4}, 'empty')`);
      });

      const query = `
        INSERT INTO students (class_id, name, qr_token, alias_id, status)
        VALUES ${rowPlaceholders.join(', ')}
        RETURNING *;
      `;

      const res = await client.query(query, values);
      await client.query('COMMIT');
      return res.rows as StudentRecord[];
    } catch {
      await client.query('ROLLBACK');
      // Fallback nếu DB test chưa chạy migration qr_token
      const clientFallback = await this.pool.connect();
      try {
        await clientFallback.query('BEGIN');
        const values: any[] = [];
        const rowPlaceholders: string[] = [];
        const usedSet = new Set<string>();
        names.forEach((name, index) => {
          const offset = index * 3;
          const aliasId = generateAliasId(classCode, usedSet);
          values.push(classId, name, aliasId);
          rowPlaceholders.push(`($${offset + 1}, $${offset + 2}, $${offset + 3}, 'empty')`);
        });
        const res = await clientFallback.query(
          `INSERT INTO students (class_id, name, alias_id, status) VALUES ${rowPlaceholders.join(', ')} RETURNING *`,
          values
        );
        await clientFallback.query('COMMIT');
        return res.rows as StudentRecord[];
      } catch (err2) {
        await clientFallback.query('ROLLBACK');
        throw err2;
      } finally {
        clientFallback.release();
      }
    } finally {
      client.release();
    }
  }

  /**
   * Cập nhật thông tin học sinh (đổi tên)
   */
  public async updateStudent(id: number, name: string): Promise<StudentRecord | null> {
    const query = `
      UPDATE students 
      SET name = $1, updated_at = NOW() 
      WHERE id = $2 
      RETURNING *;
    `;
    const res = await this.pool.query(query, [name, id]);
    return (res.rows[0] as StudentRecord) || null;
  }

  /**
   * Xóa học sinh an toàn: Chặn xóa khi status === 'pending'
   */
  public async deleteStudent(id: number): Promise<{ success: boolean; reason?: string; student?: StudentRecord }> {
    const student = await this.findById(id);
    if (!student) {
      return { success: false, reason: 'NOT_FOUND' };
    }

    if (student.status === 'pending') {
      return { success: false, reason: 'STUDENT_PENDING', student };
    }

    await this.pool.query('DELETE FROM students WHERE id = $1', [id]);
    return { success: true, student };
  }
}
