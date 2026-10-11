import { describe, it, expect } from 'vitest';
import { validateStudentIdentifier } from '../shared/validators/identifier.validator.js';

describe('Tầng Kiểm Tra Định Dạng (Validator Engine)', () => {
  it('Phải chặn và cô lập mã seed cũ 17 ký tự (STU_...)', () => {
    const result = validateStudentIdentifier('STU_10A1_001_A7B2C', 'HANET_123');
    expect(result.isValid).toBe(false);
    expect(result.errorCode).toBe('LEGACY_FORMAT_QUARANTINED');
    expect(result.isLockedForManualEdit).toBe(true);
  });

  it('Phải chấp nhận mã chuẩn 4_4 (9 ký tự)', () => {
    const result = validateStudentIdentifier('TS1A_A7B2', 'HANET_123');
    expect(result.isValid).toBe(true);
  });

  it('Phải từ chối mã không đủ độ dài hoặc sai regex (VD: TS1A_01)', () => {
    const result = validateStudentIdentifier('TS1A_01', 'HANET_123');
    expect(result.isValid).toBe(false);
    expect(result.errorCode).toBe('INVALID_IDENTIFIER_FORMAT');
  });

  it('Phải chặn khi thiếu HANET person_id (Anchor Key)', () => {
    const result = validateStudentIdentifier('TS1A_A7B2', null);
    expect(result.isValid).toBe(false);
    expect(result.errorCode).toBe('MISSING_HANET_PERSON_ID');
  });
});
