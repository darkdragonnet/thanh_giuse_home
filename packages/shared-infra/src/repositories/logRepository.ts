import { Pool } from 'pg';

export interface CreateLogParams {
  student_id?: number | null | undefined;
  alias_id?: string | null | undefined;
  class_id?: number | null | undefined;
  action: 'REGISTER' | 'UPDATE_PHOTO' | 'MANUAL_OVERRIDE' | 'RETRY' | 'QUOTA_EXCEEDED' | (string & {});
  result_code: string;
  result_message?: string | null | undefined;
  ip?: string | null | undefined;
}

export interface LogFilterParams {
  action?: string | undefined;
  resultCode?: string | undefined;
  classId?: number | undefined;
  search?: string | undefined;
  page: number;
  limit: number;
}

export class LogRepository {
  constructor(private readonly pool: Pool) {}

  public async recordLog(params: CreateLogParams): Promise<void> {
    try {
      const query = `
        INSERT INTO logs (student_id, alias_id, class_id, action, result_code, result_message, ip, created_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, NOW());
      `;
      await this.pool.query(query, [
        params.student_id ?? null,
        params.alias_id || null,
        params.class_id || null,
        params.action,
        params.result_code,
        params.result_message || null,
        params.ip || null,
      ]);
    } catch {
      const fallbackQuery = `
        INSERT INTO logs (alias_id, class_id, action, result_code, result_message, ip, created_at)
        VALUES ($1, $2, $3, $4, $5, $6, NOW());
      `;
      await this.pool.query(fallbackQuery, [
        params.alias_id || null,
        params.class_id || null,
        params.action,
        params.result_code,
        params.result_message || null,
        params.ip || null,
      ]);
    }
  }

  public async getPaginatedLogs(filter: LogFilterParams) {
    const { action, resultCode, classId, search, page, limit } = filter;
    const offset = (page - 1) * limit;
    const conditions: string[] = ['1=1'];
    const values: any[] = [];

    if (action) {
      values.push(action);
      conditions.push(`l.action = $${values.length}`);
    }

    if (resultCode) {
      values.push(resultCode);
      conditions.push(`l.result_code = $${values.length}`);
    }

    if (classId) {
      values.push(classId);
      conditions.push(`l.class_id = $${values.length}`);
    }

    if (search) {
      values.push(`%${search}%`);
      conditions.push(`(l.alias_id ILIKE $${values.length} OR l.result_message ILIKE $${values.length})`);
    }

    const whereClause = conditions.join(' AND ');

    const countRes = await this.pool.query(
      `SELECT COUNT(*)::int AS total FROM logs l WHERE ${whereClause}`,
      values
    );
    const total = countRes.rows[0]?.total ?? 0;

    const dataValues = [...values, limit, offset];
    const dataQuery = `
      SELECT l.*, c.code AS class_code
      FROM logs l
      LEFT JOIN classes c ON c.id = l.class_id
      WHERE ${whereClause}
      ORDER BY l.id DESC
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
}
