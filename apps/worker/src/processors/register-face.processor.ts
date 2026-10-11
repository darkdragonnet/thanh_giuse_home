import { Job } from 'bullmq';
import { pool } from '../shared/db.js';
import { disableSystemRegistration } from '../services/system-lock.service.js';

export interface RegisterFaceJobData {
  registrationId?: string;
  aliasId: string;
  name: string;
  faceImageUrl: string;
  mockScenario?: string;
}

export interface RegisterFaceResult {
  success: boolean;
  personId?: string;
  faceUrl?: string;
}

/**
 * Xử lý job đăng ký khuôn mặt học sinh lên HANET Cloud
 * Tuân thủ Hiến pháp Dự án:
 * - Case 0: Thành công -> cập nhật person_id và status = 'synced'
 * - Case -9008 (Hết Quota): Ngắt hàng đợi BullMQ, bật cờ khóa link đăng ký
 * - Case -9005 (Xung đột): Khác alias_id -> đưa vào DB status = 'conflict_pending_review'
 * - Case -103 (Hết hạn Token): Báo động phiên hết hạn
 */
export async function handleFaceRegistration(
  job: Job<RegisterFaceJobData>
): Promise<RegisterFaceResult> {
  const { aliasId, name, faceImageUrl, mockScenario } = job.data;
  const hanetBaseUrl = process.env.HANET_API_BASE_URL || 'http://localhost:9999';

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (mockScenario) {
    headers['x-mock-scenario'] = mockScenario;
  }

  let response: Response;
  try {
    response = await fetch(`${hanetBaseUrl}/person/register`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        name,
        alias: aliasId,
        file_url: faceImageUrl,
      }),
    });
  } catch (netErr: any) {
    throw new Error(`Không thể kết nối đến máy chủ HANET API: ${netErr.message}`);
  }

  const json = (await response.json()) as {
    returnCode: number;
    message?: string;
    data?: any;
  };

  // ═══════════════════════════════════════════════════════════════════════════
  // 1. CASE 0: ĐĂNG KÝ THÀNH CÔNG
  // ═══════════════════════════════════════════════════════════════════════════
  if (json.returnCode === 0) {
    const personId = json.data?.person_id || json.data?.personId || `HANET_P_${aliasId}`;
    const faceUrl = json.data?.face_url || json.data?.file || faceImageUrl;

    await pool.query(
      `INSERT INTO students (alias_id, name, status, person_id, face_url)
       VALUES ($1, $2, 'synced', $3, $4)
       ON CONFLICT (alias_id) DO UPDATE
       SET status = 'synced', person_id = $3, face_url = $4, updated_at = NOW()`,
      [aliasId, name, personId, faceUrl]
    );

    return {
      success: true,
      personId,
      faceUrl,
    };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // 2. CASE -9008: HẾT HẠN MỨC FACE ID (QUOTA EXCEEDED)
  // ═══════════════════════════════════════════════════════════════════════════
  if (json.returnCode === -9008 || mockScenario === 'EXCEED_QUOTA') {
    await disableSystemRegistration('Quota face exceeded');
    throw new Error('Quota face exceeded on HANET Place (-9008)');
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // 3. CASE -9005: XUNG ĐỘT KHUÔN MẶT VỚI NGƯỜI KHÁC
  // ═══════════════════════════════════════════════════════════════════════════
  if (json.returnCode === -9005 || mockScenario === 'CONFLICT_DIFFERENT_PERSON') {
    await pool.query(
      `INSERT INTO students (alias_id, name, status)
       VALUES ($1, $2, 'conflict_pending_review')
       ON CONFLICT (alias_id) DO UPDATE
       SET status = 'conflict_pending_review', updated_at = NOW()`,
      [aliasId, name]
    );

    throw new Error(`Xung đột khuôn mặt: Khuôn mặt đã đăng ký với alias khác (-9005)`);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // 4. CASE -103: ACCESS TOKEN HẾT HẠN
  // ═══════════════════════════════════════════════════════════════════════════
  if (json.returnCode === -103 || mockScenario === 'EXPIRED_TOKEN') {
    throw new Error('AccessToken has expired (-103)');
  }

  // Các lỗi khác
  throw new Error(`HANET API Error (${json.returnCode}): ${json.message || 'Lỗi không xác định'}`);
}
