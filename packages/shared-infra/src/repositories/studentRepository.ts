import { Pool } from 'pg';
import crypto from 'node:crypto';
import { StudentStatus } from '@thanh-giuse/shared-types';

export { StudentStatus };

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
  alias_id: string;
  status: StudentStatus;
  person_id: string | null;
  face_url: string | null;
  local_image_path: string | null;
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
      conditions.push(`(s.name ILIKE $${values.length} OR s.alias_id ILIKE $${values.length})`);
    }

    const whereClause = conditions.join(' AND ');

    // Truy vấn tổng số lượng bản ghi
    const countQuery = `SELECT COUNT(*)::int AS total FROM students s WHERE ${whereClause}`;
    const totalRes = await this.pool.query(countQuery, values);
    const total = totalRes.rows[0]?.total ?? 0;

    // Lấy dữ liệu phân trang kèm tên lớp
    const dataValues = [...values, limit, offset];
    const dataQuery = `
      SELECT 
        s.*,
        c.code AS class_code,
        c.name AS class_name
      FROM students s
      JOIN classes c ON c.id = s.class_id
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
   * Khóa nguyên tử (Atomic Conditional Lock):
   * Chỉ cập nhật sang 'pending' nếu trạng thái hiện tại là 'empty', 'error' hoặc 'manual_review'.
   * Trả về null nếu bản ghi đang 'pending' hoặc đã 'success' (chống race condition).
   */
  public async claimStudentForUpload(
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

  public async findById(id: number): Promise<StudentRecord | null> {
    const res = await this.pool.query('SELECT * FROM students WHERE id = $1', [id]);
    return (res.rows[0] as StudentRecord) || null;
  }

  public async findByAliasId(aliasId: string): Promise<StudentRecord | null> {
    const res = await this.pool.query('SELECT * FROM students WHERE alias_id = $1', [aliasId]);
    return (res.rows[0] as StudentRecord) || null;
  }

  public async getStudentsByClassId(classId: number): Promise<StudentRecord[]> {
    const query = `
      SELECT id, class_id, name, alias_id, status, person_id, face_url, local_image_path, last_error_code, last_error_message, retry_count, created_at, updated_at
      FROM students 
      WHERE class_id = $1 
      ORDER BY name ASC;
    `;
    const res = await this.pool.query(query, [classId]);
    return res.rows as StudentRecord[];
  }

  /**
   * Cập nhật khi đăng ký thành công trên HANET Cloud
   */
  public async markSuccess(
    studentId: number,
    personId: string,
    faceUrl: string
  ): Promise<StudentRecord | null> {
    const query = `
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
    const res = await this.pool.query(query, [personId, faceUrl, studentId]);
    return (res.rows[0] as StudentRecord) || null;
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
    const query = `
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
    const res = await this.pool.query(query, [newAlias, studentId]);
    return (res.rows[0] as StudentRecord) || null;
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
        params.conflictType || 'FACE_EXISTING_DIFFERENT_ALIAS'
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
   * Tạo 1 học sinh mới trong lớp
   */
  public async createStudent(
    classId: number,
    name: string,
    classCode: string
  ): Promise<StudentRecord> {
    const aliasId = generateAliasId(classCode);
    const query = `
      INSERT INTO students (class_id, name, alias_id, status)
      VALUES ($1, $2, $3, 'empty')
      RETURNING *;
    `;
    const res = await this.pool.query(query, [classId, name, aliasId]);
    return res.rows[0] as StudentRecord;
  }

  /**
   * Nhập danh sách học sinh hàng loạt (Batch multi-row INSERT trong Transaction)
   */
  public async bulkCreateStudents(
    classId: number,
    names: string[],
    classCode: string
  ): Promise<StudentRecord[]> {
    if (!names.length) return [];

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      const values: any[] = [];
      const rowPlaceholders: string[] = [];
      const usedSet = new Set<string>();

      names.forEach((name, index) => {
        const offset = index * 3;
        const aliasId = generateAliasId(classCode, usedSet);
        values.push(classId, name, aliasId);
        rowPlaceholders.push(`($${offset + 1}, $${offset + 2}, $${offset + 3}, 'empty')`);
      });

      const query = `
        INSERT INTO students (class_id, name, alias_id, status)
        VALUES ${rowPlaceholders.join(', ')}
        RETURNING *;
      `;

      const res = await client.query(query, values);
      await client.query('COMMIT');
      return res.rows as StudentRecord[];
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
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
