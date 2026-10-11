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

  // 1. Trường hợp đã chuẩn 9 ký tự bất biến (VD: TS1A_0001, GLV0_FK2S, RL2A_4BDI)
  if (FIXED_9CHAR_ALIAS_REGEX.test(raw)) {
    const [prefix, suffix] = raw.split('_');
    const dictItem = CLOUD_CLASS_DICTIONARY[prefix!.toLowerCase()];
    const sector: CloudSector = dictItem ? dictItem.sector : (prefix!.startsWith('LM') ? 'LM' : 'TN');

    return {
      personID: face.personID,
      name: face.name,
      rawAliasID: raw,
      file: fileUrl,
      partsCount: 2,
      nhom1_nganh: sector,
      nhom2_lop: prefix,
      nhom3_id: suffix,
      tenLopTiengViet: dictItem?.label || `Lớp ${prefix}`,
      maLopChuanHoa: prefix!.toUpperCase(),
      aliasChuanHoaDuKien: raw,
      departmentID: face.departmentID,
      isError: false,
    };
  }

  const parts = raw.split('_');
  const partsCount = parts.length;

  // 2. Trường hợp mã 2 phần (VD: GLV_FK2S, LM_0001) -> Tự động đệm tiền tố thành 4 ký tự (GLV -> GLV0)
  if (partsCount === 2) {
    const rawPrefix = parts[0]!.trim();
    const rawSuffix = parts[1]!.trim().toUpperCase();

    let paddedPrefix = rawPrefix.toUpperCase();
    if (paddedPrefix.length === 2) {
      paddedPrefix = `${paddedPrefix}01`;
    } else if (paddedPrefix.length === 3) {
      paddedPrefix = `${paddedPrefix}0`;
    } else if (paddedPrefix.length > 4) {
      paddedPrefix = paddedPrefix.substring(0, 4);
    }

    const dictItem = CLOUD_CLASS_DICTIONARY[rawPrefix.toLowerCase()] || CLOUD_CLASS_DICTIONARY[paddedPrefix.toLowerCase()];
    const finalPrefix = dictItem?.normalizedCode || paddedPrefix;
    const finalSuffix = rawSuffix.length >= 4 ? rawSuffix.substring(0, 4) : rawSuffix.padStart(4, '0');
    const aliasChuanHoaDuKien = `${finalPrefix}_${finalSuffix}`;

    const sector: CloudSector = dictItem ? dictItem.sector : (finalPrefix.startsWith('LM') ? 'LM' : 'TN');

    return {
      personID: face.personID,
      name: face.name,
      rawAliasID: raw,
      file: fileUrl,
      partsCount,
      nhom1_nganh: sector,
      nhom2_lop: rawPrefix,
      nhom3_id: rawSuffix,
      tenLopTiengViet: dictItem?.label || `Lớp ${finalPrefix}`,
      maLopChuanHoa: finalPrefix,
      aliasChuanHoaDuKien,
      departmentID: face.departmentID,
      isError: false,
    };
  }

  // 3. Trường hợp mã 3 phần legacy (VD: TN_XUNGTOI2A_4BDI, TN_Themsuc1a_01, LG_DMHCCC_01)
  if (partsCount === 3) {
    const nhom1 = parts[0]!.trim().toUpperCase();
    const nhom2 = parts[1]!.trim();
    const nhom3 = parts[2]!.trim().toUpperCase();

    const dictItem = CLOUD_CLASS_DICTIONARY[nhom2.toLowerCase()];
    let maLopChuanHoa = dictItem ? dictItem.normalizedCode : nhom2.toUpperCase();
    if (maLopChuanHoa.length === 3) maLopChuanHoa = `${maLopChuanHoa}0`;
    else if (maLopChuanHoa.length === 2) maLopChuanHoa = `${maLopChuanHoa}01`;
    else if (maLopChuanHoa.length > 4) maLopChuanHoa = maLopChuanHoa.substring(0, 4);

    const finalSuffix = nhom3.length >= 4 ? nhom3.substring(0, 4) : nhom3.padStart(4, '0');
    const aliasChuanHoaDuKien = `${maLopChuanHoa}_${finalSuffix}`;
    const sector: CloudSector = dictItem ? dictItem.sector : (nhom1 === 'LM' || nhom1 === 'LG' ? 'LM' : 'TN');

    return {
      personID: face.personID,
      name: face.name,
      rawAliasID: raw,
      file: fileUrl,
      partsCount,
      nhom1_nganh: sector,
      nhom2_lop: nhom2,
      nhom3_id: nhom3,
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
    const nhom3 = parts[3]!.trim().toUpperCase();

    const dictItem = CLOUD_CLASS_DICTIONARY[joinedMiddle.toLowerCase()];
    let maLopChuanHoa = dictItem ? dictItem.normalizedCode : joinedMiddle.toUpperCase();
    if (maLopChuanHoa.length === 3) maLopChuanHoa = `${maLopChuanHoa}0`;
    else if (maLopChuanHoa.length === 2) maLopChuanHoa = `${maLopChuanHoa}01`;
    else if (maLopChuanHoa.length > 4) maLopChuanHoa = maLopChuanHoa.substring(0, 4);

    const finalSuffix = nhom3.length >= 4 ? nhom3.substring(0, 4) : nhom3.padStart(4, '0');
    const aliasChuanHoaDuKien = `${maLopChuanHoa}_${finalSuffix}`;
    const sector: CloudSector = dictItem ? dictItem.sector : (nhom1 === 'LM' || nhom1 === 'LG' ? 'LM' : 'TN');

    return {
      personID: face.personID,
      name: face.name,
      rawAliasID: raw,
      file: fileUrl,
      partsCount,
      nhom1_nganh: sector,
      nhom2_lop: joinedMiddle,
      nhom3_id: nhom3,
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
