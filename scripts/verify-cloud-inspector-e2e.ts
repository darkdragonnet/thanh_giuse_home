import assert from 'node:assert/strict';
import { generate108MockFaces } from '../apps/hanet-mock/src/data/mock-faces.js';
import {
  parseAndClassifyAlias,
  ParsedCloudResult,
  CloudInspectorResponse,
} from '../packages/shared-types/src/hanet-cloud.js';

console.log('--- ĐANG CHẠY KIỂM THỬ TỔNG THỂ CLOUD FACE INSPECTOR (108 FACE IDs) ---');

// 1. Kiểm tra bộ dữ liệu phát sinh
const rawFaces = generate108MockFaces();
assert.equal(rawFaces.length, 108, 'Tổng số bản ghi phát sinh phải đúng 108');
console.log('✓ Sinh đúng 108 bản ghi Mock Face ID');

// 2. Chạy parser trên 108 bản ghi
const parsedItems: ParsedCloudResult[] = rawFaces.map((f) => parseAndClassifyAlias(f));
assert.equal(parsedItems.length, 108);

// 3. Phân loại hợp lệ và lỗi
const validItems = parsedItems.filter((i) => !i.isError);
const errorItems = parsedItems.filter((i) => i.isError);

assert.equal(validItems.length, 104, 'Số bản ghi hợp lệ phải đúng 104');
assert.equal(errorItems.length, 4, 'Số bản ghi lỗi phải đúng 4');
console.log('✓ Phân loại chính xác: 104 Hợp Lệ | 4 Lỗi Dị Biệt');

// 4. Kiểm tra phân bổ Ngành (Sector)
let tnCount = 0;
let lgCount = 0;
const summaryByGroup: Record<string, { count: number; normalizedCode: string; label: string; sector: 'TN' | 'LG' }> = {};

for (const item of validItems) {
  if (item.nhom1_nganh === 'TN') tnCount++;
  if (item.nhom1_nganh === 'LG') lgCount++;

  const key = item.nhom2_lop!.toLowerCase();
  if (!summaryByGroup[key]) {
    summaryByGroup[key] = {
      count: 0,
      normalizedCode: item.maLopChuanHoa!,
      label: item.tenLopTiengViet!,
      sector: item.nhom1_nganh!,
    };
  }
  summaryByGroup[key].count += 1;
}

assert.equal(tnCount, 90, 'Thiếu Nhi (TN) phải có 90 khuôn mặt (78 em + 12 GLV)');
assert.equal(lgCount, 14, 'Lêgiô (LG) phải có 14 khuôn mặt (Praesidium DMHCCC)');
console.log('✓ Thống kê Sector chính xác: TN = 90 | LG = 14');

// 5. Kiểm tra từng nhóm lớp
assert.equal(summaryByGroup['themsuc1a'].count, 25, 'Thêm Sức 1A phải có 25 em');
assert.equal(summaryByGroup['themsuc1a'].normalizedCode, 'TS1A');
assert.equal(summaryByGroup['themsuc1b'].count, 20, 'Thêm Sức 1B phải có 20 em');
assert.equal(summaryByGroup['themsuc1b'].normalizedCode, 'TS1B');
assert.equal(summaryByGroup['rucle1a'].count, 33, 'Rước Lễ 1A phải có 33 em');
assert.equal(summaryByGroup['rucle1a'].normalizedCode, 'RL1A');
assert.equal(summaryByGroup['glv'].count, 12, 'GLV phải có 12 người');
assert.equal(summaryByGroup['glv'].normalizedCode, 'GLV');
assert.equal(summaryByGroup['dmhccc'].count, 14, 'DMHCCC phải có 14 người');
assert.equal(summaryByGroup['dmhccc'].normalizedCode, 'DMHCCC');
console.log('✓ Chi tiết từng nhóm lớp khớp 100% với từ điển: TS1A (25), TS1B (20), RL1A (33), GLV (12), DMHCCC (14)');

// 6. Kiểm tra Natural Sort cho nhom3_id
validItems.sort((a, b) =>
  (a.nhom3_id || '').localeCompare(b.nhom3_id || '', undefined, { numeric: true })
);
const ts1aItems = validItems.filter((i) => i.nhom2_lop === 'Themsuc1a');
assert.equal(ts1aItems[0].nhom3_id, '01');
assert.equal(ts1aItems[ts1aItems.length - 1].nhom3_id, '25');
console.log('✓ Sắp xếp tự nhiên (Natural Sort) hiển thị tuần tự từ 01 -> 25 thành công');

// 7. Kiểm tra 4 bản ghi lỗi
assert.equal(errorItems[0].errorCode, 'ERR_PARTS_COUNT');
assert.equal(errorItems[1].errorCode, 'ERR_PARTS_COUNT');
assert.equal(errorItems[2].errorCode, 'ERR_PARTS_COUNT');
assert.equal(errorItems[3].errorCode, 'ERR_PARTS_COUNT');
console.log('✓ 4 Bản ghi lỗi dị biệt đều được phân loại và bắt mã lỗi chính xác');

console.log('🎉 TOÀN BỘ KIỂM THỬ TỔNG THỂ E2E CLOUD FACE INSPECTOR ĐẠT 100% CHUẨN XÁC!');
