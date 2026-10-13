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

-- 3. Bổ sung cờ trạng thái 2-Phase AliasID, Self-Service Photo Update và normalized_name
ALTER TABLE students
    ADD COLUMN IF NOT EXISTS normalized_name VARCHAR(255),
    ADD COLUMN IF NOT EXISTS cloud_alias_synced BOOLEAN DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS is_updating BOOLEAN DEFAULT FALSE;

-- 4. Tạo bảng tạm staging_cloud_faces phục vụ Snapshot Dump 1 lần (7-day cleanup policy)
CREATE TABLE IF NOT EXISTS staging_cloud_faces (
    id SERIAL PRIMARY KEY,
    person_id VARCHAR(100) UNIQUE NOT NULL,
    raw_alias VARCHAR(100) NOT NULL,
    full_name VARCHAR(255),
    raw_name VARCHAR(255),
    normalized_name VARCHAR(255) NOT NULL,
    face_url TEXT,
    target_class_code VARCHAR(50),
    target_class_id INT REFERENCES classes(id) ON DELETE SET NULL,
    department_id VARCHAR(50),
    is_matched BOOLEAN DEFAULT FALSE,
    matched_student_id INT REFERENCES students(id) ON DELETE SET NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

ALTER TABLE staging_cloud_faces
    ADD COLUMN IF NOT EXISTS full_name VARCHAR(255),
    ADD COLUMN IF NOT EXISTS raw_name VARCHAR(255),
    ADD COLUMN IF NOT EXISTS is_matched BOOLEAN DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS matched_student_id INT REFERENCES students(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_staging_cloud_faces_lookup
    ON staging_cloud_faces(target_class_id, normalized_name);

-- 5. Tự phục hồi (Self-healing) bảng admin_requests, sync_conflicts và classes.department_code nếu VPS chưa chạy migration trước đó
ALTER TABLE classes
    ADD COLUMN IF NOT EXISTS department_code VARCHAR(20) DEFAULT '';

CREATE TABLE IF NOT EXISTS sync_conflicts (
    id SERIAL PRIMARY KEY,
    student_id INT REFERENCES students(id) ON DELETE SET NULL,
    alias_id VARCHAR(100) NOT NULL,
    cloud_person_id VARCHAR(100),
    cloud_alias_id VARCHAR(100),
    cloud_name VARCHAR(255),
    cloud_face_url TEXT,
    conflict_type VARCHAR(50) NOT NULL,
    status VARCHAR(50) DEFAULT 'pending_review',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    resolved_at TIMESTAMP WITH TIME ZONE
);

DO $$ 
BEGIN 
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'admin_request_status') THEN
    CREATE TYPE admin_request_status AS ENUM ('new', 'processing', 'done');
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS admin_requests (
    id SERIAL PRIMARY KEY,
    student_id INT REFERENCES students(id) ON DELETE SET NULL,
    alias_id VARCHAR(64),
    class_id INT REFERENCES classes(id) ON DELETE CASCADE,
    student_name VARCHAR(100),
    image_path TEXT NOT NULL,
    note TEXT,
    status admin_request_status DEFAULT 'new',
    ip VARCHAR(45),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Chuẩn hóa bảng logs & admin_requests (Bổ sung student_id, cho phép alias_id NULL)
ALTER TABLE logs
    ADD COLUMN IF NOT EXISTS student_id INT REFERENCES students(id) ON DELETE SET NULL;

ALTER TABLE admin_requests
    ADD COLUMN IF NOT EXISTS student_id INT REFERENCES students(id) ON DELETE SET NULL,
    ALTER COLUMN alias_id DROP NOT NULL;

-- 6. Đánh Index tối ưu hóa truy vấn cho 2 loại link & Partial Index cho Retry ngầm
CREATE INDEX IF NOT EXISTS idx_students_qr_token ON students(qr_token);
CREATE INDEX IF NOT EXISTS idx_students_class_id_status ON students(class_id, status);
CREATE INDEX IF NOT EXISTS idx_students_alias_id ON students(alias_id);
CREATE INDEX IF NOT EXISTS idx_students_normalized_name ON students(class_id, normalized_name);
CREATE INDEX IF NOT EXISTS idx_students_cloud_synced
    ON students(cloud_alias_synced)
    WHERE status = 'success';
CREATE INDEX IF NOT EXISTS idx_logs_student_id ON logs(student_id);
CREATE INDEX IF NOT EXISTS idx_admin_requests_student_id ON admin_requests(student_id);
CREATE INDEX IF NOT EXISTS idx_admin_requests_status ON admin_requests(status);
CREATE INDEX IF NOT EXISTS idx_admin_requests_alias ON admin_requests(alias_id);
CREATE INDEX IF NOT EXISTS idx_sync_conflicts_alias ON sync_conflicts(alias_id);


