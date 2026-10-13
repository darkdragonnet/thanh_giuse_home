-- ==============================================================================
-- Migration: 003_snapshot_and_2phase_alias.sql
-- Mục đích:
-- 1. Cho phép alias_id = NULL khi khởi tạo học sinh từ Excel (chưa có person_id)
-- 2. Bổ sung qr_token (16 ký tự URL-safe cố định), cloud_alias_synced, is_updating
-- 3. Tạo bảng nháp staging_cloud_faces phục vụ Snapshot Dump & Set-based SQL Mapping
-- 4. Bổ sung student_id vào logs và admin_requests, bỏ NOT NULL trên admin_requests.alias_id
-- 5. Tạo các chỉ mục tốc độ cao và Partial Index cho retry ngầm
-- ==============================================================================

-- 1. Điều chỉnh bảng students: Cho phép alias_id NULL
ALTER TABLE students
    ALTER COLUMN alias_id DROP NOT NULL;

-- 2. Chiến lược Migration 3 bước an toàn cho cột qr_token
-- Bước 2.1: Thêm cột qr_token cho phép NULL tạm thời
ALTER TABLE students
    ADD COLUMN IF NOT EXISTS qr_token VARCHAR(32);

-- Bước 2.2: Backfill dữ liệu hiện hữu bằng chuỗi 16 ký tự duy nhất
UPDATE students
SET qr_token = SUBSTRING(MD5(RANDOM()::TEXT || id::TEXT || clock_timestamp()::TEXT) FROM 1 FOR 16)
WHERE qr_token IS NULL;

-- Bước 2.3: Ép ràng buộc NOT NULL và UNIQUE
ALTER TABLE students
    ALTER COLUMN qr_token SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'uq_students_qr_token'
  ) THEN
    ALTER TABLE students ADD CONSTRAINT uq_students_qr_token UNIQUE (qr_token);
  END IF;
END $$;

-- 3. Bổ sung cờ trạng thái 2-Phase AliasID và Self-Service Photo Update
ALTER TABLE students
    ADD COLUMN IF NOT EXISTS cloud_alias_synced BOOLEAN DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS is_updating BOOLEAN DEFAULT FALSE;

-- 4. Tạo bảng tạm staging_cloud_faces phục vụ Snapshot Dump 1 lần (7-day cleanup policy)
CREATE TABLE IF NOT EXISTS staging_cloud_faces (
    id SERIAL PRIMARY KEY,
    person_id VARCHAR(100) UNIQUE NOT NULL,
    raw_alias VARCHAR(100) NOT NULL,
    raw_name VARCHAR(255) NOT NULL,
    normalized_name VARCHAR(255) NOT NULL,
    face_url TEXT,
    target_class_code VARCHAR(50),
    target_class_id INT REFERENCES classes(id) ON DELETE SET NULL,
    department_id VARCHAR(50),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_staging_cloud_faces_lookup
    ON staging_cloud_faces(target_class_id, normalized_name);

-- 5. Chuẩn hóa bảng logs & admin_requests (Bổ sung student_id, cho phép alias_id NULL)
ALTER TABLE logs
    ADD COLUMN IF NOT EXISTS student_id INT REFERENCES students(id) ON DELETE SET NULL;

ALTER TABLE admin_requests
    ADD COLUMN IF NOT EXISTS student_id INT REFERENCES students(id) ON DELETE SET NULL,
    ALTER COLUMN alias_id DROP NOT NULL;

-- 6. Đánh Index tối ưu hóa truy vấn cho 2 loại link & Partial Index cho Retry ngầm
CREATE INDEX IF NOT EXISTS idx_students_qr_token ON students(qr_token);
CREATE INDEX IF NOT EXISTS idx_students_class_id_status ON students(class_id, status);
CREATE INDEX IF NOT EXISTS idx_students_alias_id ON students(alias_id);
CREATE INDEX IF NOT EXISTS idx_students_cloud_synced
    ON students(cloud_alias_synced)
    WHERE status = 'success';
CREATE INDEX IF NOT EXISTS idx_logs_student_id ON logs(student_id);
CREATE INDEX IF NOT EXISTS idx_admin_requests_student_id ON admin_requests(student_id);
