import { FastifyRequest } from 'fastify';
import { mockState } from './state.js';

export interface HanetMockResponse {
  statusCode?: number | undefined;
  payload: {
    returnCode: number;
    returnMessage: string;
    data: unknown;
  };
  delayMs?: number | undefined;
}

export const STANDARD_SCENARIOS: Record<string, HanetMockResponse> = {
  // Thành công mặc định
  success: {
    payload: { returnCode: 1, returnMessage: 'SUCCESS', data: {} }
  },
  // Lỗi hệ thống quá tải (BullMQ retry sau 300s)
  '-503': {
    payload: { returnCode: -503, returnMessage: 'SYSTEM_ERROR', data: null }
  },
  system_error: {
    payload: { returnCode: -503, returnMessage: 'SYSTEM_ERROR', data: null }
  },
  // Token hết hạn
  '-103': {
    payload: { returnCode: -103, returnMessage: 'ACCESS_TOKEN_EXPIRE', data: null }
  },
  token_expired: {
    payload: { returnCode: -103, returnMessage: 'ACCESS_TOKEN_EXPIRE', data: null }
  },
  // Ảnh không đạt chuẩn (không nhận diện mặt, đeo kính râm)
  '-9006': {
    payload: { returnCode: -9006, returnMessage: 'EMPLOYEE_REGISTER_IMG_INVALID_ERROR', data: null }
  },
  invalid_image: {
    payload: { returnCode: -9006, returnMessage: 'EMPLOYEE_REGISTER_IMG_INVALID_ERROR', data: null }
  },
  // Khuôn mặt trùng lặp
  '-9007': {
    payload: { returnCode: -9007, returnMessage: 'EMPLOYEE_REGISTER_IMG_DUPLICATE_ERROR', data: null }
  },
  duplicate_face: {
    payload: { returnCode: -9007, returnMessage: 'EMPLOYEE_REGISTER_IMG_DUPLICATE_ERROR', data: null }
  },
  // Hết hạn mức lưu trữ Face ID
  '-9008': {
    payload: { returnCode: -9008, returnMessage: 'TOTAL_FACE_ID_NOT_ENOUGH_ERROR', data: null }
  },
  quota_exceeded: {
    payload: { returnCode: -9008, returnMessage: 'TOTAL_FACE_ID_NOT_ENOUGH_ERROR', data: null }
  },
  // Không tìm thấy nhân sự
  '-5011': {
    payload: { returnCode: -5011, returnMessage: 'PERSON_NOT_FOUND_ERROR', data: null }
  },
  person_not_found: {
    payload: { returnCode: -5011, returnMessage: 'PERSON_NOT_FOUND_ERROR', data: null }
  },
  // Dữ liệu đầu vào không hợp lệ
  '-1': {
    payload: { returnCode: -1, returnMessage: 'INVALID_INPUT_ERROR', data: null }
  },
  // Giả lập mạng chậm (5 giây)
  slow: {
    payload: { returnCode: 1, returnMessage: 'SUCCESS', data: { note: 'simulated_slow_network' } },
    delayMs: 5000
  },
  // Giả lập timeout sát ngưỡng 120s của worker
  timeout: {
    payload: { returnCode: -503, returnMessage: 'GATEWAY_TIMEOUT', data: null },
    delayMs: 125000
  }
};

export function resolveScenario(request: FastifyRequest): { scenario: string; config: HanetMockResponse } {
  // 1. Kiểm tra Header
  const headerScenario = request.headers['x-mock-scenario'] as string | undefined;
  if (headerScenario) {
    return {
      scenario: headerScenario,
      config: STANDARD_SCENARIOS[headerScenario] || {
        payload: { returnCode: -1, returnMessage: `UNKNOWN_SCENARIO_${headerScenario}`, data: null }
      }
    };
  }

  // 2. Kiểm tra Query String
  const query = request.query as Record<string, string> | undefined;
  if (query?.mock_scenario) {
    const s = query.mock_scenario;
    return {
      scenario: s,
      config: STANDARD_SCENARIOS[s] || {
        payload: { returnCode: -1, returnMessage: `UNKNOWN_SCENARIO_${s}`, data: null }
      }
    };
  }

  // 3. Kiểm tra Body (nếu request là JSON hoặc Form Body)
  const body = request.body as Record<string, string> | undefined;
  if (body?.mock_scenario) {
    const s = body.mock_scenario;
    return {
      scenario: s,
      config: STANDARD_SCENARIOS[s] || {
        payload: { returnCode: -1, returnMessage: `UNKNOWN_SCENARIO_${s}`, data: null }
      }
    };
  }

  // 4. Kiểm tra Global Override
  const global = mockState.getActiveGlobalScenario();
  if (global) {
    const matched = STANDARD_SCENARIOS[global.scenario] || {
      payload: { returnCode: -1, returnMessage: `UNKNOWN_SCENARIO_${global.scenario}`, data: null }
    };
    return {
      scenario: global.scenario,
      config: {
        ...matched,
        delayMs: global.delayMs !== undefined ? global.delayMs : matched.delayMs
      }
    };
  }

  // 5. Mặc định: Thành công
  return {
    scenario: 'success',
    config: STANDARD_SCENARIOS.success
  };
}
