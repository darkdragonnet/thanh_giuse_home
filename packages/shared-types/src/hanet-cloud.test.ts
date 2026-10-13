import assert from 'node:assert/strict';
import {
  parseAndClassifyAlias,
  generateDeterministicSuffix4,
  generateTempAliasId,
  generateQrToken,
  resolveDeterministicAliasInMemory,
  FIXED_9CHAR_ALIAS_REGEX,
} from './hanet-cloud.js';

console.log('--- ĐANG CHẠY BỘ KIỂM THỬ PARSER & 2-PHASE ALIAS HANET CLOUD ---');

// Kịch bản 1: 3 phần hợp lệ - Thêm Sức 1A -> Chuẩn 9 ký tự
const res1 = parseAndClassifyAlias({
  personID: 'pid_1',
  name: 'Em Lan',
  aliasID: 'TN_Themsuc1a_01',
  file: 'https://cdn.hanet.ai/1.jpg',
});
assert.equal(res1.isError, false, 'Kịch bản 1 phải hợp lệ');
assert.equal(res1.nhom1_nganh, 'TN');
assert.equal(res1.nhom2_lop, 'Themsuc1a');
assert.equal(res1.maLopChuanHoa, 'TS1A');
assert.equal(FIXED_9CHAR_ALIAS_REGEX.test(res1.aliasChuanHoaDuKien!), true);
console.log(`✓ Kịch bản 1 PASS: TN_Themsuc1a_01 -> ${res1.aliasChuanHoaDuKien}`);

// Kịch bản 2: Ban GLV hợp lệ -> GLV0_XXXX
const res2 = parseAndClassifyAlias({
  personID: 'pid_2',
  name: 'GLV Minh',
  aliasID: 'TN_GLV_05',
  file: 'https://cdn.hanet.ai/2.jpg',
});
assert.equal(res2.isError, false, 'Kịch bản 2 phải hợp lệ');
assert.equal(res2.maLopChuanHoa, 'GLV0');
assert.equal(FIXED_9CHAR_ALIAS_REGEX.test(res2.aliasChuanHoaDuKien!), true);
console.log(`✓ Kịch bản 2 PASS: TN_GLV_05 -> ${res2.aliasChuanHoaDuKien}`);

// Kịch bản 3: Lêgiô hợp lệ - DMHCCC -> LM01_XXXX
const res3 = parseAndClassifyAlias({
  personID: 'pid_3',
  name: 'Hội Viên Mai',
  aliasID: 'LG_DMHCCC_08',
  file: 'https://cdn.hanet.ai/3.jpg',
});
assert.equal(res3.isError, false, 'Kịch bản 3 phải hợp lệ');
assert.equal(res3.maLopChuanHoa, 'LM01');
assert.equal(FIXED_9CHAR_ALIAS_REGEX.test(res3.aliasChuanHoaDuKien!), true);
console.log(`✓ Kịch bản 3 PASS: LG_DMHCCC_08 -> ${res3.aliasChuanHoaDuKien}`);

// Kịch bản 4: Để trống thành phần (TN__01) -> ERR_EMPTY_SEGMENT
const res4 = parseAndClassifyAlias({
  personID: 'pid_6',
  name: 'Lỗi rỗng nhóm 2',
  aliasID: 'TN__01',
  file: 'https://cdn.hanet.ai/6.jpg',
});
assert.equal(res4.isError, true);
assert.equal(res4.errorCode, 'ERR_EMPTY_SEGMENT');
console.log('✓ Kịch bản 4 PASS: TN__01 -> ERR_EMPTY_SEGMENT');

// Kịch bản 5: Trống aliasID -> ERR_EMPTY_ALIAS
const res5 = parseAndClassifyAlias({
  personID: 'pid_8',
  name: 'Lỗi trống',
  aliasID: '',
  file: 'https://cdn.hanet.ai/8.jpg',
});
assert.equal(res5.isError, true);
assert.equal(res5.errorCode, 'ERR_EMPTY_ALIAS');
console.log('✓ Kịch bản 5 PASS: "" -> ERR_EMPTY_ALIAS');

// Kịch bản 6: Linear Probing khi va chạm Hash trong cùng 1 lớp
const map = new Map<string, string>();
const first = resolveDeterministicAliasInMemory('TS1A', '18897244400810101', map);
assert.equal(first.attempt, 0);
assert.equal(first.collided, false);

// Giả lập một personID khác bị trùng đúng mã của first.aliasId ở attempt = 0
const fakeCollidingMap = new Map<string, string>([
  [first.aliasId.toUpperCase(), 'OTHER_PERSON_ID'],
]);
const probed = resolveDeterministicAliasInMemory('TS1A', '18897244400810101', fakeCollidingMap);
assert.equal(probed.attempt, 1, 'Phải tự động tăng attempt lên 1 khi trùng mã ở attempt 0');
assert.notEqual(probed.aliasId, first.aliasId);
assert.equal(FIXED_9CHAR_ALIAS_REGEX.test(probed.aliasId), true);
console.log(`✓ Kịch bản 6 PASS: Linear Probing ${first.aliasId} -> ${probed.aliasId}`);

// Kịch bản 7: TempAliasId và QrToken
const qrToken = generateQrToken();
assert.equal(qrToken.length, 16);
const tempAlias = generateTempAliasId('TS1A', qrToken);
assert.equal(FIXED_9CHAR_ALIAS_REGEX.test(tempAlias), true);
assert.equal(generateDeterministicSuffix4('0').length, 4);
console.log(`✓ Kịch bản 7 PASS: qrToken=${qrToken}, tempAlias=${tempAlias}`);

console.log('🎉 TẤT CẢ KỊCH BẢN KIỂM THỬ SHARED-TYPES ĐỀU VƯỢT QUA XUẤT SẮC!');
