import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import crypto from 'node:crypto';
import pg from 'pg';
import IORedis from 'ioredis';
import {
  StudentRepository,
  createDbPool,
  closeDbPool,
  WebhookEventRepository,
} from '@thanh-giuse/shared-infra';

const API_BASE = process.env.API_BASE || 'http://localhost:3000';
const rawDbUrl =
  process.env.DATABASE_URL ||
  'postgresql://postgres_user:super_secure_postgres_password_change_me@localhost:5432/thanh_giuse_db';
const DB_URL = rawDbUrl.replace('@app_postgres:', '@localhost:').replace('@postgres:', '@localhost:');
const REDIS_URL =
  process.env.REDIS_URL ||
  'redis://:super_secure_redis_password_change_me@localhost:6379/0';
const ADMIN_SECRET_TOKEN = process.env.ADMIN_SECRET_TOKEN || 'admin_secret_super_secure_token';
const CLIENT_SECRET = process.env.HANET_CLIENT_SECRET || 'eb43ca63325ab6cfc71a38fc01511456';

function makeHash(id: string, secret: string = CLIENT_SECRET): string {
  return crypto.createHash('md5').update(secret + id).digest('hex');
}

describe('Contract Test: Webhook Events Viewer (Option A - Read-Only)', () => {
  let pool: pg.Pool;
  let redis: IORedis;
  let studentRepo: StudentRepository;
  let webhookRepo: WebhookEventRepository;

  let testClassId: number;
  const testClassCode = `TEST_CLS_${Date.now().toString().slice(-4)}`;
  const createdStudentIds: number[] = [];

  beforeAll(async () => {
    pool = createDbPool({ connectionString: DB_URL });
    const formattedRedisUrl = REDIS_URL.replace('@app_redis:', '@localhost:').replace('@redis:', '@localhost:');
    redis = new IORedis(formattedRedisUrl, { maxRetriesPerRequest: null });
    studentRepo = new StudentRepository(pool);
    webhookRepo = new WebhookEventRepository(pool);

    // Tạo 1 lớp học tạm cho test
    const clsRes = await pool.query(
      `INSERT INTO classes (code, name, token, is_locked)
       VALUES ($1, $2, $3, false)
       RETURNING id`,
      [testClassCode, `Lớp Test Webhook ${testClassCode}`, `PIN_${testClassCode}`]
    );
    testClassId = clsRes.rows[0].id;

    // Đảm bảo Kill Switch đang mở trước khi test
    await fetch(`${API_BASE}/api/admin/settings/kill-switch`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${ADMIN_SECRET_TOKEN}`,
      },
      body: JSON.stringify({ enabled: true }),
    });
  });

  afterAll(async () => {
    // 1. Phục hồi Kill Switch về trạng thái mở (enabled: true)
    try {
      await fetch(`${API_BASE}/api/admin/settings/kill-switch`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${ADMIN_SECRET_TOKEN}`,
        },
        body: JSON.stringify({ enabled: true }),
      });
    } catch {
      // ignore
    }

    // 2. Vệ sinh toàn bộ dữ liệu mang tiền tố TEST_
    await pool.query(
      `DELETE FROM webhook_events 
       WHERE hanet_event_id LIKE 'TEST_%' 
          OR person_id LIKE 'TEST_%' 
          OR device_id LIKE 'TEST_%' 
          OR place_id LIKE 'TEST_%' 
          OR alias_id LIKE 'TEST_%'`
    );

    await pool.query(`DELETE FROM logs WHERE alias_id LIKE 'TEST_%'`);

    if (createdStudentIds.length > 0) {
      await pool.query('DELETE FROM students WHERE id = ANY($1::int[])', [createdStudentIds]);
    }
    if (testClassId) {
      await pool.query('DELETE FROM students WHERE class_id = $1', [testClassId]);
      await pool.query('DELETE FROM classes WHERE id = $1', [testClassId]);
    }

    await redis.quit();
    await closeDbPool(pool);
  });

  // Test 1: POST /api/webhooks/hanet - Sai chữ ký Hash -> HTTP 400 và disposition invalid_hash
  it('1. Sai hash: trả về HTTP 400 INVALID_HASH và ghi nhận disposition invalid_hash', async () => {
    const eventId = `TEST_EVT_HASH_${Date.now()}`;
    const payload = {
      id: eventId,
      data_type: 'person',
      action_type: 'add',
      personID: 'TEST_PER_INVALID_HASH',
      hash: 'invalid_md5_hash_string',
    };

    const res = await fetch(`${API_BASE}/api/webhooks/hanet`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    expect(res.status).toBe(400);
    const body: any = await res.json();
    expect(body.returnCode).toBe(-1);
    expect(body.message).toBe('INVALID_HASH');

    // Kiểm tra dòng ghi nhận trong webhook_events
    const eventRes = await pool.query(
      `SELECT * FROM webhook_events WHERE hanet_event_id = $1`,
      [eventId]
    );
    expect(eventRes.rows.length).toBe(1);
    const event = eventRes.rows[0];
    expect(event.disposition).toBe('invalid_hash');
    expect(event.hash_valid).toBe(false);
    expect(event.kill_switch_active).toBe(false);
  });

  // Test 2: POST /api/webhooks/hanet - Kill Switch ngắt -> HTTP 200 SUCCESS và disposition deferred
  it('2. Kill Switch ngắt: trả về HTTP 200 SUCCESS và ghi nhận disposition deferred', async () => {
    // Bật Kill Switch (ngắt bảo trì)
    const pauseRes = await fetch(`${API_BASE}/api/admin/settings/kill-switch`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${ADMIN_SECRET_TOKEN}`,
      },
      body: JSON.stringify({ enabled: false }),
    });
    expect(pauseRes.status).toBe(200);

    const eventId = `TEST_EVT_DEFERRED_${Date.now()}`;
    const payload = {
      id: eventId,
      data_type: 'person',
      action_type: 'add',
      personID: 'TEST_PER_DEFERRED',
      aliasID: 'TEST_ALS_DEFERRED',
      personName: 'Học sinh Hoãn',
      hash: makeHash(eventId),
    };

    const res = await fetch(`${API_BASE}/api/webhooks/hanet`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    expect(res.status).toBe(200);
    const body: any = await res.json();
    expect(body.returnCode).toBe(1);
    expect(body.message).toBe('SUCCESS');

    // Kiểm tra dòng ghi nhận trong webhook_events
    const eventRes = await pool.query(
      `SELECT * FROM webhook_events WHERE hanet_event_id = $1`,
      [eventId]
    );
    expect(eventRes.rows.length).toBe(1);
    const event = eventRes.rows[0];
    expect(event.disposition).toBe('deferred');
    expect(event.kill_switch_active).toBe(true);
    expect(event.hash_valid).toBe(true);

    // Mở lại Kill Switch
    await fetch(`${API_BASE}/api/admin/settings/kill-switch`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${ADMIN_SECRET_TOKEN}`,
      },
      body: JSON.stringify({ enabled: true }),
    });
  });

  // Test 3: POST /api/webhooks/hanet - Person add/update -> HTTP 200 và disposition applied
  it('3. Person add: cập nhật học sinh thành công, HTTP 200 và ghi nhận disposition applied', async () => {
    const aliasId = `TEST_ALS_ADD_${Date.now().toString().slice(-4)}`;
    const stuRes = await pool.query(
      `INSERT INTO students (class_id, name, qr_token, alias_id, status)
       VALUES ($1, $2, $3, $4, 'empty')
       RETURNING id`,
      [testClassId, 'TEST Học Sinh Add', `QR_${aliasId}`, aliasId]
    );
    const studentId = stuRes.rows[0].id;
    createdStudentIds.push(studentId);

    const eventId = `TEST_EVT_ADD_${Date.now()}`;
    const personId = `TEST_PER_ADD_${Date.now()}`;
    const payload = {
      id: eventId,
      data_type: 'person',
      action_type: 'add',
      personID: personId,
      aliasID: aliasId,
      personName: 'TEST Học Sinh Add',
      hash: makeHash(eventId),
    };

    const res = await fetch(`${API_BASE}/api/webhooks/hanet`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    expect(res.status).toBe(200);
    const body: any = await res.json();
    expect(body.returnCode).toBe(1);

    // Kiểm tra học sinh được cập nhật đúng hành vi cũ
    const updatedStudent = await studentRepo.findById(studentId);
    expect(updatedStudent?.status).toBe('success');
    expect(updatedStudent?.person_id).toBe(personId);

    // Kiểm tra event ghi nhận đúng disposition applied
    const eventRes = await pool.query(
      `SELECT * FROM webhook_events WHERE hanet_event_id = $1`,
      [eventId]
    );
    expect(eventRes.rows.length).toBe(1);
    const event = eventRes.rows[0];
    expect(event.disposition).toBe('applied');
    expect(event.student_id).toBe(studentId);
    expect(event.class_id).toBe(testClassId);
    expect(event.hash_valid).toBe(true);
  });

  // Test 4: POST /api/webhooks/hanet - Person delete -> HTTP 200, status manual_review và disposition applied
  it('4. Person delete: chuyển học sinh sang manual_review, KHÔNG xóa khỏi DB, ghi nhận disposition applied', async () => {
    const aliasId = `TEST_ALS_DEL_${Date.now().toString().slice(-4)}`;
    const personId = `TEST_PER_DEL_${Date.now()}`;
    const stuRes = await pool.query(
      `INSERT INTO students (class_id, name, qr_token, alias_id, person_id, status)
       VALUES ($1, $2, $3, $4, $5, 'success')
       RETURNING id`,
      [testClassId, 'TEST Học Sinh Delete', `QR_${aliasId}`, aliasId, personId]
    );
    const studentId = stuRes.rows[0].id;
    createdStudentIds.push(studentId);

    const eventId = `TEST_EVT_DEL_${Date.now()}`;
    const payload = {
      id: eventId,
      data_type: 'person',
      action_type: 'delete',
      personID: personId,
      hash: makeHash(eventId),
    };

    const res = await fetch(`${API_BASE}/api/webhooks/hanet`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    expect(res.status).toBe(200);

    // Học sinh chuyển manual_review, bảo tồn person_id, tuyệt đối KHÔNG bị xóa
    const updatedStudent = await studentRepo.findById(studentId);
    expect(updatedStudent).not.toBeNull();
    expect(updatedStudent?.status).toBe('manual_review');
    expect(updatedStudent?.last_error_code).toBe('CLOUD_DELETED');
    expect(updatedStudent?.person_id).toBe(personId);

    // Event ghi nhận disposition applied
    const eventRes = await pool.query(
      `SELECT * FROM webhook_events WHERE hanet_event_id = $1`,
      [eventId]
    );
    expect(eventRes.rows.length).toBe(1);
    expect(eventRes.rows[0].disposition).toBe('applied');
  });

  // Test 5: POST /api/webhooks/hanet - Device update -> HTTP 200, disposition ignored, KHÔNG đổi học sinh
  it('5. Device push: HTTP 200, ghi nhận disposition ignored, KHÔNG thay đổi học sinh nào', async () => {
    const studentCountBefore = await pool.query(`SELECT COUNT(*)::int AS cnt FROM students`);

    const eventId = `TEST_EVT_DEV_${Date.now()}`;
    const payload = {
      id: eventId,
      data_type: 'device',
      action_type: 'update',
      deviceID: 'TEST_DEV_001',
      deviceName: 'Camera Cổng TEST',
      hash: makeHash(eventId),
    };

    const res = await fetch(`${API_BASE}/api/webhooks/hanet`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    expect(res.status).toBe(200);
    const body: any = await res.json();
    expect(body.returnCode).toBe(1);

    // Đảm bảo không thay đổi bất kỳ bản ghi học sinh nào
    const studentCountAfter = await pool.query(`SELECT COUNT(*)::int AS cnt FROM students`);
    expect(studentCountAfter.rows[0].cnt).toBe(studentCountBefore.rows[0].cnt);

    // Event ghi nhận disposition ignored
    const eventRes = await pool.query(
      `SELECT * FROM webhook_events WHERE hanet_event_id = $1`,
      [eventId]
    );
    expect(eventRes.rows.length).toBe(1);
    const event = eventRes.rows[0];
    expect(event.disposition).toBe('ignored');
    expect(event.data_type).toBe('device');
    expect(event.device_id).toBe('TEST_DEV_001');
    expect(event.device_name).toBe('Camera Cổng TEST');
  });

  // Test 6: POST /api/webhooks/hanet - Place update -> HTTP 200, disposition ignored, KHÔNG đổi học sinh
  it('6. Place push: HTTP 200, ghi nhận disposition ignored, KHÔNG thay đổi học sinh nào', async () => {
    const studentCountBefore = await pool.query(`SELECT COUNT(*)::int AS cnt FROM students`);

    const eventId = `TEST_EVT_PLC_${Date.now()}`;
    const payload = {
      id: eventId,
      data_type: 'place',
      action_type: 'update',
      placeID: 'TEST_PLC_999',
      placeName: 'Địa Điểm TEST',
      hash: makeHash(eventId),
    };

    const res = await fetch(`${API_BASE}/api/webhooks/hanet`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    expect(res.status).toBe(200);
    const body: any = await res.json();
    expect(body.returnCode).toBe(1);

    // Đảm bảo không thay đổi bất kỳ bản ghi học sinh nào
    const studentCountAfter = await pool.query(`SELECT COUNT(*)::int AS cnt FROM students`);
    expect(studentCountAfter.rows[0].cnt).toBe(studentCountBefore.rows[0].cnt);

    // Event ghi nhận disposition ignored
    const eventRes = await pool.query(
      `SELECT * FROM webhook_events WHERE hanet_event_id = $1`,
      [eventId]
    );
    expect(eventRes.rows.length).toBe(1);
    const event = eventRes.rows[0];
    expect(event.disposition).toBe('ignored');
    expect(event.data_type).toBe('place');
    expect(event.place_id).toBe('TEST_PLC_999');
    expect(event.place_name).toBe('Địa Điểm TEST');
  });

  // Test 7: Vệ sinh dữ liệu - keycode bị xóa (đặt null) khi lưu
  it('7. Vệ sinh dữ liệu nhạy cảm: keycode trong payload phải đặt thành null khi lưu', async () => {
    const eventId = `TEST_EVT_KEYCODE_${Date.now()}`;
    const payload = {
      id: eventId,
      data_type: 'device',
      action_type: 'update',
      deviceID: 'TEST_DEV_SECURE',
      keycode: 'SUPER_SECRET_KEY_12345',
      hash: makeHash(eventId),
    };

    const res = await fetch(`${API_BASE}/api/webhooks/hanet`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    expect(res.status).toBe(200);

    const eventRes = await pool.query(
      `SELECT payload FROM webhook_events WHERE hanet_event_id = $1`,
      [eventId]
    );
    expect(eventRes.rows.length).toBe(1);
    const savedPayload = eventRes.rows[0].payload;
    expect(savedPayload.keycode).toBeNull();
  });

  // Test 8: GET /api/admin/webhook-events - Yêu cầu bảo mật adminAuth
  it('8. GET /api/admin/webhook-events: yêu cầu adminAuth (401 khi không có token)', async () => {
    const unauthRes = await fetch(`${API_BASE}/api/admin/webhook-events`);
    expect(unauthRes.status).toBe(401);

    const invalidAuthRes = await fetch(`${API_BASE}/api/admin/webhook-events`, {
      headers: { Authorization: 'Bearer sai_mat_ma_admin' },
    });
    expect(invalidAuthRes.status).toBe(401);
  });

  // Test 9: GET /api/admin/webhook-events - Phân trang và bộ lọc (data_type, action_type, disposition, q)
  it('9. GET /api/admin/webhook-events: trả về phân trang và áp dụng đúng các bộ lọc', async () => {
    const res = await fetch(`${API_BASE}/api/admin/webhook-events?page=1&limit=10`, {
      headers: { Authorization: `Bearer ${ADMIN_SECRET_TOKEN}` },
    });
    expect(res.status).toBe(200);
    const body: any = await res.json();
    expect(body.success).toBe(true);
    expect(body.data).toBeDefined();
    expect(Array.isArray(body.data.items)).toBe(true);
    expect(typeof body.data.total).toBe('number');

    // Lọc theo data_type=device
    const devRes = await fetch(`${API_BASE}/api/admin/webhook-events?data_type=device`, {
      headers: { Authorization: `Bearer ${ADMIN_SECRET_TOKEN}` },
    });
    const devBody: any = await devRes.json();
    expect(devBody.data.items.every((it: any) => it.data_type === 'device')).toBe(true);

    // Lọc theo disposition=deferred
    const defRes = await fetch(`${API_BASE}/api/admin/webhook-events?disposition=deferred`, {
      headers: { Authorization: `Bearer ${ADMIN_SECRET_TOKEN}` },
    });
    const defBody: any = await defRes.json();
    expect(defBody.data.items.every((it: any) => it.disposition === 'deferred')).toBe(true);

    // Tìm kiếm q qua device_id
    const qRes = await fetch(`${API_BASE}/api/admin/webhook-events?q=TEST_DEV_001`, {
      headers: { Authorization: `Bearer ${ADMIN_SECRET_TOKEN}` },
    });
    const qBody: any = await qRes.json();
    expect(qBody.data.items.length).toBeGreaterThanOrEqual(1);
    expect(qBody.data.items[0].device_id).toBe('TEST_DEV_001');
  });

  // Test 10: GET /api/admin/webhook-events/:id - Trả chi tiết event kèm payload, 404 khi không tồn tại
  it('10. GET /api/admin/webhook-events/:id: trả 200 kèm payload đầy đủ, trả 404 khi id không tồn tại', async () => {
    // Lấy 1 id có sẵn từ database
    const rowRes = await pool.query(
      `SELECT id FROM webhook_events WHERE hanet_event_id LIKE 'TEST_%' LIMIT 1`
    );
    expect(rowRes.rows.length).toBe(1);
    const targetId = rowRes.rows[0].id;

    // Thành công
    const detailRes = await fetch(`${API_BASE}/api/admin/webhook-events/${targetId}`, {
      headers: { Authorization: `Bearer ${ADMIN_SECRET_TOKEN}` },
    });
    expect(detailRes.status).toBe(200);
    const detailBody: any = await detailRes.json();
    expect(detailBody.success).toBe(true);
    expect(detailBody.data.id).toBe(targetId);
    expect(detailBody.data.payload).toBeDefined();

    // 404 Not Found
    const notFoundRes = await fetch(`${API_BASE}/api/admin/webhook-events/99999999`, {
      headers: { Authorization: `Bearer ${ADMIN_SECRET_TOKEN}` },
    });
    expect(notFoundRes.status).toBe(404);
    const notFoundBody: any = await notFoundRes.json();
    expect(notFoundBody.success).toBe(false);
  });
});
