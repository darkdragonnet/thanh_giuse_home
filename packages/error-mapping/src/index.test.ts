import assert from 'node:assert';
import { evaluateHanetError } from './index.js';

console.log('[TEST] Kiểm thử packages/error-mapping:');

const eval503 = evaluateHanetError(-503);
assert.strictEqual(eval503.action, 'RETRY_LATER');
assert.strictEqual(eval503.suggestedBackoffMs, 300_000);
console.log('- [-503 RETRY_LATER 300s]: PASS');

const eval9006 = evaluateHanetError(-9006);
assert.strictEqual(eval9006.action, 'QUARANTINE_MANUAL');
console.log('- [-9006 QUARANTINE_MANUAL]: PASS');

const eval9008 = evaluateHanetError(-9008);
assert.strictEqual(eval9008.action, 'QUOTA_EXCEEDED');
console.log('- [-9008 QUOTA_EXCEEDED]: PASS');

const eval103 = evaluateHanetError(-103);
assert.strictEqual(eval103.action, 'SYSTEM_TOKEN_EXPIRED');
assert.strictEqual(eval103.isRetryable, false);
console.log('- [-103 SYSTEM_TOKEN_EXPIRED]: PASS');

console.log('✓ TOÀN BỘ KIỂM THỬ ERROR-MAPPING PASS 100%!\n');
