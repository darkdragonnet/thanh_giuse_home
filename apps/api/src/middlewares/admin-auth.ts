import { FastifyRequest, FastifyReply } from 'fastify';

export async function adminAuth(request: FastifyRequest, reply: FastifyReply) {
  const secretToken = process.env.ADMIN_SECRET_TOKEN || process.env.JWT_SECRET || 'admin_secret_super_secure_token';
  if (!secretToken) {
    request.log.error('ADMIN_SECRET_TOKEN chưa được thiết lập trong biến môi trường!');
    return reply.status(500).send({ message: 'Lỗi cấu hình hệ thống máy chủ' });
  }

  let clientToken: string | undefined;

  // 1. Kiểm tra Bearer Token trong Header
  const authHeader = request.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    clientToken = authHeader.substring(7).trim();
  }

  // 2. Kiểm tra Cookie nếu Header không có
  if (!clientToken && request.headers.cookie) {
    const cookies = request.headers.cookie.split(';');
    for (const cookie of cookies) {
      const [name, val] = cookie.trim().split('=');
      if (name === 'admin_token') {
        clientToken = decodeURIComponent(val);
        break;
      }
    }
  }

  // 3. So khớp token
  if (!clientToken || clientToken !== secretToken) {
    return reply.status(401).send({
      statusCode: 401,
      error: 'Unauthorized',
      message: 'Token xác thực quản trị không hợp lệ hoặc đã hết hạn.'
    });
  }
}
