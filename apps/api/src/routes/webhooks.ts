import { FastifyPluginAsync } from 'fastify';
import crypto from 'node:crypto';

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

export const webhookRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.post('/hanet', async (request, reply) => {
    const payload = request.body as any;
    const clientSecret = process.env.HANET_CLIENT_SECRET || '';

    // 1. Xác thực bảo mật chữ ký hash (nếu có cấu hình secret)
    if (clientSecret && !verifyWebhookHash(payload, clientSecret)) {
      request.log.warn({ payload }, '[Webhook] Chữ ký Hash không hợp lệ!');
      return reply.status(400).send({ returnCode: -1, message: 'INVALID_HASH' });
    }

    // 2. Xử lý sự kiện Face Data / Nhân sự (data_type = 'person')
    if (payload?.data_type === 'person') {
      const { action_type, personID, aliasID, personName } = payload;
      request.log.info(
        `[Webhook] Face Data event: ${action_type} - PersonID: ${personID} (${personName || aliasID})`
      );

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
        request.log.error({ err }, '[Webhook DB Error]');
      }
    }

    // Luôn phản hồi HTTP 200 OK ngay lập tức cho HANET Cloud
    return reply.status(200).send({ returnCode: 1, message: 'SUCCESS' });
  });
};
