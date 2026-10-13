import { Pool } from 'pg';
import type { AdminRequest, AdminRequestStatus, CreateAdminRequestDto } from '@thanh-giuse/shared-types';

export interface AdminRequestFilterParams {
  status?: AdminRequestStatus | undefined;
  classId?: number | undefined;
  page?: number | undefined;
  limit?: number | undefined;
}

export class AdminRequestRepository {
  constructor(private readonly db: Pool) {}

  public async createRequest(data: CreateAdminRequestDto): Promise<AdminRequest> {
    try {
      const query = `
        INSERT INTO admin_requests (student_id, alias_id, class_id, student_name, image_path, note, ip, status)
        VALUES ($1, $2, $3, $4, $5, $6, $7, 'new')
        RETURNING *;
      `;
      const res = await this.db.query(query, [
        data.student_id ?? null,
        data.alias_id ?? null,
        data.class_id ?? null,
        data.student_name ?? null,
        data.image_path,
        data.note ?? null,
        data.ip ?? null,
      ]);
      return res.rows[0];
    } catch {
      const fallbackQuery = `
        INSERT INTO admin_requests (alias_id, class_id, student_name, image_path, note, ip, status)
        VALUES ($1, $2, $3, $4, $5, $6, 'new')
        RETURNING *;
      `;
      const res = await this.db.query(fallbackQuery, [
        data.alias_id ?? null,
        data.class_id ?? null,
        data.student_name ?? null,
        data.image_path,
        data.note ?? null,
        data.ip ?? null,
      ]);
      return res.rows[0];
    }
  }

  public async getRequests(filter: AdminRequestFilterParams = {}): Promise<any> {
    const conditions: string[] = ['1=1'];
    const values: any[] = [];

    if (filter.status) {
      values.push(filter.status);
      conditions.push(`status = $${values.length}`);
    }
    if (filter.classId) {
      values.push(filter.classId);
      conditions.push(`class_id = $${values.length}`);
    }

    const whereClause = conditions.join(' AND ');

    if (filter.page && filter.limit) {
      const page = filter.page;
      const limit = filter.limit;
      const offset = (page - 1) * limit;

      const countRes = await this.db.query(
        `SELECT COUNT(*)::int AS total FROM admin_requests WHERE ${whereClause}`,
        values
      );
      const total = countRes.rows[0]?.total ?? 0;

      const dataValues = [...values, limit, offset];
      const dataQuery = `
        SELECT * FROM admin_requests
        WHERE ${whereClause}
        ORDER BY created_at DESC
        LIMIT $${dataValues.length - 1} OFFSET $${dataValues.length};
      `;
      const dataRes = await this.db.query(dataQuery, dataValues);

      return {
        items: dataRes.rows,
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit) || 1,
      };
    }

    const query = `SELECT * FROM admin_requests WHERE ${whereClause} ORDER BY created_at DESC;`;
    const res = await this.db.query(query, values);
    return res.rows;
  }

  public async updateRequestStatus(id: number, status: AdminRequestStatus): Promise<AdminRequest | null> {
    const query = `
      UPDATE admin_requests
      SET status = $1, updated_at = NOW()
      WHERE id = $2
      RETURNING *;
    `;
    const res = await this.db.query(query, [status, id]);
    return res.rows[0] || null;
  }

  public async getRequestsByAlias(aliasId: string): Promise<AdminRequest[]> {
    const query = `
      SELECT * FROM admin_requests
      WHERE alias_id = $1
      ORDER BY created_at DESC;
    `;
    const res = await this.db.query(query, [aliasId]);
    return res.rows;
  }
}
