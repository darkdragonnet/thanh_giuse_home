import { describe, it, expect } from 'vitest';
import { evaluateHanetError, HANET_ERROR_MAP } from '../packages/error-mapping/src/index.js';

describe('T010: 3-Tier HANET Error Classification & Mapping', () => {
  describe('Tầng 1: Lỗi Hạ tầng / Quá tải (Fixed Backoff 300s)', () => {
    it('-503 (Server Error): map sang RETRY_LATER với backoff 300s (300.000ms)', () => {
      const eval503 = evaluateHanetError(-503, 'Server Overloaded');
      expect(eval503.action).toBe('RETRY_LATER');
      expect(eval503.isRetryable).toBe(true);
      expect(eval503.suggestedBackoffMs).toBe(300_000);
      expect(eval503.userFacingMessage).toContain('quá tải');
    });

    it('-909 (Lỗi mạng / upload): map sang RETRY_LATER', () => {
      const eval909 = evaluateHanetError(-909, 'Network Failure');
      expect(eval909.action).toBe('RETRY_LATER');
      expect(eval909.isRetryable).toBe(true);
    });
  });

  describe('Tầng 2: Lỗi Dữ liệu / AI Edge Cases (Fast Isolation -> manual_review)', () => {
    it('-9006 (Ảnh không đạt chuẩn / mờ): map sang QUARANTINE_MANUAL, không retry', () => {
      const eval9006 = evaluateHanetError(-9006, 'Face not clear');
      expect(eval9006.action).toBe('QUARANTINE_MANUAL');
      expect(eval9006.isRetryable).toBe(false);
      expect(eval9006.userFacingMessage).toContain('nhìn thẳng');
    });

    it('-9007 (Trùng khuôn mặt): map sang QUARANTINE_MANUAL, không retry', () => {
      const eval9007 = evaluateHanetError(-9007, 'Duplicate face detected');
      expect(eval9007.action).toBe('QUARANTINE_MANUAL');
      expect(eval9007.isRetryable).toBe(false);
      expect(eval9007.userFacingMessage).toContain('trùng lặp');
    });

    it('-9002 (Sai định dạng file trên cloud): map sang FATAL_INVALID_DATA', () => {
      const eval9002 = evaluateHanetError(-9002, 'Unsupported file format');
      expect(eval9002.action).toBe('FATAL_INVALID_DATA');
      expect(eval9002.isRetryable).toBe(false);
    });

    it('-9005 (Người dùng đã tồn tại): map sang ALREADY_EXISTS', () => {
      const eval9005 = evaluateHanetError(-9005, 'Person already exists');
      expect(eval9005.action).toBe('ALREADY_EXISTS');
      expect(eval9005.isRetryable).toBe(false);
      expect(eval9005.userFacingMessage).toContain('đã tồn tại');
    });
  });

  describe('Tầng 3: Lỗi Giới hạn Tài khoản & Khẩn cấp (Kill Switch Triggers)', () => {
    it('-9008 (Hết hạn mức lưu trữ Face ID): map sang QUOTA_EXCEEDED, không retry', () => {
      const eval9008 = evaluateHanetError(-9008, 'Face ID Quota Exceeded');
      expect(eval9008.action).toBe('QUOTA_EXCEEDED');
      expect(eval9008.isRetryable).toBe(false);
      expect(eval9008.userFacingMessage).toContain('hết hạn mức lưu trữ Face ID');
    });

    it('-103 (Access Token hết hạn): map sang SYSTEM_TOKEN_EXPIRED kích hoạt Kill Switch', () => {
      const eval103 = evaluateHanetError(-103, 'Token Expired');
      expect(eval103.action).toBe('SYSTEM_TOKEN_EXPIRED');
      expect(eval103.isRetryable).toBe(false);
      expect(eval103.userFacingMessage).toContain('hết hạn');
    });

    it('-401 (Unauthorized): map sang SYSTEM_TOKEN_EXPIRED', () => {
      const eval401 = evaluateHanetError(-401, 'Unauthorized access');
      expect(eval401.action).toBe('SYSTEM_TOKEN_EXPIRED');
      expect(eval401.isRetryable).toBe(false);
    });
  });

  describe('Quy tắc Quá số lần thử (Max Retries Rule -> manual_review)', () => {
    it('attemptsMade >= 3 hoặc currentRetries >= 2 kích hoạt cách ly manual_review', () => {
      const isExceededRetries = (attemptsMade: number, currentRetries: number) => {
        return currentRetries >= 2 || attemptsMade >= 3;
      };

      expect(isExceededRetries(1, 0)).toBe(false);
      expect(isExceededRetries(2, 1)).toBe(false);
      expect(isExceededRetries(3, 0)).toBe(true);
      expect(isExceededRetries(1, 2)).toBe(true);
      expect(isExceededRetries(4, 3)).toBe(true);
    });
  });

  describe('Mã lỗi không xác định (Unknown Error Fallback)', () => {
    it('Mã lỗi lạ (-99999) trả về UNKNOWN_ERROR an toàn', () => {
      const evalUnknown = evaluateHanetError(-99999, 'Custom gateway error');
      expect(evalUnknown.action).toBe('UNKNOWN_ERROR');
      expect(evalUnknown.isRetryable).toBe(false);
      expect(evalUnknown.userFacingMessage).toContain('không xác định');
    });
  });
});
