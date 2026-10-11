export interface ValidationResult {
    isValid: boolean;
    errorCode?: 'LEGACY_FORMAT_QUARANTINED' | 'INVALID_IDENTIFIER_FORMAT' | 'MISSING_HANET_PERSON_ID';
    isLockedForManualEdit?: boolean;
    message?: string;
}
/**
 * Validator Engine kiểm tra định danh học sinh
 * Tuân thủ Hiến pháp Dự án (Rules 00 & 01):
 * - Chặn và cô lập mã seed cũ 17 ký tự (STU_...)
 * - Chấp nhận mã chuẩn 4_4 (9 ký tự)
 * - Từ chối mã không đủ độ dài hoặc sai regex
 * - Chặn khi thiếu HANET person_id (Anchor Key)
 */
export declare function validateStudentIdentifier(aliasId: string, hanetPersonId: string | null | undefined): ValidationResult;
//# sourceMappingURL=identifier.validator.d.ts.map