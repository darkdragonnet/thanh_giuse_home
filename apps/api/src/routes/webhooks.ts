import { FastifyPluginAsync, FastifyRequest } from 'fastify';
import crypto from 'node:crypto';
import type { Redis } from 'ioredis';
import type { Pool } from 'pg';
import type { SettingsRepository, LogRepository, WebhookEventRepository } from '@thanh-giuse/shared-infra';

declare module 'fastify' {
  interface FastifyInstance {
    settingsRepo: SettingsRepository;
    logRepo: LogRepository;
    webhookEventRepo: WebhookEventRepository;
    redis: Redis;
    pg: Pool;
  }
}

/**
 * Kiểm tra tính hợp lệ của Webhook bằng chuỗi Hash MD5
 * Format: MD5(clientSecret + payload.id)
 */
function verifyWebhookHash(payload: any, clientSecret: string): boolean {
  if (!payload?.hash || !payload?.id) return false;
  const expectedHash = crypto
    .createHash('md5')
    .update(clientSecret + payload.id)
    .digest('hex');
  return payload.hash === expectedHash;
}

/**
 * Helper ghi nhận sự kiện webhook vào bảng webhook_events an toàn tuyệt đối.
 * Luôn bắt try/catch để không làm ảnh hưởng đến response trả về cho HANET.
 * Tự động xóa trường keycode (đặt null) để bảo mật dữ liệu.
 */
async function recordWebhookEventSafe(
  fastify: any,
  request: FastifyRequest,
  params: {
    payload: any;
    disposition: 'applied' | 'deferred' | 'invalid_hash' | 'ignored' | 'failed';
    hashValid: boolean;
    killSwitchActive: boolean;
    errorMessage?: string | null | undefined;
    studentId?: number | null | undefined;
    classId?: number | null | undefined;
  }
): Promise<void> {
  try {
    const p = params.payload || {};
    let studentId = params.studentId;
    let classId = params.classId;

    if (studentId === undefined && (p.aliasID || p.personID || p.alias_id || p.person_id)) {
      try {
        const studentRes = await fastify.pg.query(
          'SELECT id, class_id FROM students WHERE alias_id = $1 OR person_id = $2 LIMIT 1',
          [p.aliasID || p.alias_id || null, p.personID || p.person_id || null]
        );
        if (studentRes.rows.length > 0) {
          studentId = studentRes.rows[0].id;
          classId = studentRes.rows[0].class_id;
        }
      } catch {
        // bỏ qua lỗi tra cứu thông tin học sinh
      }
    }

    if (fastify.webhookEventRepo) {
      await fastify.webhookEventRepo.recordEvent({
        hanet_event_id: p.id ? String(p.id) : null,
        data_type: p.data_type ? String(p.data_type) : null,
        action_type: p.action_type ? String(p.action_type) : null,
        person_id: p.personID ? String(p.personID) : (p.person_id ? String(p.person_id) : null),
        device_id: p.deviceID ? String(p.deviceID) : (p.device_id ? String(p.device_id) : null),
        place_id: p.placeID ? String(p.placeID) : (p.place_id ? String(p.place_id) : null),
        place_name: p.placeName ? String(p.placeName) : (p.place_name ? String(p.place_name) : null),
        person_name: p.personName ? String(p.personName) : (p.person_name ? String(p.person_name) : null),
        device_name: p.deviceName ? String(p.deviceName) : (p.device_name ? String(p.device_name) : null),
        alias_id: p.aliasID ? String(p.aliasID) : (p.alias_id ? String(p.alias_id) : null),
        student_id: studentId ?? null,
        class_id: classId ?? null,
        hash_valid: params.hashValid,
        disposition: params.disposition,
        kill_switch_active: params.killSwitchActive,
        error_message: params.errorMessage || null,
        payload: p,
      });
    } else {
      let sanitizedPayload: any = null;
      if (p && typeof p === 'object') {
        sanitizedPayload = { ...p };
        if ('keycode' in sanitizedPayload) {
          sanitizedPayload.keycode = null;
        }
      } else if (p !== undefined) {
        sanitizedPayload = p;
      }

      await fastify.pg.query(
        `INSERT INTO webhook_events (
          hanet_event_id, data_type, action_type, person_id, device_id,
          place_id, place_name, person_name, device_name, alias_id,
          student_id, class_id, hash_valid, disposition, kill_switch_active,
          error_message, payload, received_at
        ) VALUES (
          $1, $2, $3, $4, $5,
          $6, $7, $8, $9, $10,
          $11, $12, $13, $14, $15,
          $16, $17, NOW()
        )`,
        [
          p.id ? String(p.id) : null,
          p.data_type ? String(p.data_type) : null,
          p.action_type ? String(p.action_type) : null,
          p.personID ? String(p.personID) : (p.person_id ? String(p.person_id) : null),
          p.deviceID ? String(p.deviceID) : (p.device_id ? String(p.device_id) : null),
          p.placeID ? String(p.placeID) : (p.place_id ? String(p.place_id) : null),
          p.placeName ? String(p.placeName) : (p.place_name ? String(p.place_name) : null),
          p.personName ? String(p.personName) : (p.person_name ? String(p.person_name) : null),
          p.deviceName ? String(p.deviceName) : (p.device_name ? String(p.device_name) : null),
          p.aliasID ? String(p.aliasID) : (p.alias_id ? String(p.alias_id) : null),
          studentId ?? null,
          classId ?? null,
          params.hashValid,
          params.disposition,
          params.killSwitchActive,
          params.errorMessage || null,
          sanitizedPayload !== null ? JSON.stringify(sanitizedPayload) : null,
        ]
      );
    }
  } catch (err: any) {
    request.log.warn({ err }, '[Webhook] Ghi webhook_events thất bại');
  }
}

export const webhookRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.post('/hanet', async (request, reply) => {
    const payload = request.body as any;
    const clientSecret = process.env.HANET_CLIENT_SECRET || '';

    // 1. Xác thực bảo mật chữ ký hash (nếu có cấu hình secret)
    if (clientSecret && !verifyWebhookHash(payload, clientSecret)) {
      request.log.warn({ payload }, '[Webhook] Chữ ký Hash không hợp lệ!');
      await recordWebhookEventSafe(fastify, request, {
        payload,
        disposition: 'invalid_hash',
        hashValid: false,
        killSwitchActive: false,
      });
      return reply.status(400).send({ returnCode: -1, message: 'INVALID_HASH' });
    }

    // 2. Kiểm tra Kill Switch (nếu Kill Switch đang ngắt -> hoãn xử lý, ghi WEBHOOK_DEFERRED, trả 200 SUCCESS)
    const isRegistrationEnabled = await fastify.settingsRepo.isRegistrationEnabled();
    const killSwitchRedis = await fastify.redis.get('setting:kill_switch');
    const isKillSwitchActive = !isRegistrationEnabled || killSwitchRedis === 'true';

    if (isKillSwitchActive) {
      const payloadSummary = JSON.stringify({
        data_type: payload?.data_type,
        action_type: payload?.action_type,
        personID: payload?.personID,
        aliasID: payload?.aliasID,
        personName: payload?.personName,
      });

      let studentId: number | undefined;
      let classId: number | undefined;
      if (payload?.aliasID || payload?.personID) {
        const studentRes = await fastify.pg.query(
          'SELECT id, class_id FROM students WHERE alias_id = $1 OR person_id = $2 LIMIT 1',
          [payload?.aliasID || null, payload?.personID || null]
        );
        if (studentRes.rows.length > 0) {
          studentId = studentRes.rows[0].id;
          classId = studentRes.rows[0].class_id;
        }
      }

      const ip = request.ip || (request.headers['x-forwarded-for'] as string) || null;
      await fastify.logRepo.recordLog({
        student_id: studentId,
        class_id: classId,
        alias_id: payload?.aliasID || null,
        action: 'WEBHOOK_DEFERRED',
        result_code: '1',
        result_message: `Webhook deferred do Kill Switch đang ngắt bảo trì. Payload: ${payloadSummary}`,
        ip,
      });

      await recordWebhookEventSafe(fastify, request, {
        payload,
        disposition: 'deferred',
        hashValid: true,
        killSwitchActive: true,
        studentId,
        classId,
      });

      request.log.info({ payload }, '[Webhook] Kill Switch active - Webhook deferred');
      return reply.status(200).send({ returnCode: 1, message: 'SUCCESS' });
    }

    // 3. Xử lý sự kiện Face Data / Nhân sự (data_type = 'person')
    if (payload?.data_type === 'person') {
      const { action_type, personID, aliasID, personName } = payload;
      request.log.info(
        `[Webhook] Face Data event: ${action_type} - PersonID: ${personID} (${personName || aliasID})`
      );

      let personError: string | null = null;
      try {
        if (action_type === 'add' || action_type === 'update') {
          // Cập nhật trạng thái học sinh trong database nếu khớp alias_id hoặc person_id
          if (aliasID) {
            await fastify.pg.query(
              `UPDATE students
               SET person_id = $1, status = 'success', updated_at = NOW()
               WHERE alias_id = $2`,
              [personID, aliasID]
            );
          }
        } else if (action_type === 'delete') {
          // Nếu bị xóa trên Cloud, đánh dấu học sinh cần kiểm tra thủ công
          if (personID) {
            await fastify.pg.query(
              `UPDATE students
               SET status = 'manual_review',
                   last_error_code = 'CLOUD_DELETED',
                   last_error_message = 'Khuôn mặt đã bị xóa trên máy chủ HANET Cloud',
                   updated_at = NOW()
               WHERE person_id = $1`,
              [personID]
            );
          }
        }
      } catch (err: any) {
        personError = err?.message || String(err);
        request.log.error({ err }, '[Webhook DB Error]');
      }

      if (personError) {
        await recordWebhookEventSafe(fastify, request, {
          payload,
          disposition: 'failed',
          hashValid: true,
          killSwitchActive: false,
          errorMessage: personError,
        });
      } else {
        await recordWebhookEventSafe(fastify, request, {
          payload,
          disposition: 'applied',
          hashValid: true,
          killSwitchActive: false,
        });
      }

      return reply.status(200).send({ returnCode: 1, message: 'SUCCESS' });
    }

    // 4. Các sự kiện khác (device, place, ...)
    await recordWebhookEventSafe(fastify, request, {
      payload,
      disposition: 'ignored',
      hashValid: true,
      killSwitchActive: false,
    });

    // Luôn phản hồi HTTP 200 OK ngay lập tức cho HANET Cloud
    return reply.status(200).send({ returnCode: 1, message: 'SUCCESS' });
  });
};
