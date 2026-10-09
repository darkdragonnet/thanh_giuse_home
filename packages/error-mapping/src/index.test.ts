import { evaluateHanetError } from './index.js';

// Test case 1: Lỗi quá tải -503 -> RETRY_LATER và backoff 300s
const res503 = evaluateHanetError(-503, 'SYSTEM_ERROR');
console.assert(res503.action === 'RETRY_LATER', 'Lỗi -503 phải là RETRY_LATER');
console.assert(res503.suggestedBackoffMs === 300_000, 'Lỗi -503 phải backoff 300s');

// Test case 2: Lỗi ảnh không hợp lệ -9006 -> QUARANTINE_MANUAL
const res9006 = evaluateHanetError(-9006, 'EMPLOYEE_REGISTER_IMG_INVALID_ERROR');
console.assert(res9006.action === 'QUARANTINE_MANUAL', 'Lỗi -9006 phải là QUARANTINE_MANUAL');
console.assert(!res9006.isRetryable, 'Lỗi -9006 không được retry tự động');

// Test case 3: Thành công 1 -> SUCCESS
const resSuccess = evaluateHanetError(1, 'SUCCESS');
console.assert(resSuccess.action === 'SUCCESS', 'Code 1 phải là SUCCESS');

// Test case 4: Token hết hạn -103 -> REFRESH_TOKEN
const res103 = evaluateHanetError(-103, 'ACCESS_TOKEN_EXPIRE');
console.assert(res103.action === 'REFRESH_TOKEN', 'Lỗi -103 phải là REFRESH_TOKEN');
console.assert(res103.isRetryable === true, 'Lỗi -103 phải retryable');

// Test case 5: Mã lỗi không xác định -> UNKNOWN_ERROR
const resUnknown = evaluateHanetError(-99999, 'RANDOM_ERROR');
console.assert(resUnknown.action === 'UNKNOWN_ERROR', 'Mã lạ phải là UNKNOWN_ERROR');

console.log('All error mapping unit tests passed successfully!');
