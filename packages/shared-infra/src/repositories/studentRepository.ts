import { Pool } from 'pg';

export type StudentStatus = 'empty' | 'pending' | 'success' | 'error' | 'manual_review';

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

export class StudentRepository {
  constructor(private readonly db: Pool) {}

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
    const res = await this.db.query(query, [localImagePath, studentId]);
    return (res.rows[0] as StudentRecord) || null;
  }

  public async findById(id: number): Promise<StudentRecord | null> {
    const res = await this.db.query('SELECT * FROM students WHERE id = $1', [id]);
    return (res.rows[0] as StudentRecord) || null;
  }

  public async findByAliasId(aliasId: string): Promise<StudentRecord | null> {
    const res = await this.db.query('SELECT * FROM students WHERE alias_id = $1', [aliasId]);
    return (res.rows[0] as StudentRecord) || null;
  }

  public async getStudentsByClassId(classId: number): Promise<StudentRecord[]> {
    const query = `
      SELECT id, class_id, name, alias_id, status, face_url, created_at, updated_at
      FROM students 
      WHERE class_id = $1 
      ORDER BY name ASC;
    `;
    const res = await this.db.query(query, [classId]);
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
    const res = await this.db.query(query, [personId, faceUrl, studentId]);
    return (res.rows[0] as StudentRecord) || null;
  }

  /**
   * Đánh dấu lỗi hoặc đưa vào diện kiểm tra thủ công (manual_review)
   */
  public async markFailure(
    studentId: number,
    status: 'error' | 'manual_review',
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
    const res = await this.db.query(query, [status, errorCode, errorMessage, studentId]);
    return (res.rows[0] as StudentRecord) || null;
  }
}
