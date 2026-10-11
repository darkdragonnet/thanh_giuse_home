import assert from 'node:assert/strict';
import { parseAndClassifyAlias } from './hanet-cloud.js';

console.log('--- ĐANG CHẠY BỘ KIỂM THỬ PARSER HANET CLOUD ---');

// Kịch bản 1: 3 phần hợp lệ - Thêm Sức 1A
const res1 = parseAndClassifyAlias({
  personID: 'pid_1',
  name: 'Em Lan',
  aliasID: 'TN_Themsuc1a_01',
  file: 'https://cdn.hanet.ai/1.jpg',
});
assert.equal(res1.isError, false, 'Kịch bản 1 phải hợp lệ');
assert.equal(res1.nhom1_nganh, 'TN');
assert.equal(res1.nhom2_lop, 'Themsuc1a');
assert.equal(res1.nhom3_id, '01');
assert.equal(res1.maLopChuanHoa, 'TS1A');
assert.equal(res1.aliasChuanHoaDuKien, 'TS1A_01');
assert.equal(res1.tenLopTiengViet, 'Lớp Thêm Sức 1A');
console.log('✓ Kịch bản 1 PASS: TN_Themsuc1a_01 -> TS1A_01');

// Kịch bản 2: Ban GLV hợp lệ
const res2 = parseAndClassifyAlias({
  personID: 'pid_2',
  name: 'GLV Minh',
  aliasID: 'TN_GLV_05',
  file: 'https://cdn.hanet.ai/2.jpg',
});
assert.equal(res2.isError, false, 'Kịch bản 2 phải hợp lệ');
assert.equal(res2.nhom1_nganh, 'TN');
assert.equal(res2.nhom2_lop, 'GLV');
assert.equal(res2.nhom3_id, '05');
assert.equal(res2.maLopChuanHoa, 'GLV');
assert.equal(res2.aliasChuanHoaDuKien, 'GLV_05');
console.log('✓ Kịch bản 2 PASS: TN_GLV_05 -> GLV_05');

// Kịch bản 3: Lêgiô hợp lệ - DMHCCC
const res3 = parseAndClassifyAlias({
  personID: 'pid_3',
  name: 'Hội Viên Mai',
  aliasID: 'LG_DMHCCC_08',
  file: 'https://cdn.hanet.ai/3.jpg',
});
assert.equal(res3.isError, false, 'Kịch bản 3 phải hợp lệ');
assert.equal(res3.nhom1_nganh, 'LG');
assert.equal(res3.nhom2_lop, 'DMHCCC');
assert.equal(res3.nhom3_id, '08');
assert.equal(res3.maLopChuanHoa, 'DMHCCC');
assert.equal(res3.aliasChuanHoaDuKien, 'DMHCCC_08');
console.log('✓ Kịch bản 3 PASS: LG_DMHCCC_08 -> DMHCCC_08');

// Kịch bản 4: Thừa dấu gạch (4 phần)
const res4 = parseAndClassifyAlias({
  personID: 'pid_4',
  name: 'Lỗi 4 phần',
  aliasID: 'TN_Themsuc1a_01_extra',
  file: 'https://cdn.hanet.ai/4.jpg',
});
assert.equal(res4.isError, true);
assert.equal(res4.errorCode, 'ERR_PARTS_COUNT');
console.log('✓ Kịch bản 4 PASS: TN_Themsuc1a_01_extra -> ERR_PARTS_COUNT');

// Kịch bản 5: Thiếu định danh con (2 phần)
const res5 = parseAndClassifyAlias({
  personID: 'pid_5',
  name: 'Lỗi thiếu phần',
  aliasID: 'LG_DMHCCC',
  file: 'https://cdn.hanet.ai/5.jpg',
});
assert.equal(res5.isError, true);
assert.equal(res5.errorCode, 'ERR_PARTS_COUNT');
console.log('✓ Kịch bản 5 PASS: LG_DMHCCC -> ERR_PARTS_COUNT');

// Kịch bản 6: Để trống thành phần (TN__01)
const res6 = parseAndClassifyAlias({
  personID: 'pid_6',
  name: 'Lỗi rỗng nhóm 2',
  aliasID: 'TN__01',
  file: 'https://cdn.hanet.ai/6.jpg',
});
assert.equal(res6.isError, true);
assert.equal(res6.errorCode, 'ERR_EMPTY_SEGMENT');
console.log('✓ Kịch bản 6 PASS: TN__01 -> ERR_EMPTY_SEGMENT');

// Kịch bản 7: Sai tiền tố (test_camera_gate)
const res7 = parseAndClassifyAlias({
  personID: 'pid_7',
  name: 'Lỗi tiền tố',
  aliasID: 'test_camera_gate',
  file: 'https://cdn.hanet.ai/7.jpg',
});
assert.equal(res7.isError, true);
assert.equal(res7.errorCode, 'ERR_INVALID_SECTOR');
console.log('✓ Kịch bản 7 PASS: test_camera_gate -> ERR_INVALID_SECTOR');

// Kịch bản 8: Trống aliasID
const res8 = parseAndClassifyAlias({
  personID: 'pid_8',
  name: 'Lỗi trống',
  aliasID: '',
  file: 'https://cdn.hanet.ai/8.jpg',
});
assert.equal(res8.isError, true);
assert.equal(res8.errorCode, 'ERR_EMPTY_ALIAS');
console.log('✓ Kịch bản 8 PASS: "" -> ERR_EMPTY_ALIAS');

// Kịch bản 9: Không có trong từ điển
const res9 = parseAndClassifyAlias({
  personID: 'pid_9',
  name: 'Lớp lạ',
  aliasID: 'TN_LopKhongBiet_01',
  file: 'https://cdn.hanet.ai/9.jpg',
});
assert.equal(res9.isError, true);
assert.equal(res9.errorCode, 'ERR_UNKNOWN_CLASS');
console.log('✓ Kịch bản 9 PASS: TN_LopKhongBiet_01 -> ERR_UNKNOWN_CLASS');

// Kịch bản 10: Lệch Sector (TN_DMHCCC_01)
const res10 = parseAndClassifyAlias({
  personID: 'pid_10',
  name: 'Lệch sector',
  aliasID: 'TN_DMHCCC_01',
  file: 'https://cdn.hanet.ai/10.jpg',
});
assert.equal(res10.isError, true);
assert.equal(res10.errorCode, 'ERR_SECTOR_MISMATCH');
console.log('✓ Kịch bản 10 PASS: TN_DMHCCC_01 -> ERR_SECTOR_MISMATCH');

console.log('🎉 TẤT CẢ 10/10 KỊCH BẢN KIỂM THỬ PARSER ĐỀU VƯỢT QUA XUẤT SẮC!');
