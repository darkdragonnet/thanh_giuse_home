export type StudentStatus = 'empty' | 'pending' | 'success' | 'error' | 'manual_review';

export interface ClassEntity {
  id: number;
  code: string;
  name: string;
  teacher_name?: string;
  token: string;
  is_locked: boolean;
  created_at: Date;
}

export interface StudentEntity {
  id: number;
  class_id: number;
  name: string;
  alias_id: string;
  status: StudentStatus;
  person_id?: string | null;
  face_url?: string | null;
  local_image_path?: string | null;
  last_error_code?: string | null;
  last_error_message?: string | null;
  retry_count: number;
  created_at: Date;
  updated_at: Date;
}

export interface RegistrationJobData {
  studentId: number;
  aliasId: string;
  studentName: string;
  classCode: string;
  tempFilename: string;
  uploadedAt: number;
}
