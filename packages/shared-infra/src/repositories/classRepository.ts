import { Pool } from 'pg';
import crypto from 'node:crypto';
import type { CreateClassInput } from '@thanh-giuse/shared-types';

export interface ClassRecord {
  id: number;
  code: string;
  name: string;
  teacher_name: string | null;
  token: string;
  is_locked: boolean;
  created_at: Date;
}

export interface ClassStatsRow {
  id: number;
  code: string;
  name: string;
  teacher_name: string;
  token: string;
  is_locked: boolean;
  total_students: number;
  success_count: number;
  pending_count: number;
  error_count: number;
  manual_review_count: number;
  empty_count: number;
  created_at: string;
}

export class ClassRepository {
  constructor(private readonly pool: Pool) {}

  public async getClassesWithStats(params?: { search?: string; grade?: string }): Promise<ClassStatsRow[]> {
    let sql = `
      SELECT 
        c.id, c.code, c.name, c.teacher_name, c.token, c.is_locked, c.created_at,
        COUNT(s.id)::int AS total_students,
        COUNT(CASE WHEN s.status = 'success' THEN 1 END)::int AS success_count,
        COUNT(CASE WHEN s.status = 'pending' THEN 1 END)::int AS pending_count,
        COUNT(CASE WHEN s.status = 'error' THEN 1 END)::int AS error_count,
        COUNT(CASE WHEN s.status = 'manual_review' THEN 1 END)::int AS manual_review_count,
        COUNT(CASE WHEN s.status = 'empty' THEN 1 END)::int AS empty_count
      FROM classes c
      LEFT JOIN students s ON s.class_id = c.id
      WHERE 1=1
    `;
    const values: any[] = [];

    if (params?.grade) {
      values.push(`${params.grade}%`);
      sql += ` AND c.code ILIKE $${values.length}`;
    }

    if (params?.search) {
      values.push(`%${params.search}%`);
      sql += ` AND (c.code ILIKE $${values.length} OR c.name ILIKE $${values.length} OR c.teacher_name ILIKE $${values.length})`;
    }

    sql += ` GROUP BY c.id ORDER BY c.code ASC`;

    const result = await this.pool.query(sql, values);
    return result.rows;
  }

  public async updateLockStatus(classId: number, isLocked: boolean): Promise<boolean> {
    const res = await this.pool.query(
      `UPDATE classes SET is_locked = $1 WHERE id = $2 RETURNING id`,
      [isLocked, classId]
    );
    return (res.rowCount ?? 0) > 0;
  }

  public async setClassLock(classId: number, isLocked: boolean): Promise<boolean> {
    return this.updateLockStatus(classId, isLocked);
  }

  public async findByCode(code: string): Promise<ClassRecord | null> {
    const res = await this.pool.query('SELECT * FROM classes WHERE code = $1', [code]);
    return (res.rows[0] as ClassRecord) || null;
  }

  public async findById(id: number): Promise<ClassRecord | null> {
    const res = await this.pool.query('SELECT * FROM classes WHERE id = $1', [id]);
    return (res.rows[0] as ClassRecord) || null;
  }

  public async findByToken(token: string): Promise<ClassRecord | null> {
    const res = await this.pool.query('SELECT * FROM classes WHERE token = $1', [token]);
    return (res.rows[0] as ClassRecord) || null;
  }

  public async checkExistence(code: string, token: string): Promise<{ codeExists: boolean; tokenExists: boolean }> {
    const res = await this.pool.query(
      'SELECT code, token FROM classes WHERE code = $1 OR token = $2',
      [code, token]
    );
    let codeExists = false;
    let tokenExists = false;
    for (const row of res.rows) {
      if (row.code === code) codeExists = true;
      if (row.token === token) tokenExists = true;
    }
    return { codeExists, tokenExists };
  }

  public async createClass(data: CreateClassInput): Promise<ClassRecord> {
    const cleanCode = data.code.trim().toUpperCase();
    const cleanName = data.name.trim();
    const cleanTeacher = data.teacher_name?.trim() || null;
    const token = data.token?.trim() || `PIN_${cleanCode}_${crypto.randomBytes(3).toString('hex').toUpperCase()}`;

    const res = await this.pool.query(
      `INSERT INTO classes (code, name, teacher_name, token, is_locked)
       VALUES ($1, $2, $3, $4, FALSE)
       RETURNING *`,
      [cleanCode, cleanName, cleanTeacher, token]
    );
    return res.rows[0] as ClassRecord;
  }

  /**
   * Kiểm tra mã PIN giáo viên khớp với token của lớp để miễn trừ Rate Limit
   */
  public async verifyTeacherPin(classId: number, pin: string): Promise<boolean> {
    const res = await this.pool.query(
      'SELECT id FROM classes WHERE id = $1 AND token = $2',
      [classId, pin]
    );
    return res.rows.length > 0;
  }
}
