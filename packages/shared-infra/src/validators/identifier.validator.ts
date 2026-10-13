export interface ValidationResult {
  isValid: boolean;
  errorCode?: 'LEGACY_FORMAT_QUARANTINED' | 'INVALID_IDENTIFIER_FORMAT' | 'MISSING_HANET_PERSON_ID';
  isLockedForManualEdit?: boolean;
  message?: string;
}

/**
 * Biểu thức chính quy kiểm thực chuẩn 9 ký tự:
 * Tiền tố 4 ký tự: 2 chữ cái + 2 chữ cái hoặc số
 * Dấu gạch dưới: _
 * Hậu tố 4 ký tự: 4 chữ cái hoặc số
 * Ví dụ hợp lệ: 'TS1A_A7B2', 'GLV0_0045', 'TN02_1111'
 */
export const VALID_9_CHAR_REGEX = /^[A-Za-z]{2}[A-Za-z0-9]{2}_[A-Za-z0-9]{4}$/;
export const REGEX_VALID_STUDENT_ID = VALID_9_CHAR_REGEX;


/**
 * Validator Engine kiểm tra định danh học sinh
 * Tuân thủ Hiến pháp Dự án (Rules 00 & 01):
 * - Chặn và cô lập mã seed cũ 17 ký tự (STU_...)
 * - Chấp nhận mã chuẩn 4_4 (9 ký tự)
 * - Từ chối mã không đủ độ dài hoặc sai regex
 * - Chặn khi thiếu HANET person_id (Anchor Key)
 */
export function validateStudentIdentifier(
  aliasId: string,
  hanetPersonId: string | null | undefined
): ValidationResult {
  // 1. Kiểm tra HANET person_id (Anchor Key)
  if (!hanetPersonId) {
    return {
      isValid: false,
      errorCode: 'MISSING_HANET_PERSON_ID',
      message: 'Thiếu HANET person_id (Anchor Key)',
    };
  }

  // 2. Phát hiện và cô lập mã seed cũ 17 ký tự (STU_...)
  if (
    aliasId.startsWith('STU_') ||
    aliasId.length === 17 ||
    aliasId.includes('10A1_') ||
    aliasId.includes('10A2_')
  ) {
    return {
      isValid: false,
      errorCode: 'LEGACY_FORMAT_QUARANTINED',
      isLockedForManualEdit: true,
      message: 'Mã định danh thuộc định dạng seed cũ 17 ký tự (STU_...). Đã cô lập an toàn.',
    };
  }

  // 3. Kiểm tra mã chuẩn 4_4 (đúng 9 ký tự)
  if (aliasId.length === 9 && VALID_9_CHAR_REGEX.test(aliasId)) {
    return {
      isValid: true,
    };
  }

  // 4. Các trường hợp không đủ độ dài hoặc sai regex
  return {
    isValid: false,
    errorCode: 'INVALID_IDENTIFIER_FORMAT',
    message: 'Mã định danh không đúng chuẩn 9 ký tự (Tiền tố 4 ký tự + "_" + Hậu tố 4 ký tự)',
  };
}
