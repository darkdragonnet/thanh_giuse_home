export interface RawCloudFace {
  personID: string;
  name: string;
  aliasID: string;
  file?: string;
  avatar?: string;
  title?: string;
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
  aliasChuanHoaDuKien?: string;
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
  // Ban Giáo Lý Viên & Lêgiô Mariae
  glv:       { label: 'Ban Giáo Lý Viên', normalizedCode: 'GLV', sector: 'TN' },
  dmhccc:    { label: 'Đức Mẹ Hiệp Công Cứu Chuộc', normalizedCode: 'DMHCCC', sector: 'LM' },

  // Khối Thêm Sức
  themsuc1a: { label: 'Lớp Thêm Sức 1A', normalizedCode: 'TS1A', sector: 'TN' },
  themsuc1b: { label: 'Lớp Thêm Sức 1B', normalizedCode: 'TS1B', sector: 'TN' },
  themsuc1c: { label: 'Lớp Thêm Sức 1C', normalizedCode: 'TS1C', sector: 'TN' },
  themsuc2b: { label: 'Lớp Thêm Sức 2B', normalizedCode: 'TS2B', sector: 'TN' },
  themsuc2c: { label: 'Lớp Thêm Sức 2C', normalizedCode: 'TS2C', sector: 'TN' },

  // Khối Xưng Tội / Rước Lễ (Ánh xạ chuẩn hóa về RL)
  rucle1a:   { label: 'Lớp Rước Lễ 1A',  normalizedCode: 'RL1A', sector: 'TN' },
  rucle1b:   { label: 'Lớp Rước Lễ 1B',  normalizedCode: 'RL1B', sector: 'TN' },
  xungtoi1b: { label: 'Lớp Rước Lễ 1B',  normalizedCode: 'RL1B', sector: 'TN' },
  xungtoi2a: { label: 'Lớp Rước Lễ 2A',  normalizedCode: 'RL2A', sector: 'TN' },
  xungtoi3c: { label: 'Lớp Rước Lễ 3C',  normalizedCode: 'RL3C', sector: 'TN' },

  // Khối Khai Tâm & Bao Đồng & Vào Đời
  khaitam1a: { label: 'Lớp Khai Tâm 1A', normalizedCode: 'KT1A', sector: 'TN' },
  khaitam3:  { label: 'Lớp Khai Tâm 3A', normalizedCode: 'KT3A', sector: 'TN' },
  baodong1a: { label: 'Lớp Bao Đồng 1A', normalizedCode: 'BD1A', sector: 'TN' },
  baodong2a: { label: 'Lớp Bao Đồng 2A', normalizedCode: 'BD2A', sector: 'TN' },
  baodong3:  { label: 'Lớp Bao Đồng 3A', normalizedCode: 'BD3A', sector: 'TN' },
  vaodoi1a:  { label: 'Lớp Vào Đời 1A',  normalizedCode: 'VD1A', sector: 'TN' },
};

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

  const parts = raw.split('_');
  const partsCount = parts.length;

  if (partsCount !== 3) {
    return {
      personID: face.personID,
      name: face.name,
      rawAliasID: raw,
      file: fileUrl,
      partsCount,
      isError: true,
      errorCode: 'ERR_PARTS_COUNT',
      errorReason:
        partsCount < 3
          ? `Thiếu thành phần (Chỉ có ${partsCount} phần, yêu cầu đúng 3: nhóm1_nhóm2_nhóm3)`
          : `Thừa thành phần (${partsCount} phần, vượt quá cấu trúc chuẩn 3 phần)`,
    };
  }

  const nhom1 = parts[0].trim().toUpperCase();
  const nhom2 = parts[1].trim();
  const nhom3 = parts[2].trim();

  // Kiểm tra thành phần rỗng
  if (!nhom2 || !nhom3) {
    return {
      personID: face.personID,
      name: face.name,
      rawAliasID: raw,
      file: fileUrl,
      partsCount,
      isError: true,
      errorCode: 'ERR_EMPTY_SEGMENT',
      errorReason: 'Mã lớp (nhóm2) hoặc mã định danh (nhóm3) bị để trống',
    };
  }

  if (nhom1 !== 'TN' && nhom1 !== 'LG' && nhom1 !== 'LM') {
    return {
      personID: face.personID,
      name: face.name,
      rawAliasID: raw,
      file: fileUrl,
      partsCount,
      isError: true,
      errorCode: 'ERR_INVALID_SECTOR',
      errorReason: `Tiền tố '${nhom1}' không hợp lệ (Chỉ chấp nhận TN, LG hoặc LM)`,
    };
  }

  const dictKey = nhom2.toLowerCase();
  const dictItem = CLOUD_CLASS_DICTIONARY[dictKey];
  if (!dictItem) {
    return {
      personID: face.personID,
      name: face.name,
      rawAliasID: raw,
      file: fileUrl,
      partsCount,
      nhom1_nganh: nhom1 as 'TN' | 'LG' | 'LM',
      nhom2_lop: nhom2,
      nhom3_id: nhom3,
      isError: true,
      errorCode: 'ERR_UNKNOWN_CLASS',
      errorReason: `Mã lớp/ban '${nhom2}' không có trong từ điển quy ước`,
    };
  }

  // Khớp sector: cho phép LM tương đương LG (Lêgiô Mariae)
  const isSectorMatch =
    dictItem.sector === nhom1 ||
    (dictItem.sector === 'LG' && nhom1 === 'LM') ||
    (dictItem.sector === 'LM' && nhom1 === 'LG');

  if (!isSectorMatch) {
    return {
      personID: face.personID,
      name: face.name,
      rawAliasID: raw,
      file: fileUrl,
      partsCount,
      nhom1_nganh: nhom1 as 'TN' | 'LG' | 'LM',
      nhom2_lop: nhom2,
      nhom3_id: nhom3,
      isError: true,
      errorCode: 'ERR_SECTOR_MISMATCH',
      errorReason: `Ngành '${nhom1}' không khớp với nhóm '${nhom2}' (Quy ước thuộc ${dictItem.sector})`,
    };
  }

  const maLopChuanHoa = dictItem.normalizedCode;
  const aliasChuanHoaDuKien = `${maLopChuanHoa}_${nhom3}`;

  return {
    personID: face.personID,
    name: face.name,
    rawAliasID: raw,
    file: fileUrl,
    partsCount,
    nhom1_nganh: nhom1 as 'TN' | 'LG' | 'LM',
    nhom2_lop: nhom2,
    nhom3_id: nhom3,
    tenLopTiengViet: dictItem.label,
    maLopChuanHoa,
    aliasChuanHoaDuKien,
    isError: false,
  };
}
