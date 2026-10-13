export interface RawCloudFace {
  personID: string;
  name: string;
  aliasID: string;
  file?: string;
  avatar?: string;
  title?: string;
  departmentID?: number | string;
}

export type CloudErrorCode =
  | 'ERR_EMPTY_ALIAS'
  | 'ERR_PARTS_COUNT'
  | 'ERR_EMPTY_SEGMENT'
  | 'ERR_INVALID_SECTOR'
  | 'ERR_UNKNOWN_CLASS'
  | 'ERR_SECTOR_MISMATCH';

export type CloudSector = 'TN' | 'LM' | 'LG';

export interface ParsedCloudResult {
  personID: string;
  name: string;
  rawAliasID: string;
  file: string;
  partsCount: number;
  nhom1_nganh?: CloudSector;
  nhom2_lop?: string;
  nhom3_id?: string;
  tenLopTiengViet?: string;
  maLopChuanHoa?: string;
  aliasChuanHoaDuKien?: string | undefined;
  departmentID?: number | string | undefined;
  isError: boolean;
  errorCode?: CloudErrorCode;
  errorReason?: string;
}

export interface CloudClassDictionaryItem {
  label: string;
  normalizedCode: string;
  sector: CloudSector;
}

export interface CloudInspectorResponse {
  total: number;
  validCount: number;
  errorCount: number;
  isLiveCloud?: boolean;
  placeID?: string;
  sectorCounts: {
    TN: number;
    LG: number;
    LM: number;
    ERROR: number;
  };
  warningMessage?: string | undefined;
  isPlaceIdAutoCorrected?: boolean | undefined;
  summaryByGroup: Record<
    string,
    {
      count: number;
      normalizedCode: string;
      label: string;
      sector: CloudSector;
    }
  >;
  items: ParsedCloudResult[];
}

export interface DataDriftItem {
  type: 'CLOUD_ONLY' | 'DB_ORPHAN' | 'STATUS_MISMATCH' | 'ALIAS_MISMATCH';
  personID?: string | undefined;
  aliasID: string;
  studentName?: string | undefined;
  classCode?: string | undefined;
  dbStatus?: string | undefined;
  cloudName?: string | undefined;
  message: string;
}

export interface DataDriftReport {
  totalCloudFaces: number;
  totalDbStudents: number;
  matchedCount: number;
  cloudOnlyCount: number;
  dbOrphanCount: number;
  mismatchCount: number;
  driftItems: DataDriftItem[];
}

export const CLOUD_CLASS_DICTIONARY: Record<string, CloudClassDictionaryItem> = {
  // Ban Giáo Lý Viên & Lêgiô Mariae (Padded 4 ký tự: GLV0, LM01)
  glv:       { label: 'Ban Giáo Lý Viên', normalizedCode: 'GLV0', sector: 'TN' },
  glv0:      { label: 'Ban Giáo Lý Viên', normalizedCode: 'GLV0', sector: 'TN' },
  dmhccc:    { label: 'Đức Mẹ Hiệp Công Cứu Chuộc', normalizedCode: 'LM01', sector: 'LM' },
  lm:        { label: 'Đức Mẹ Hiệp Công Cứu Chuộc', normalizedCode: 'LM01', sector: 'LM' },
  lm01:      { label: 'Đức Mẹ Hiệp Công Cứu Chuộc', normalizedCode: 'LM01', sector: 'LM' },

  // Khối Thêm Sức
  themsuc1a: { label: 'Lớp Thêm Sức 1A', normalizedCode: 'TS1A', sector: 'TN' },
  ts1a:      { label: 'Lớp Thêm Sức 1A', normalizedCode: 'TS1A', sector: 'TN' },
  themsuc1b: { label: 'Lớp Thêm Sức 1B', normalizedCode: 'TS1B', sector: 'TN' },
  ts1b:      { label: 'Lớp Thêm Sức 1B', normalizedCode: 'TS1B', sector: 'TN' },
  themsuc1c: { label: 'Lớp Thêm Sức 1C', normalizedCode: 'TS1C', sector: 'TN' },
  ts1c:      { label: 'Lớp Thêm Sức 1C', normalizedCode: 'TS1C', sector: 'TN' },
  themsuc2b: { label: 'Lớp Thêm Sức 2B', normalizedCode: 'TS2B', sector: 'TN' },
  ts2b:      { label: 'Lớp Thêm Sức 2B', normalizedCode: 'TS2B', sector: 'TN' },
  themsuc2c: { label: 'Lớp Thêm Sức 2C', normalizedCode: 'TS2C', sector: 'TN' },
  ts2c:      { label: 'Lớp Thêm Sức 2C', normalizedCode: 'TS2C', sector: 'TN' },

  // Khối Xưng Tội / Rước Lễ (Ánh xạ chuẩn hóa về RL)
  rucle1a:   { label: 'Lớp Rước Lễ 1A',  normalizedCode: 'RL1A', sector: 'TN' },
  rl1a:      { label: 'Lớp Rước Lễ 1A',  normalizedCode: 'RL1A', sector: 'TN' },
  xungtoi1a: { label: 'Lớp Rước Lễ 1A',  normalizedCode: 'RL1A', sector: 'TN' },
  rucle1b:   { label: 'Lớp Rước Lễ 1B',  normalizedCode: 'RL1B', sector: 'TN' },
  rl1b:      { label: 'Lớp Rước Lễ 1B',  normalizedCode: 'RL1B', sector: 'TN' },
  xungtoi1b: { label: 'Lớp Rước Lễ 1B',  normalizedCode: 'RL1B', sector: 'TN' },
  rucle1c:   { label: 'Lớp Rước Lễ 1C',  normalizedCode: 'RL1C', sector: 'TN' },
  rl1c:      { label: 'Lớp Rước Lễ 1C',  normalizedCode: 'RL1C', sector: 'TN' },
  xungtoi1c: { label: 'Lớp Rước Lễ 1C',  normalizedCode: 'RL1C', sector: 'TN' },
  rucle2a:   { label: 'Lớp Rước Lễ 2A',  normalizedCode: 'RL2A', sector: 'TN' },
  rl2a:      { label: 'Lớp Rước Lễ 2A',  normalizedCode: 'RL2A', sector: 'TN' },
  xungtoi2a: { label: 'Lớp Rước Lễ 2A',  normalizedCode: 'RL2A', sector: 'TN' },
  rucle2b:   { label: 'Lớp Rước Lễ 2B',  normalizedCode: 'RL2B', sector: 'TN' },
  rl2b:      { label: 'Lớp Rước Lễ 2B',  normalizedCode: 'RL2B', sector: 'TN' },
  xungtoi2b: { label: 'Lớp Rước Lễ 2B',  normalizedCode: 'RL2B', sector: 'TN' },
  rucle2c:   { label: 'Lớp Rước Lễ 2C',  normalizedCode: 'RL2C', sector: 'TN' },
  rl2c:      { label: 'Lớp Rước Lễ 2C',  normalizedCode: 'RL2C', sector: 'TN' },
  xungtoi2c: { label: 'Lớp Rước Lễ 2C',  normalizedCode: 'RL2C', sector: 'TN' },
  rucle3a:   { label: 'Lớp Rước Lễ 3A',  normalizedCode: 'RL3A', sector: 'TN' },
  rl3a:      { label: 'Lớp Rước Lễ 3A',  normalizedCode: 'RL3A', sector: 'TN' },
  xungtoi3a: { label: 'Lớp Rước Lễ 3A',  normalizedCode: 'RL3A', sector: 'TN' },
  rucle3b:   { label: 'Lớp Rước Lễ 3B',  normalizedCode: 'RL3B', sector: 'TN' },
  rl3b:      { label: 'Lớp Rước Lễ 3B',  normalizedCode: 'RL3B', sector: 'TN' },
  xungtoi3b: { label: 'Lớp Rước Lễ 3B',  normalizedCode: 'RL3B', sector: 'TN' },
  rucle3c:   { label: 'Lớp Rước Lễ 3C',  normalizedCode: 'RL3C', sector: 'TN' },
  rl3c:      { label: 'Lớp Rước Lễ 3C',  normalizedCode: 'RL3C', sector: 'TN' },
  xungtoi3c: { label: 'Lớp Rước Lễ 3C',  normalizedCode: 'RL3C', sector: 'TN' },

  // Khối Khai Tâm & Bao Đồng & Vào Đời
  khaitam1a: { label: 'Lớp Khai Tâm 1A', normalizedCode: 'KT1A', sector: 'TN' },
  kt1a:      { label: 'Lớp Khai Tâm 1A', normalizedCode: 'KT1A', sector: 'TN' },
  khaitam3:  { label: 'Lớp Khai Tâm 3A', normalizedCode: 'KT3A', sector: 'TN' },
  kt3a:      { label: 'Lớp Khai Tâm 3A', normalizedCode: 'KT3A', sector: 'TN' },
  baodong1a: { label: 'Lớp Bao Đồng 1A', normalizedCode: 'BD1A', sector: 'TN' },
  bd1a:      { label: 'Lớp Bao Đồng 1A', normalizedCode: 'BD1A', sector: 'TN' },
  baodong2a: { label: 'Lớp Bao Đồng 2A', normalizedCode: 'BD2A', sector: 'TN' },
  bd2a:      { label: 'Lớp Bao Đồng 2A', normalizedCode: 'BD2A', sector: 'TN' },
  baodong3:  { label: 'Lớp Bao Đồng 3A', normalizedCode: 'BD3A', sector: 'TN' },
  bd3a:      { label: 'Lớp Bao Đồng 3A', normalizedCode: 'BD3A', sector: 'TN' },
  vaodoi1a:  { label: 'Lớp Vào Đời 1A',  normalizedCode: 'VD1A', sector: 'TN' },
  vd1a:      { label: 'Lớp Vào Đời 1A',  normalizedCode: 'VD1A', sector: 'TN' },
};

export const FIXED_9CHAR_ALIAS_REGEX = /^[A-Za-z]{2}[A-Za-z0-9]{2}_[A-Za-z0-9]{4}$/;

/**
 * Sinh chuỗi qr_token cố định 16 ký tự URL-safe (Không gian 2^96 tổ hợp)
 * Dùng cho kênh tự phục vụ cá nhân /u/:qr_token
 */
export function generateQrToken(): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  let token = '';
  for (let i = 0; i < 16; i++) {
    const idx = Math.floor(Math.random() * alphabet.length);
    token += alphabet[idx]!;
  }
  return token;
}

/**
 * Chuẩn hóa chuỗi tên tiếng Việt phục vụ đối soát Set-based SQL & In-Memory
 */
export function normalizeVietnameseStudentName(rawName: string): string {
  return (rawName || '')
    .normalize('NFC')
    .replace(/^\s*\d+[\.\-\/\)\s]\s*/, '')
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

/**
 * Thuật toán băm xác định FNV-1a 32-bit Base36 (mod 36^4) kèm tham số attempt cho Linear Probing
 * Pure JS, O(n), tiêu tốn < 1 microsecond, 0 I/O overhead.
 * Đảm bảo: Cùng 1 personID luôn ra đúng 1 hậu tố 4 ký tự chữ số in hoa duy nhất.
 */
export function generateDeterministicSuffix4(personID: string, attempt = 0): string {
  if (!personID || personID.trim() === '') return '0001';
  let hash = 0x811c9dc5; // 2166136261
  const str = String(personID).trim();
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193); // 16777619
  }
  const unsigned = ((hash >>> 0) + Math.max(0, attempt)) >>> 0;
  const modVal = unsigned % 1679616; // 36^4 = 1.679.616
  return modVal.toString(36).padStart(4, '0').toUpperCase();
}

/**
 * Sinh mã alias_id chuẩn 9 ký tự ở Pha 2: Prefix4 + "_" + FNV1a_Suffix4(personID, attempt)
 */
export function generateFinalAliasId(classCode: string, personID: string, attempt = 0): string {
  const prefix4 = normalizePrefix4(classCode);
  const suffix4 = generateDeterministicSuffix4(personID, attempt);
  return `${prefix4}_${suffix4}`;
}

/**
 * Sinh mã tempAliasId chuẩn 9 ký tự ở Pha 1 (Bảo toàn Lớp trên HANET Cloud trước khi có person_id):
 * Công thức: Prefix4 + "_" + RandomSuffix4 (4 ký tự Base36 in hoa)
 */
export function generateTempAliasId(classCode: string, seedToken?: string): string {
  const prefix4 = normalizePrefix4(classCode);
  if (seedToken && seedToken.trim().length >= 4) {
    const cleanSeed = seedToken
      .replace(/[^A-Za-z0-9]/g, 'X')
      .toUpperCase()
      .padEnd(4, '0')
      .substring(0, 4);
    if (/^[A-Z0-9]{4}$/.test(cleanSeed)) {
      return `${prefix4}_${cleanSeed}`;
    }
  }
  const randomVal = Math.floor(Math.random() * 1679616);
  const randomSuffix4 = randomVal.toString(36).padStart(4, '0').toUpperCase();
  return `${prefix4}_${randomSuffix4}`;
}

/**
 * Giải quyết va chạm Hash In-Memory bằng Deterministic Linear Probing (tối đa maxAttempts = 3)
 * usedAliasToPersonMap: Map<UPPERCASE_ALIAS_ID, PERSON_ID>
 */
export function resolveDeterministicAliasInMemory(
  classCode: string,
  personID: string,
  usedAliasToPersonMap: Map<string, string>,
  maxAttempts = 3
): { aliasId: string; attempt: number; collided: boolean } {
  const cleanPersonId = String(personID).trim();
  for (let attempt = 0; attempt <= maxAttempts; attempt++) {
    const candidate = generateFinalAliasId(classCode, cleanPersonId, attempt);
    const upperKey = candidate.toUpperCase();
    const existingOwner = usedAliasToPersonMap.get(upperKey);
    if (!existingOwner || existingOwner === cleanPersonId) {
      usedAliasToPersonMap.set(upperKey, cleanPersonId);
      return { aliasId: candidate, attempt, collided: false };
    }
  }
  const fallbackCandidate = generateFinalAliasId(classCode, cleanPersonId, 0);
  return { aliasId: fallbackCandidate, attempt: maxAttempts, collided: true };
}

/**
 * Chuẩn hóa tiền tố mã lớp về đúng 4 ký tự:
 * 1. Tra cứu từ điển CLOUD_CLASS_DICTIONARY.
 * 2. Nếu đã đúng 4 ký tự khớp ^[A-Za-z]{2}[A-Za-z0-9]{2}$: giữ nguyên hoa.
 * 3. Nếu độ dài < 4: đệm số 0 (VD: GLV -> GLV0, LM -> LM01, TN -> TN00).
 * 4. Nếu độ dài > 4:
 *    - Ưu tiên bóc tách: 2 chữ cái đầu khối + 2 ký tự số/lớp ở đuôi (VD: GIAOLY1A -> GL1A, THEMSUC1A -> TS1A, BAODONG3 -> BD03, XUNGTOI2A -> XT2A).
 *    - Fallback: cắt 4 ký tự đầu.
 */
export function normalizePrefix4(rawPrefix: string): string {
  const clean = (rawPrefix || '').trim();
  if (!clean) return 'GL00';

  const dictItem = CLOUD_CLASS_DICTIONARY[clean.toLowerCase()];
  if (dictItem) {
    return dictItem.normalizedCode;
  }

  // Nếu đã đúng 4 ký tự khớp regex 2 chữ + 2 chữ/số
  if (/^[A-Za-z]{2}[A-Za-z0-9]{2}$/.test(clean)) {
    return clean.toUpperCase();
  }

  // Độ dài < 4: Đệm số 0 vào sau
  if (clean.length === 2) {
    return `${clean.toUpperCase()}01`;
  }
  if (clean.length === 3) {
    return `${clean.toUpperCase()}0`;
  }
  if (clean.length === 1) {
    return `${clean.toUpperCase()}L01`;
  }

  // Độ dài > 4: Ánh xạ 2 chữ cái đầu khối + số/lớp ở đuôi
  const upper = clean.toUpperCase();
  const matchTail = upper.match(/(\d+[A-Z]?)$/);
  if (matchTail && matchTail[1]) {
    const tail = matchTail[1];
    const prefix2 = upper.substring(0, 2);
    if (/^[A-Z]{2}$/.test(prefix2)) {
      if (tail.length === 2) {
        return `${prefix2}${tail}`;
      } else if (tail.length === 1) {
        return `${prefix2}0${tail}`;
      } else if (tail.length > 2) {
        return `${prefix2}${tail.substring(tail.length - 2)}`;
      }
    }
  }

  // Fallback: Lấy 4 ký tự đầu tiên
  const prefix4 = upper.substring(0, 4);
  if (/^[A-Z]{2}[A-Z0-9]{2}$/.test(prefix4)) {
    return prefix4;
  }
  return 'GL00';
}

/**
 * Thuật toán bóc tách và quy chuẩn hóa mọi AliasID từ Cloud HANET về chuẩn 9 ký tự (Hiến pháp Điều 3 & Điều 4)
 * Biểu thức Regex: ^[A-Za-z]{2}[A-Za-z0-9]{2}_[A-Za-z0-9]{4}$
 */
export function parseAndClassifyAlias(face: RawCloudFace): ParsedCloudResult {
  const raw = (face.aliasID || '').trim();
  const fileUrl = face.file || face.avatar || '';

  if (!raw) {
    return {
      personID: face.personID,
      name: face.name,
      rawAliasID: raw,
      file: fileUrl,
      partsCount: 0,
      isError: true,
      errorCode: 'ERR_EMPTY_ALIAS',
      errorReason: 'Mã aliasID trống',
    };
  }

  // Sinh hậu tố 4 ký tự xác định từ personID
  const hashSuffix = generateDeterministicSuffix4(face.personID);

  // 1. Trường hợp đã chuẩn 9 ký tự bất biến (VD: TS1A_0001, GLV0_FK2S, RL2A_4BDI)
  if (FIXED_9CHAR_ALIAS_REGEX.test(raw)) {
    const [prefix, _suffix] = raw.split('_');
    const maLopChuanHoa = normalizePrefix4(prefix!);
    const dictItem = CLOUD_CLASS_DICTIONARY[prefix!.toLowerCase()];
    const sector: CloudSector = dictItem ? dictItem.sector : (maLopChuanHoa.startsWith('LM') ? 'LM' : 'TN');
    const aliasChuanHoaDuKien = `${maLopChuanHoa}_${hashSuffix}`;

    return {
      personID: face.personID,
      name: face.name,
      rawAliasID: raw,
      file: fileUrl,
      partsCount: 2,
      nhom1_nganh: sector,
      nhom2_lop: prefix,
      nhom3_id: hashSuffix,
      tenLopTiengViet: dictItem?.label || `Lớp ${maLopChuanHoa}`,
      maLopChuanHoa,
      aliasChuanHoaDuKien,
      departmentID: face.departmentID,
      isError: false,
    };
  }

  const parts = raw.split('_');
  const partsCount = parts.length;

  // Kiểm tra thành phần rỗng giữa các dấu gạch dưới (VD: 'TN__01')
  if (parts.some((p) => p.trim() === '')) {
    return {
      personID: face.personID,
      name: face.name,
      rawAliasID: raw,
      file: fileUrl,
      partsCount,
      isError: true,
      errorCode: 'ERR_EMPTY_SEGMENT',
      errorReason: `Mã aliasID '${raw}' có thành phần bị bỏ trống giữa các dấu gạch dưới`,
    };
  }

  // 2. Trường hợp mã 2 phần (VD: GLV_FK2S, LM_0001)
  if (partsCount === 2) {
    const rawPrefix = parts[0]!.trim();
    const maLopChuanHoa = normalizePrefix4(rawPrefix);
    const dictItem = CLOUD_CLASS_DICTIONARY[rawPrefix.toLowerCase()] || CLOUD_CLASS_DICTIONARY[maLopChuanHoa.toLowerCase()];
    const aliasChuanHoaDuKien = `${maLopChuanHoa}_${hashSuffix}`;
    const sector: CloudSector = dictItem ? dictItem.sector : (maLopChuanHoa.startsWith('LM') ? 'LM' : 'TN');

    return {
      personID: face.personID,
      name: face.name,
      rawAliasID: raw,
      file: fileUrl,
      partsCount,
      nhom1_nganh: sector,
      nhom2_lop: rawPrefix,
      nhom3_id: hashSuffix,
      tenLopTiengViet: dictItem?.label || `Lớp ${maLopChuanHoa}`,
      maLopChuanHoa,
      aliasChuanHoaDuKien,
      departmentID: face.departmentID,
      isError: false,
    };
  }

  // 3. Trường hợp mã 3 phần legacy (VD: TN_XUNGTOI2A_4BDI, TN_Themsuc1a_01, LG_DMHCCC_01)
  if (partsCount === 3) {
    const nhom1 = parts[0]!.trim().toUpperCase();
    const nhom2 = parts[1]!.trim();
    const maLopChuanHoa = normalizePrefix4(nhom2);
    const dictItem = CLOUD_CLASS_DICTIONARY[nhom2.toLowerCase()] || CLOUD_CLASS_DICTIONARY[maLopChuanHoa.toLowerCase()];
    const aliasChuanHoaDuKien = `${maLopChuanHoa}_${hashSuffix}`;
    const sector: CloudSector = dictItem ? dictItem.sector : (nhom1 === 'LM' || nhom1 === 'LG' ? 'LM' : 'TN');

    return {
      personID: face.personID,
      name: face.name,
      rawAliasID: raw,
      file: fileUrl,
      partsCount,
      nhom1_nganh: sector,
      nhom2_lop: nhom2,
      nhom3_id: hashSuffix,
      tenLopTiengViet: dictItem?.label || `Lớp ${maLopChuanHoa}`,
      maLopChuanHoa,
      aliasChuanHoaDuKien,
      departmentID: face.departmentID,
      isError: false,
    };
  }

  // 4. Trường hợp mã 4 phần do thừa dấu gạch dưới (VD: TN_THEMSUC_1C_PG82, TN_THEMSUC_2C_RAUX)
  if (partsCount === 4) {
    const nhom1 = parts[0]!.trim().toUpperCase();
    const joinedMiddle = `${parts[1]!.trim()}${parts[2]!.trim()}`;
    const maLopChuanHoa = normalizePrefix4(joinedMiddle);
    const dictItem = CLOUD_CLASS_DICTIONARY[joinedMiddle.toLowerCase()] || CLOUD_CLASS_DICTIONARY[maLopChuanHoa.toLowerCase()];
    const aliasChuanHoaDuKien = `${maLopChuanHoa}_${hashSuffix}`;
    const sector: CloudSector = dictItem ? dictItem.sector : (nhom1 === 'LM' || nhom1 === 'LG' ? 'LM' : 'TN');

    return {
      personID: face.personID,
      name: face.name,
      rawAliasID: raw,
      file: fileUrl,
      partsCount,
      nhom1_nganh: sector,
      nhom2_lop: joinedMiddle,
      nhom3_id: hashSuffix,
      tenLopTiengViet: dictItem?.label || `Lớp ${maLopChuanHoa}`,
      maLopChuanHoa,
      aliasChuanHoaDuKien,
      departmentID: face.departmentID,
      isError: false,
    };
  }

  // 5. Các định dạng rác hoặc không thể bóc tách
  return {
    personID: face.personID,
    name: face.name,
    rawAliasID: raw,
    file: fileUrl,
    partsCount,
    isError: true,
    errorCode: 'ERR_PARTS_COUNT',
    errorReason: `Không thể chuẩn hóa định dạng '${raw}' về chuẩn 9 ký tự (Regex: ^[A-Za-z]{2}[A-Za-z0-9]{2}_[A-Za-z0-9]{4}$)`,
  };
}
