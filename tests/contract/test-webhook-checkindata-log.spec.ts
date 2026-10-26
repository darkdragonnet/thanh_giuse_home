import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import Fastify, { FastifyInstance } from 'fastify';
import crypto from 'node:crypto';
import pg from 'pg';
import IORedis from 'ioredis';
import {
  StudentRepository,
  SettingsRepository,
  LogRepository,
  WebhookEventRepository,
  createDbPool,
  closeDbPool,
} from '@thanh-giuse/shared-infra';
import { webhookRoutes } from '../../apps/api/src/routes/webhooks.js';

/**
 * CONTRACT TESTS: HANET CheckinData (log) Webhook Push -> object_events
 *
 * Kiểm tra 10 ca kiểm thử bắt buộc:
 * 1. log personType = 0 -> 200, 1 dòng object_events, webhook_events disposition = 'applied'
 * 2. log personType = 1 -> tương tự (Khách hàng)
 * 3. log personType = 2 và = 4 -> 2 dòng, phân biệt đúng 2 vs 4 (Người lạ 2 subtype)
 * 4. log personType = 28 -> dòng Lửa đúng
 * 5. log personType = 6 -> dòng snapshot đúng
 * 6. Kill Switch đang ngắt -> 200, log WEBHOOK_DEFERRED, KHÔNG có dòng object_events mới, disposition = 'deferred'
 * 7. Chữ ký sai -> 400 INVALID_HASH, không có dòng object_events mới
 * 8. Log push không đổi students: COUNT(*) + toàn bộ status trước/sau giống hệt
 * 9. log thiếu/sai personType -> 200, không dòng object_events, disposition = 'ignored', không crash
 * 10. device push + place push -> hành vi cũ giữ nguyên: 200, disposition = 'ignored', không dòng object_events
 */

const rawDbUrl =
  process.env.DATABASE_URL ||
  'postgresql://postgres_user:super_secure_postgres_password_change_me@localhost:5432/thanh_giuse_db';
const DB_URL = rawDbUrl.replace('@app_postgres:', '@localhost:').replace('@postgres:', '@localhost:');

const REDIS_URL =
  process.env.REDIS_URL ||
  'redis://:super_secure_redis_password_change_me@localhost:6379/0';
const formattedRedisUrl = REDIS_URL.replace('@app_redis:', '@localhost:').replace('@redis:', '@localhost:');

const TEST_CLIENT_SECRET = 'TEST_MOCK_CLIENT_SECRET_987654321';

function makeHash(id: string, secret: string = TEST_CLIENT_SECRET): string {
  return crypto.createHash('md5').update(secret + id).digest('hex');
}

describe('Contract Test: CheckinData (log) -> object_events (/api/webhooks/hanet)', () => {
  let app: FastifyInstance;
  let pool: pg.Pool;
  let redis: IORedis;
  let studentRepo: StudentRepository;
  let settingsRepo: SettingsRepository;
  let logRepo: LogRepository;
  let webhookEventRepo: WebhookEventRepository;

  let testClassId: number;
  const testClassCode = `TEST_CLS_LOG_${Date.now().toString().slice(-4)}`;
  const createdStudentIds: number[] = [];
  const ORIGINAL_CLIENT_SECRET = process.env.HANET_CLIENT_SECRET;

  beforeAll(async () => {
    pool = createDbPool({ connectionString: DB_URL });
    redis = new IORedis(formattedRedisUrl, { maxRetriesPerRequest: null });

    studentRepo = new StudentRepository(pool);
    settingsRepo = new SettingsRepository(pool);
    logRepo = new LogRepository(pool);
    webhookEventRepo = new WebhookEventRepository(pool);

    app = Fastify({ logger: false });

    app.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body: string | Buffer, done) => {
      const text = typeof body === 'string' ? body : body.toString('utf8');
      if (!text || text.trim() === '') {
        done(null, {});
        return;
      }
      try {
        done(null, JSON.parse(text));
      } catch (err: any) {
        err.statusCode = 400;
        done(err, undefined);
      }
    });

    app.decorate('studentRepo', studentRepo);
    app.decorate('settingsRepo', settingsRepo);
    app.decorate('logRepo', logRepo);
    app.decorate('webhookEventRepo', webhookEventRepo);
    app.decorate('redis', redis);
    app.decorate('pg', pool);

    await app.register(webhookRoutes, { prefix: '/api/webhooks' });
    await app.ready();

    // Tạo lớp test
    const clsRes = await pool.query(
      `INSERT INTO classes (code, name, token, is_locked)
       VALUES ($1, $2, $3, false)
       RETURNING id`,
      [testClassCode, `Lớp Test Log ${testClassCode}`, `PIN_${testClassCode}`]
    );
    testClassId = clsRes.rows[0].id;

    // Đảm bảo Kill Switch ban đầu mở (enabled: true)
    await settingsRepo.setRegistrationEnabled(true);
    await redis.set('setting:kill_switch', 'false');
  });

  beforeEach(() => {
    process.env.HANET_CLIENT_SECRET = TEST_CLIENT_SECRET;
  });

  afterAll(async () => {
    if (ORIGINAL_CLIENT_SECRET !== undefined) {
      process.env.HANET_CLIENT_SECRET = ORIGINAL_CLIENT_SECRET;
    } else {
      delete process.env.HANET_CLIENT_SECRET;
    }

    try {
      await settingsRepo.setRegistrationEnabled(true);
      await redis.set('setting:kill_switch', 'false');
    } catch {
      // ignore
    }

    // Dọn sạch dữ liệu TEST_
    if (createdStudentIds.length > 0) {
      await pool.query('DELETE FROM students WHERE id = ANY($1::int[])', [createdStudentIds]);
    }
    if (testClassId) {
      await pool.query('DELETE FROM students WHERE class_id = $1', [testClassId]);
      await pool.query('DELETE FROM classes WHERE id = $1', [testClassId]);
    }

    await pool.query(
      `DELETE FROM object_events 
       WHERE hanet_event_id LIKE 'TEST_%'
          OR person_id LIKE 'TEST_%'
          OR alias_id LIKE 'TEST_%'
          OR device_id LIKE 'TEST_%'
          OR place_id LIKE 'TEST_%'`
    );

    await pool.query(
      `DELETE FROM webhook_events 
       WHERE hanet_event_id LIKE 'TEST_%' 
          OR person_id LIKE 'TEST_%' 
          OR device_id LIKE 'TEST_%' 
          OR place_id LIKE 'TEST_%' 
          OR alias_id LIKE 'TEST_%'`
    );

    await pool.query(
      `DELETE FROM logs 
       WHERE alias_id LIKE 'TEST_%' 
          OR result_message LIKE '%TEST_%'`
    );

    await app.close();
    await redis.quit();
    await closeDbPool(pool);
  });

  // ===========================================================================
  // 1. log personType = 0 -> 200, 1 dòng object_events đúng trường, disposition = applied
  // ===========================================================================
  it('1. log personType = 0: trả 200, lưu 1 dòng object_events đúng các trường, webhook_events disposition=applied', async () => {
    const eventId = `TEST_EVT_LOG_0_${Date.now()}`;
    const payload = {
      id: eventId,
      data_type: 'log',
      personType: 0,
      personID: 'TEST_PER_000',
      personName: 'Nhân viên A',
      aliasID: 'TEST_ALS_000',
      deviceID: 'TEST_DEV_000',
      deviceName: 'Camera Cổng 0',
      placeID: 'TEST_PLC_000',
      placeName: 'Khu A',
      mask: 0,
      detected_image_url: 'https://static.hanet.ai/test_img_0.jpg',
      time: 1729900000000,
      hash: makeHash(eventId),
    };

    const res = await app.inject({
      method: 'POST',
      url: '/api/webhooks/hanet',
      payload,
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ returnCode: 1, message: 'SUCCESS' });

    // Kiểm tra dòng object_events
    const objRes = await pool.query(
      `SELECT * FROM object_events WHERE hanet_event_id = $1`,
      [eventId]
    );
    expect(objRes.rows.length).toBe(1);
    const row = objRes.rows[0];
    expect(row.person_type).toBe(0);
    expect(row.person_id).toBe('TEST_PER_000');
    expect(row.person_name).toBe('Nhân viên A');
    expect(row.alias_id).toBe('TEST_ALS_000');
    expect(row.device_id).toBe('TEST_DEV_000');
    expect(row.device_name).toBe('Camera Cổng 0');
    expect(row.place_id).toBe('TEST_PLC_000');
    expect(row.place_name).toBe('Khu A');
    expect(row.mask).toBe(0);
    expect(row.detected_image_url).toBe('https://static.hanet.ai/test_img_0.jpg');
    expect(Number(row.event_time)).toBe(1729900000000);

    // Kiểm tra webhook_events
    const whRes = await pool.query(
      `SELECT * FROM webhook_events WHERE hanet_event_id = $1`,
      [eventId]
    );
    expect(whRes.rows.length).toBe(1);
    expect(whRes.rows[0].disposition).toBe('applied');
  });

  // ===========================================================================
  // 2. log personType = 1 -> tương tự (Khách hàng)
  // ===========================================================================
  it('2. log personType = 1: trả 200, lưu dòng object_events cho Khách hàng (person_type = 1)', async () => {
    const eventId = `TEST_EVT_LOG_1_${Date.now()}`;
    const payload = {
      id: eventId,
      data_type: 'log',
      personType: '1', // test chuỗi số '1'
      personID: 'TEST_PER_001',
      personName: 'Khách hàng B',
      aliasID: 'TEST_ALS_001',
      deviceID: 'TEST_DEV_001',
      deviceName: 'Camera Cổng 1',
      placeID: 'TEST_PLC_001',
      placeName: 'Khu B',
      mask: -1,
      detected_image_url: 'https://static.hanet.ai/test_img_1.jpg',
      time: 1729900001000,
      hash: makeHash(eventId),
    };

    const res = await app.inject({
      method: 'POST',
      url: '/api/webhooks/hanet',
      payload,
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ returnCode: 1, message: 'SUCCESS' });

    const objRes = await pool.query(
      `SELECT * FROM object_events WHERE hanet_event_id = $1`,
      [eventId]
    );
    expect(objRes.rows.length).toBe(1);
    expect(objRes.rows[0].person_type).toBe(1);
    expect(objRes.rows[0].mask).toBe(-1);

    const whRes = await pool.query(
      `SELECT * FROM webhook_events WHERE hanet_event_id = $1`,
      [eventId]
    );
    expect(whRes.rows.length).toBe(1);
    expect(whRes.rows[0].disposition).toBe('applied');
  });

  // ===========================================================================
  // 3. log personType = 2 và = 4 -> 2 dòng, person_type phân biệt đúng 2 vs 4
  // ===========================================================================
  it('3. log personType = 2 và = 4: 2 dòng, person_type phân biệt đúng 2 vs 4 (Người lạ 2 subtype)', async () => {
    const evt2 = `TEST_EVT_LOG_2_${Date.now()}`;
    const payload2 = {
      id: evt2,
      data_type: 'log',
      personType: 2, // Người lạ thấy mặt
      personID: 'TEST_PER_STRANGER_FACE',
      deviceID: 'TEST_DEV_STRANGER',
      hash: makeHash(evt2),
    };

    const evt4 = `TEST_EVT_LOG_4_${Date.now()}`;
    const payload4 = {
      id: evt4,
      data_type: 'log',
      personType: 4, // Người lạ chỉ thấy thân
      personID: 'TEST_PER_STRANGER_BODY',
      deviceID: 'TEST_DEV_STRANGER',
      hash: makeHash(evt4),
    };

    const res2 = await app.inject({
      method: 'POST',
      url: '/api/webhooks/hanet',
      payload: payload2,
    });
    const res4 = await app.inject({
      method: 'POST',
      url: '/api/webhooks/hanet',
      payload: payload4,
    });

    expect(res2.statusCode).toBe(200);
    expect(res4.statusCode).toBe(200);

    const objRes = await pool.query(
      `SELECT hanet_event_id, person_type FROM object_events WHERE hanet_event_id IN ($1, $2) ORDER BY person_type ASC`,
      [evt2, evt4]
    );
    expect(objRes.rows.length).toBe(2);
    expect(objRes.rows[0].person_type).toBe(2);
    expect(objRes.rows[0].hanet_event_id).toBe(evt2);
    expect(objRes.rows[1].person_type).toBe(4);
    expect(objRes.rows[1].hanet_event_id).toBe(evt4);
  });

  // ===========================================================================
  // 4. log personType = 28 -> dòng Lửa đúng
  // ===========================================================================
  it('4. log personType = 28: trả 200, ghi dòng Lửa đúng (person_type = 28)', async () => {
    const eventId = `TEST_EVT_LOG_FIRE_${Date.now()}`;
    const payload = {
      id: eventId,
      data_type: 'log',
      personType: 28,
      deviceID: 'TEST_DEV_FIRE',
      deviceName: 'Camera Báo Cháy',
      hash: makeHash(eventId),
    };

    const res = await app.inject({
      method: 'POST',
      url: '/api/webhooks/hanet',
      payload,
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ returnCode: 1, message: 'SUCCESS' });

    const objRes = await pool.query(
      `SELECT * FROM object_events WHERE hanet_event_id = $1`,
      [eventId]
    );
    expect(objRes.rows.length).toBe(1);
    expect(objRes.rows[0].person_type).toBe(28);
    expect(objRes.rows[0].device_name).toBe('Camera Báo Cháy');

    const whRes = await pool.query(
      `SELECT * FROM webhook_events WHERE hanet_event_id = $1`,
      [eventId]
    );
    expect(whRes.rows.length).toBe(1);
    expect(whRes.rows[0].disposition).toBe('applied');
  });

  // ===========================================================================
  // 5. log personType = 6 -> dòng snapshot camera đúng
  // ===========================================================================
  it('5. log personType = 6: trả 200, ghi dòng snapshot camera đúng (person_type = 6)', async () => {
    const eventId = `TEST_EVT_LOG_SNAP_${Date.now()}`;
    const payload = {
      id: eventId,
      data_type: 'log',
      personType: 6,
      deviceID: 'TEST_DEV_SNAP',
      deviceName: 'Camera Snapshot',
      detected_image_url: 'https://static.hanet.ai/snapshot_test.jpg',
      hash: makeHash(eventId),
    };

    const res = await app.inject({
      method: 'POST',
      url: '/api/webhooks/hanet',
      payload,
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ returnCode: 1, message: 'SUCCESS' });

    const objRes = await pool.query(
      `SELECT * FROM object_events WHERE hanet_event_id = $1`,
      [eventId]
    );
    expect(objRes.rows.length).toBe(1);
    expect(objRes.rows[0].person_type).toBe(6);
    expect(objRes.rows[0].detected_image_url).toBe('https://static.hanet.ai/snapshot_test.jpg');

    const whRes = await pool.query(
      `SELECT * FROM webhook_events WHERE hanet_event_id = $1`,
      [eventId]
    );
    expect(whRes.rows.length).toBe(1);
    expect(whRes.rows[0].disposition).toBe('applied');
  });

  // ===========================================================================
  // 6. Kill Switch đang ngắt -> 200, log WEBHOOK_DEFERRED, KHÔNG có dòng object_events mới, disposition = deferred
  // ===========================================================================
  it('6. Kill Switch đang ngắt: 200 SUCCESS, log WEBHOOK_DEFERRED, KHÔNG có dòng object_events, disposition = deferred', async () => {
    await settingsRepo.setRegistrationEnabled(false);
    await redis.set('setting:kill_switch', 'true');

    const eventId = `TEST_EVT_LOG_KS_${Date.now()}`;
    const payload = {
      id: eventId,
      data_type: 'log',
      personType: 0,
      personID: 'TEST_PER_KS',
      hash: makeHash(eventId),
    };

    const res = await app.inject({
      method: 'POST',
      url: '/api/webhooks/hanet',
      payload,
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ returnCode: 1, message: 'SUCCESS' });

    // Không có dòng object_events nào được tạo
    const objRes = await pool.query(
      `SELECT * FROM object_events WHERE hanet_event_id = $1`,
      [eventId]
    );
    expect(objRes.rows.length).toBe(0);

    // webhook_events ghi disposition = deferred
    const whRes = await pool.query(
      `SELECT * FROM webhook_events WHERE hanet_event_id = $1`,
      [eventId]
    );
    expect(whRes.rows.length).toBe(1);
    expect(whRes.rows[0].disposition).toBe('deferred');
    expect(whRes.rows[0].kill_switch_active).toBe(true);

    // Bảng logs ghi WEBHOOK_DEFERRED
    const logEntries = await pool.query(
      `SELECT * FROM logs WHERE action = 'WEBHOOK_DEFERRED' ORDER BY id DESC LIMIT 1`
    );
    expect(logEntries.rows.length).toBe(1);

    // Mở lại Kill Switch cho các test sau
    await settingsRepo.setRegistrationEnabled(true);
    await redis.set('setting:kill_switch', 'false');
  });

  // ===========================================================================
  // 7. Chữ ký sai -> 400 INVALID_HASH, không có dòng object_events mới
  // ===========================================================================
  it('7. Chữ ký sai: trả 400 INVALID_HASH, không tạo dòng object_events mới', async () => {
    const eventId = `TEST_EVT_LOG_BAD_HASH_${Date.now()}`;
    const payload = {
      id: eventId,
      data_type: 'log',
      personType: 0,
      personID: 'TEST_PER_BAD_HASH',
      hash: 'completely_wrong_hash_123',
    };

    const res = await app.inject({
      method: 'POST',
      url: '/api/webhooks/hanet',
      payload,
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ returnCode: -1, message: 'INVALID_HASH' });

    // Không tạo dòng trong object_events
    const objRes = await pool.query(
      `SELECT * FROM object_events WHERE hanet_event_id = $1`,
      [eventId]
    );
    expect(objRes.rows.length).toBe(0);

    // webhook_events ghi disposition = invalid_hash
    const whRes = await pool.query(
      `SELECT * FROM webhook_events WHERE hanet_event_id = $1`,
      [eventId]
    );
    expect(whRes.rows.length).toBe(1);
    expect(whRes.rows[0].disposition).toBe('invalid_hash');
    expect(whRes.rows[0].hash_valid).toBe(false);
  });

  // ===========================================================================
  // 8. Log push không đổi students: COUNT(*) + toàn bộ status trước/sau giống hệt
  // ===========================================================================
  it('8. Bất biến sinh viên: Log push không được tạo/sửa/xóa bất kỳ dòng students nào', async () => {
    // Tạo 1 học sinh mẫu
    const aliasId = `TEST_ALS_INV_${Date.now().toString().slice(-4)}`;
    const initialPersonId = `TEST_PID_ORIG_${Date.now().toString().slice(-4)}`;
    const stuRes = await pool.query(
      `INSERT INTO students (class_id, name, qr_token, alias_id, person_id, status)
       VALUES ($1, $2, $3, $4, $5, 'empty')
       RETURNING id`,
      [testClassId, 'Học Sinh Bất Biến Test', `QR_${aliasId}`, aliasId, initialPersonId]
    );
    const studentId = stuRes.rows[0].id;
    createdStudentIds.push(studentId);

    // Chụp lại toàn bộ trạng thái và tổng số students
    const beforeCountRes = await pool.query(`SELECT COUNT(*) FROM students`);
    const beforeCount = Number(beforeCountRes.rows[0].count);

    const beforeStudentRes = await pool.query(
      `SELECT id, name, alias_id, person_id, status FROM students WHERE id = $1`,
      [studentId]
    );
    const beforeStudent = beforeStudentRes.rows[0];

    // Gửi push log có thông tin aliasID và personID trùng, nhưng personID khác
    const eventId = `TEST_EVT_LOG_INVAR_${Date.now()}`;
    const payload = {
      id: eventId,
      data_type: 'log',
      personType: 0,
      personID: 'TEST_PID_ATTEMPTED_OVERWRITE',
      personName: 'Attempted Name Change',
      aliasID: aliasId,
      deviceID: 'TEST_DEV_INV',
      hash: makeHash(eventId),
    };

    const res = await app.inject({
      method: 'POST',
      url: '/api/webhooks/hanet',
      payload,
    });

    expect(res.statusCode).toBe(200);

    // Kiểm tra sau push log
    const afterCountRes = await pool.query(`SELECT COUNT(*) FROM students`);
    const afterCount = Number(afterCountRes.rows[0].count);
    expect(afterCount).toBe(beforeCount); // COUNT(*) tuyệt đối không đổi!

    const afterStudentRes = await pool.query(
      `SELECT id, name, alias_id, person_id, status FROM students WHERE id = $1`,
      [studentId]
    );
    const afterStudent = afterStudentRes.rows[0];

    // Học sinh giữ nguyên trạng thái 'empty' và person_id ban đầu
    expect(afterStudent.status).toBe(beforeStudent.status);
    expect(afterStudent.status).toBe('empty');
    expect(afterStudent.person_id).toBe(initialPersonId);
    expect(afterStudent.name).toBe(beforeStudent.name);
  });

  // ===========================================================================
  // 9. log thiếu/sai personType -> 200, không dòng object_events, webhook_events disposition=ignored, không crash
  // ===========================================================================
  it('9. log thiếu hoặc sai personType: trả 200, không ghi object_events, webhook_events disposition=ignored', async () => {
    // 9a. Thiếu personType
    const evtMissing = `TEST_EVT_LOG_NO_TYPE_${Date.now()}`;
    const payloadMissing = {
      id: evtMissing,
      data_type: 'log',
      personID: 'TEST_PER_NO_TYPE',
      hash: makeHash(evtMissing),
    };

    const resMissing = await app.inject({
      method: 'POST',
      url: '/api/webhooks/hanet',
      payload: payloadMissing,
    });

    expect(resMissing.statusCode).toBe(200);
    expect(resMissing.json()).toEqual({ returnCode: 1, message: 'SUCCESS' });

    const objResMissing = await pool.query(
      `SELECT * FROM object_events WHERE hanet_event_id = $1`,
      [evtMissing]
    );
    expect(objResMissing.rows.length).toBe(0);

    const whResMissing = await pool.query(
      `SELECT * FROM webhook_events WHERE hanet_event_id = $1`,
      [evtMissing]
    );
    expect(whResMissing.rows.length).toBe(1);
    expect(whResMissing.rows[0].disposition).toBe('ignored');

    // 9b. personType không hợp lệ (ví dụ: 99 hoặc 'invalid')
    const evtInvalid = `TEST_EVT_LOG_BAD_TYPE_${Date.now()}`;
    const payloadInvalid = {
      id: evtInvalid,
      data_type: 'log',
      personType: 99,
      hash: makeHash(evtInvalid),
    };

    const resInvalid = await app.inject({
      method: 'POST',
      url: '/api/webhooks/hanet',
      payload: payloadInvalid,
    });

    expect(resInvalid.statusCode).toBe(200);

    const objResInvalid = await pool.query(
      `SELECT * FROM object_events WHERE hanet_event_id = $1`,
      [evtInvalid]
    );
    expect(objResInvalid.rows.length).toBe(0);

    const whResInvalid = await pool.query(
      `SELECT * FROM webhook_events WHERE hanet_event_id = $1`,
      [evtInvalid]
    );
    expect(whResInvalid.rows.length).toBe(1);
    expect(whResInvalid.rows[0].disposition).toBe('ignored');
  });

  // ===========================================================================
  // 10. device push + place push -> hành vi cũ giữ nguyên: 200, disposition=ignored, không dòng object_events
  // ===========================================================================
  it('10. device push + place push: hành vi cũ giữ nguyên 200 SUCCESS, webhook_events disposition=ignored, không ghi object_events', async () => {
    const evtDev = `TEST_EVT_DEV_${Date.now()}`;
    const payloadDev = {
      id: evtDev,
      data_type: 'device',
      action_type: 'update',
      deviceID: 'TEST_DEV_REGRESS',
      deviceName: 'Device Camera Regress',
      hash: makeHash(evtDev),
    };

    const evtPlc = `TEST_EVT_PLC_${Date.now()}`;
    const payloadPlc = {
      id: evtPlc,
      data_type: 'place',
      action_type: 'update',
      placeID: 'TEST_PLC_REGRESS',
      placeName: 'Place Regress',
      hash: makeHash(evtPlc),
    };

    const resDev = await app.inject({
      method: 'POST',
      url: '/api/webhooks/hanet',
      payload: payloadDev,
    });
    const resPlc = await app.inject({
      method: 'POST',
      url: '/api/webhooks/hanet',
      payload: payloadPlc,
    });

    expect(resDev.statusCode).toBe(200);
    expect(resPlc.statusCode).toBe(200);

    // Không ghi dòng nào vào object_events
    const objRes = await pool.query(
      `SELECT * FROM object_events WHERE hanet_event_id IN ($1, $2)`,
      [evtDev, evtPlc]
    );
    expect(objRes.rows.length).toBe(0);

    // webhook_events ghi disposition = ignored
    const whRes = await pool.query(
      `SELECT hanet_event_id, disposition FROM webhook_events WHERE hanet_event_id IN ($1, $2) ORDER BY hanet_event_id ASC`,
      [evtDev, evtPlc]
    );
    expect(whRes.rows.length).toBe(2);
    expect(whRes.rows[0].disposition).toBe('ignored');
    expect(whRes.rows[1].disposition).toBe('ignored');
  });
});
