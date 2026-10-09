import { Pool } from 'pg';

export interface ClassRecord {
  id: number;
  code: string;
  name: string;
  teacher_name: string | null;
  token: string;
  is_locked: boolean;
  created_at: Date;
}

export class ClassRepository {
  constructor(private readonly db: Pool) {}

  public async findByCode(code: string): Promise<ClassRecord | null> {
    const res = await this.db.query('SELECT * FROM classes WHERE code = $1', [code]);
    return (res.rows[0] as ClassRecord) || null;
  }

  public async findById(id: number): Promise<ClassRecord | null> {
    const res = await this.db.query('SELECT * FROM classes WHERE id = $1', [id]);
    return (res.rows[0] as ClassRecord) || null;
  }

  /**
   * Kiểm tra mã PIN giáo viên khớp với token của lớp để miễn trừ Rate Limit
   */
  public async verifyTeacherPin(classId: number, pin: string): Promise<boolean> {
    const res = await this.db.query(
      'SELECT id FROM classes WHERE id = $1 AND token = $2',
      [classId, pin]
    );
    return res.rows.length > 0;
  }

  public async setClassLock(classId: number, isLocked: boolean): Promise<boolean> {
    const res = await this.db.query(
      'UPDATE classes SET is_locked = $1 WHERE id = $2 RETURNING id',
      [isLocked, classId]
    );
    return res.rows.length > 0;
  }
}
