export type AdminRequestStatus = 'new' | 'processing' | 'done';

export interface AdminRequest {
  id: number;
  student_id?: number | null;
  alias_id: string | null;
  class_id?: number;
  student_name?: string;
  image_path: string;
  note?: string;
  status: AdminRequestStatus;
  ip?: string;
  created_at: string;
  updated_at: string;
}

export interface CreateAdminRequestDto {
  student_id?: number | null | undefined;
  alias_id?: string | null | undefined;
  class_id?: number | null | undefined;
  student_name?: string | null | undefined;
  image_path: string;
  note?: string | null | undefined;
  ip?: string | null | undefined;
}
