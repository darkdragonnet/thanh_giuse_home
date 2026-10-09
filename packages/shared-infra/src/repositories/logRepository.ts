import { Pool } from 'pg';

export interface CreateLogParams {
  alias_id?: string | null | undefined;
  class_id?: number | null | undefined;
  action: 'REGISTER' | 'UPDATE_PHOTO' | 'MANUAL_OVERRIDE' | 'RETRY';
  result_code: string;
  result_message?: string | null | undefined;
  ip?: string | null | undefined;
}

export class LogRepository {
  constructor(private readonly db: Pool) {}

  public async recordLog(params: CreateLogParams): Promise<void> {
    const query = `
      INSERT INTO logs (alias_id, class_id, action, result_code, result_message, ip, created_at)
      VALUES ($1, $2, $3, $4, $5, $6, NOW());
    `;
    await this.db.query(query, [
      params.alias_id || null,
      params.class_id || null,
      params.action,
      params.result_code,
      params.result_message || null,
      params.ip || null,
    ]);
  }
}
