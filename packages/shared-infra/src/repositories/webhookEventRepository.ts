import { Pool } from 'pg';

export type WebhookDisposition = 'applied' | 'deferred' | 'invalid_hash' | 'ignored' | 'failed';

export interface WebhookEventRecord {
  id: number;
  received_at: string;
  hanet_event_id: string | null;
  data_type: string | null;
  action_type: string | null;
  person_id: string | null;
  device_id: string | null;
  place_id: string | null;
  place_name: string | null;
  person_name: string | null;
  device_name: string | null;
  alias_id: string | null;
  student_id: number | null;
  class_id: number | null;
  hash_valid: boolean | null;
  disposition: WebhookDisposition;
  kill_switch_active: boolean;
  error_message: string | null;
  payload: any;
  student_name?: string | null | undefined;
  class_code?: string | null | undefined;
  class_name?: string | null | undefined;
}

export interface CreateWebhookEventParams {
  hanet_event_id?: string | null | undefined;
  data_type?: string | null | undefined;
  action_type?: string | null | undefined;
  person_id?: string | null | undefined;
  device_id?: string | null | undefined;
  place_id?: string | null | undefined;
  place_name?: string | null | undefined;
  person_name?: string | null | undefined;
  device_name?: string | null | undefined;
  alias_id?: string | null | undefined;
  student_id?: number | null | undefined;
  class_id?: number | null | undefined;
  hash_valid?: boolean | null | undefined;
  disposition: WebhookDisposition;
  kill_switch_active?: boolean | undefined;
  error_message?: string | null | undefined;
  payload?: any;
}

export interface WebhookEventFilterParams {
  page?: number | undefined;
  limit?: number | undefined;
  data_type?: string | undefined;
  action_type?: string | undefined;
  disposition?: string | undefined;
  q?: string | undefined;
}

export class WebhookEventRepository {
  constructor(private readonly pool: Pool) {}

  public async recordEvent(params: CreateWebhookEventParams): Promise<void> {
    let sanitizedPayload: any = null;
    if (params.payload && typeof params.payload === 'object') {
      sanitizedPayload = { ...params.payload };
      if ('keycode' in sanitizedPayload) {
        sanitizedPayload.keycode = null;
      }
    } else if (params.payload !== undefined) {
      sanitizedPayload = params.payload;
    }

    const query = `
      INSERT INTO webhook_events (
        hanet_event_id, data_type, action_type, person_id, device_id,
        place_id, place_name, person_name, device_name, alias_id,
        student_id, class_id, hash_valid, disposition, kill_switch_active,
        error_message, payload, received_at
      ) VALUES (
        $1, $2, $3, $4, $5,
        $6, $7, $8, $9, $10,
        $11, $12, $13, $14, $15,
        $16, $17, NOW()
      );
    `;

    await this.pool.query(query, [
      params.hanet_event_id || null,
      params.data_type || null,
      params.action_type || null,
      params.person_id || null,
      params.device_id || null,
      params.place_id || null,
      params.place_name || null,
      params.person_name || null,
      params.device_name || null,
      params.alias_id || null,
      params.student_id ?? null,
      params.class_id ?? null,
      params.hash_valid ?? null,
      params.disposition,
      params.kill_switch_active ?? false,
      params.error_message || null,
      sanitizedPayload !== null ? JSON.stringify(sanitizedPayload) : null,
    ]);
  }

  public async getPaginatedEvents(
    filter: WebhookEventFilterParams = {}
  ): Promise<{ items: WebhookEventRecord[]; total: number }> {
    const page = filter.page && filter.page > 0 ? filter.page : 1;
    const limit = filter.limit && filter.limit > 0 ? filter.limit : 20;
    const offset = (page - 1) * limit;

    const conditions: string[] = ['1=1'];
    const values: any[] = [];

    if (filter.data_type) {
      values.push(filter.data_type);
      conditions.push(`w.data_type = $${values.length}`);
    }

    if (filter.action_type) {
      values.push(filter.action_type);
      conditions.push(`w.action_type = $${values.length}`);
    }

    if (filter.disposition) {
      values.push(filter.disposition);
      conditions.push(`w.disposition = $${values.length}`);
    }

    if (filter.q) {
      values.push(`%${filter.q.trim()}%`);
      const idx = values.length;
      conditions.push(`(
        w.person_id ILIKE $${idx} OR
        w.device_id ILIKE $${idx} OR
        w.place_id ILIKE $${idx} OR
        w.alias_id ILIKE $${idx} OR
        w.person_name ILIKE $${idx} OR
        w.device_name ILIKE $${idx} OR
        w.place_name ILIKE $${idx}
      )`);
    }

    const whereClause = conditions.join(' AND ');

    const countRes = await this.pool.query(
      `SELECT COUNT(*)::int AS total FROM webhook_events w WHERE ${whereClause}`,
      values
    );
    const total = countRes.rows[0]?.total ?? 0;

    const dataValues = [...values, limit, offset];
    const dataQuery = `
      SELECT w.*, s.name AS student_name, c.code AS class_code, c.name AS class_name
      FROM webhook_events w
      LEFT JOIN students s ON s.id = w.student_id
      LEFT JOIN classes c ON c.id = w.class_id
      WHERE ${whereClause}
      ORDER BY w.received_at DESC, w.id DESC
      LIMIT $${dataValues.length - 1} OFFSET $${dataValues.length}
    `;
    const dataRes = await this.pool.query(dataQuery, dataValues);
    return { items: dataRes.rows, total };
  }

  public async getEventById(id: number): Promise<WebhookEventRecord | null> {
    const query = `
      SELECT w.*, s.name AS student_name, c.code AS class_code, c.name AS class_name
      FROM webhook_events w
      LEFT JOIN students s ON s.id = w.student_id
      LEFT JOIN classes c ON c.id = w.class_id
      WHERE w.id = $1
    `;
    const res = await this.pool.query(query, [id]);
    return res.rows[0] || null;
  }
}
