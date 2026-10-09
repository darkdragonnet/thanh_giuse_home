import { HanetErrorEvaluation } from '@thanh-giuse/error-mapping';

export interface HanetClientOptions {
  baseUrl?: string | undefined;
  token: string;
  placeId: string;
  timeoutMs?: number | undefined; // Mặc định 120_000ms
  circuitBreakerThreshold?: number | undefined; // Mặc định 3 lỗi liên tiếp
  circuitBreakerCooldownMs?: number | undefined; // Mặc định 300_000ms (5 phút)
}

export interface HanetApiResponse<T = unknown> {
  returnCode: number;
  returnMessage: string;
  data: T;
}

export interface HanetClientResult<T = unknown> {
  success: boolean;
  rawResponse?: HanetApiResponse<T> | undefined;
  evaluation: HanetErrorEvaluation;
  error?: Error | undefined;
}

export interface RegisterByUrlParams {
  aliasID: string;
  name: string;
  imageUrl: string;
  title?: string | undefined;
  type?: 0 | 1 | undefined; // 0: Nhân viên/Học sinh, 1: Khách hàng
}

export interface UpdateByFaceImageParams {
  personID: string;
  imageBuffer: Buffer;
  filename?: string | undefined;
}

export interface ConnectionStatusResult {
  deviceID: string;
  status: 0 | 1; // 0: Offline, 1: Online
}
