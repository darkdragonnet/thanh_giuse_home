import { describe, it, expect, vi } from 'vitest';
import { ClassRepository } from '../packages/shared-infra/src/repositories/classRepository.js';

describe('T021: Teacher PIN Security Verification (Vá lỗ hổng fallback PIN_<CODE>)', () => {
  it('Chỉ chấp nhận token thật trong DB, BỎ HOÀN TOÀN mẫu suy diễn PIN_<MÃ_LỚP>', async () => {
    const mockPool = {
      query: vi.fn().mockImplementation(async (sql: string, params: any[]) => {
        return {
          rows: [
            {
              id: 1,
              code: '10A1',
              token: 'SECRET_TOKEN_REAL_9999', // Token thật khác xa mã lớp
            },
          ],
        };
      }),
    } as any;

    const classRepo = new ClassRepository(mockPool);

    // 1. PIN theo mẫu cũ PIN_10A1 hoặc PIN_10A1_XYZ → BẮT BUỘC BỊ TỪ CHỐI
    const fallbackPinResult = await classRepo.verifyTeacherPin(1, 'PIN_10A1');
    expect(fallbackPinResult).toBe(false);

    const fallbackPinPrefixResult = await classRepo.verifyTeacherPin(1, 'PIN_10A1_999');
    expect(fallbackPinPrefixResult).toBe(false);

    // 2. Token thật trong DB → HỢP LỆ (chấp nhận cả không phân biệt hoa thường)
    const validResult = await classRepo.verifyTeacherPin(1, 'SECRET_TOKEN_REAL_9999');
    expect(validResult).toBe(true);

    const validLowerResult = await classRepo.verifyTeacherPin(1, 'secret_token_real_9999');
    expect(validLowerResult).toBe(true);

    // 3. PIN sai hoặc rác → BỊ TỪ CHỐI
    const wrongResult = await classRepo.verifyTeacherPin(1, 'WRONG_PIN_ABC');
    expect(wrongResult).toBe(false);

    // 4. PIN rỗng → BỊ TỪ CHỐI
    const emptyResult = await classRepo.verifyTeacherPin(1, '');
    expect(emptyResult).toBe(false);
  });
});
