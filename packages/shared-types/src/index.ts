export type StudentStatus =
  | 'empty'
  | 'pending'
  | 'success'
  | 'conflict_pending_review'
  | 'failed_quota_exceeded'
  | 'manual_review'
  | 'error'
  | 'synced';

export interface SyncConflictEntity {
  id: number;
  student_id: number;
  alias_id: string;
  cloud_person_id?: string | null;
  cloud_alias_id?: string | null;
  cloud_name?: string | null;
  cloud_face_url?: string | null;
  conflict_type: string;
  status: string;
  created_at: Date;
  updated_at: Date;
}

export interface ClassEntity {
  id: number;
  code: string;
  name: string;
  teacher_name?: string;
  token: string;
  is_locked: boolean;
  created_at: Date;
}

export interface CreateClassInput {
  code: string;
  name: string;
  teacher_name?: string | null;
  token?: string;
}

export interface CreateClassResponse {
  success: boolean;
  message?: string;
  data?: ClassEntity;
}

export interface StudentEntity {
  id: number;
  class_id: number;
  name: string;
  qr_token: string;
  alias_id: string | null;
  status: StudentStatus;
  person_id?: string | null;
  face_url?: string | null;
  local_image_path?: string | null;
  cloud_alias_synced?: boolean;
  is_updating?: boolean;
  last_error_code?: string | null;
  last_error_message?: string | null;
  retry_count: number;
  created_at: Date;
  updated_at: Date;
}

export interface CreateStudentInput {
  name: string;
}

export interface BulkCreateStudentsInput {
  names: string[];
}

export interface UpdateStudentInput {
  name: string;
}

export interface RegistrationJobData {
  studentId: number;
  aliasId: string | null;
  qrToken?: string;
  studentName: string;
  classCode: string;
  departmentId?: string | number;
  tempFilename: string;
  uploadedAt: number;
  faceImageUrl?: string;
}


// ══════════════════════════════════════════════════════════════
// HANET INTEGRATION TYPES
// ══════════════════════════════════════════════════════════════

/**
 * Mã lỗi chuẩn của HANET Cloud API.
 * Nguồn: docs/hanet-errors.md
 */
export type HanetReturnCode =
  | 1
  | -1
  | -103
  | -2035
  | -404
  | -503
  | -909
  | -9002
  | -9003
  | -9004
  | -9005
  | -9006
  | -9007
  | -9008
  | -5001
  | -5002
  | -5003
  | -5011;

/**
 * Response chuẩn HANET.
 * Lưu ý: HANET luôn trả HTTP 200, kể cả khi returnCode < 0.
 */
export interface HanetResponse<T = unknown> {
  statusCode?: number;
  returnCode: HanetReturnCode;
  returnMessage: string;
  data?: T;
}

/**
 * Person object do HANET trả về sau khi đăng ký thành công.
 */
export interface HanetPerson {
  personID: string;
  aliasID: string;
  name: string;
  file: string;
  title?: string;
}

// ══════════════════════════════════════════════════════════════
// MOCK SCENARIOS (dùng cho HANET Mock Server)
// ══════════════════════════════════════════════════════════════

/**
 * Các scenario mà HANET Mock Server có thể giả lập.
 * Nguồn: apps/hanet-mock/docs/scenarios.md
 */
export type MockScenario =
  | 'success'
  | '-503'
  | '-103'
  | '-9006'
  | '-9007'
  | '-9008'
  | '-5011'
  | '-909'
  | 'slow'
  | 'timeout';

// ══════════════════════════════════════════════════════════════
// ERROR MAPPING
// ══════════════════════════════════════════════════════════════

/**
 * Hành động tiếp theo mà Worker cần làm khi gặp lỗi HANET.
 */
export type ErrorNextAction =
  | 'retry'
  | 'manual_review'
  | 'alert_admin'
  | 'refresh_token'
  | 'switch_to_update';

/**
 * Mapping mã lỗi HANET → thông báo + hành động.
 * Dùng cho package error-mapping.
 */
export interface ErrorMapping {
  userMessage: string;
  adminMessage: string;
  retryable: boolean;
  nextAction: ErrorNextAction;
}

// ══════════════════════════════════════════════════════════════
// WORKER JOB TYPES (mở rộng)
// ══════════════════════════════════════════════════════════════

/**
 * Loại action mà job có thể thực hiện.
 * - REGISTER: đăng ký lần đầu (gọi registerByUrl)
 * - UPDATE_PHOTO: cập nhật ảnh cho personID đã có (gọi updateByFaceImageByPersonID)
 */
export type JobActionType = 'REGISTER' | 'UPDATE_PHOTO';

/**
 * Extended RegistrationJobData cho admin override ảnh.
 * Kế thừa RegistrationJobData, thêm 2 field optional.
 */
export interface RegistrationJobDataExtended extends RegistrationJobData {
  actionType?: JobActionType;
  personId?: string;
}

// ══════════════════════════════════════════════════════════════
// ADMIN REQUESTS
// ══════════════════════════════════════════════════════════════
export * from './types/admin-request.js';
export * from './types/student.js';

// ══════════════════════════════════════════════════════════════
// CATECHISM & PARISH UNITS CONSTANTS
// ══════════════════════════════════════════════════════════════
export const CATECHISM_GROUPS = [
  { code: 'KT', name: 'Khai Tâm' },
  { code: 'RL', name: 'Rước Lễ' },
  { code: 'TS', name: 'Thêm Sức' },
  { code: 'BD', name: 'Bao Đồng' },
  { code: 'VD', name: 'Vào Đời' },
] as const;

export const SPECIAL_UNITS = [
  { code: 'GLV', name: 'Ban Giáo Lý Viên' },
  { code: 'LS', name: 'Ban Lễ Sinh' },
  { code: 'CD', name: 'Ca Đoàn Cecilia' },
  { code: 'TRE', name: 'Giới Trẻ Giáo Xứ' },
  { code: 'GT', name: 'Giới Gia Trưởng' },
  { code: 'HM', name: 'Giới Hiền Mẫu' },
  { code: 'HDMV', name: 'Hội Đồng Mục Vụ' },
] as const;

// ══════════════════════════════════════════════════════════════
// HANET CLOUD FACE PARSER & CLASSIFIER
// ══════════════════════════════════════════════════════════════
export * from './hanet-cloud.js';

