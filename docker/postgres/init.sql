-- ==============================================================================
-- KHỞI TẠO CƠ SỞ DỮ LIỆU POSTGRESQL 16
-- Dự án: Hệ thống Onboarding Đăng ký Khuôn mặt Học sinh (HANET Cloud)
-- ==============================================================================

-- 1. Định nghĩa kiểu ENUM trạng thái học sinh
DO $$ 
BEGIN 
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'student_status') THEN
    CREATE TYPE student_status AS ENUM (
      'empty',
      'pending',
      'success',
      'conflict_pending_review',
      'failed_quota_exceeded',
      'manual_review',
      'error',
      'synced'
    );
  ELSE
    ALTER TYPE student_status ADD VALUE IF NOT EXISTS 'manual_review';
    ALTER TYPE student_status ADD VALUE IF NOT EXISTS 'conflict_pending_review';
    ALTER TYPE student_status ADD VALUE IF NOT EXISTS 'failed_quota_exceeded';
    ALTER TYPE student_status ADD VALUE IF NOT EXISTS 'synced';
  END IF;
END $$;

-- 2. Bảng Lớp học (classes)
CREATE TABLE IF NOT EXISTS classes (
    id SERIAL PRIMARY KEY,
    code VARCHAR(50) UNIQUE NOT NULL,           -- Mã lớp (VD: 'GLV', 'TS1A')
    name VARCHAR(255) NOT NULL,                 -- Tên hiển thị
    department_code VARCHAR(20) DEFAULT '',     -- Mã phòng ban
    teacher_name VARCHAR(100),                  -- Tên Giáo viên chủ nhiệm
    token VARCHAR(100) NOT NULL,                -- Mã PIN giáo viên dùng để Bypass Rate Limit
    is_locked BOOLEAN DEFAULT FALSE,            -- Cờ khóa lớp khi đã hoàn thành hoặc có sự cố
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 3. Bảng Học sinh (students)
CREATE TABLE IF NOT EXISTS students (
    id SERIAL PRIMARY KEY,
    class_id INT REFERENCES classes(id) ON DELETE SET NULL, -- Cho phép NULL khi chưa map được prefix
    name VARCHAR(255) NOT NULL,                 -- Họ và tên học sinh
    alias_id VARCHAR(100) UNIQUE NOT NULL,      -- Mã định danh duy nhất ngẫu nhiên
    status student_status DEFAULT 'empty',      -- Trạng thái máy trạng thái
    person_id VARCHAR(100) UNIQUE,              -- ID khuôn mặt do HANET Cloud cấp (Source of Truth)
    face_url TEXT,                              -- Đường dẫn ảnh trên CDN của HANET
    local_image_path TEXT,                      -- Đường dẫn ảnh tạm trên Docker Shared Volume
    last_error_code VARCHAR(50) DEFAULT NULL,   -- Mã lỗi gần nhất (VD: '-503', '-9008')
    last_error_message TEXT DEFAULT NULL,       -- Chi tiết thông báo lỗi từ worker hoặc HANET
    retry_count INT DEFAULT 0,                  -- Số lần đã thử lại
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Bảng đối soát xung đột đồng bộ (sync_conflicts)
CREATE TABLE IF NOT EXISTS sync_conflicts (
    id SERIAL PRIMARY KEY,
    alias_id VARCHAR(100) NOT NULL,
    cloud_person_id VARCHAR(100),
    cloud_alias_id VARCHAR(100),
    cloud_name VARCHAR(255),
    cloud_face_url TEXT,
    conflict_type VARCHAR(50) NOT NULL,         -- 'UNMAPPED_CLASS_PREFIX', 'DUPLICATE_FACE', etc.
    status VARCHAR(50) DEFAULT 'pending_review',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    resolved_at TIMESTAMP WITH TIME ZONE
);

-- Tạo Index tối ưu hóa truy vấn thường xuyên
CREATE INDEX IF NOT EXISTS idx_students_class_id ON students(class_id);
CREATE INDEX IF NOT EXISTS idx_students_status ON students(status);
CREATE INDEX IF NOT EXISTS idx_students_alias_id ON students(alias_id);
CREATE INDEX IF NOT EXISTS idx_sync_conflicts_alias ON sync_conflicts(alias_id);

-- 4. Bảng Nhật ký hoạt động (logs)
CREATE TABLE logs (
    id BIGSERIAL PRIMARY KEY,
    alias_id VARCHAR(64),
    class_id INT,
    action VARCHAR(50) NOT NULL,                -- REGISTER, UPDATE_PHOTO, RETRY, MANUAL_OVERRIDE
    result_code VARCHAR(50),                    -- SUCCESS, ERROR, REJECTED
    result_message TEXT,
    ip VARCHAR(45),                             -- Địa chỉ IP của client (IPv4/IPv6)
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX idx_logs_alias_id ON logs(alias_id);
CREATE INDEX idx_logs_created_at ON logs(created_at DESC);

-- 5. Bảng Yêu cầu hỗ trợ Admin (admin_requests)
DO $$ 
BEGIN 
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'admin_request_status') THEN
    CREATE TYPE admin_request_status AS ENUM ('new', 'processing', 'done');
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS admin_requests (
    id SERIAL PRIMARY KEY,
    alias_id VARCHAR(64) NOT NULL,
    class_id INT REFERENCES classes(id) ON DELETE CASCADE,
    student_name VARCHAR(100),
    image_path TEXT NOT NULL,
    note TEXT,
    status admin_request_status DEFAULT 'new',
    ip VARCHAR(45),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_admin_requests_status ON admin_requests(status);
CREATE INDEX IF NOT EXISTS idx_admin_requests_alias ON admin_requests(alias_id);

-- 6. Bảng Cấu hình hệ thống (settings - Chốt chặn khẩn cấp Kill Switch)
CREATE TABLE settings (
    key VARCHAR(50) PRIMARY KEY,
    value TEXT NOT NULL
);

-- ==============================================================================
-- NẠP DỮ LIỆU MẪU BAN ĐẦU (SEED DATA KIỂM THỬ)
-- ==============================================================================

-- Cấu hình toàn cục: Bật tính năng đăng ký
INSERT INTO settings (key, value) VALUES
    ('registration_enabled', 'true'),
    ('max_daily_capacity', '1200'),
    ('maintenance_mode', 'false');

-- Khởi tạo 2 Lớp học mẫu
INSERT INTO classes (code, name, teacher_name, token, is_locked) VALUES
    ('10A1', 'Lớp 10A1 - Chuyên Toán', 'Thầy Nguyễn Văn An', 'PIN_10A1_SECRET_789', FALSE),
    ('10A2', 'Lớp 10A2 - Chuyên Lý', 'Cô Trần Thị Bình', 'PIN_10A2_SECRET_456', FALSE);

-- Khởi tạo 5 Học sinh mẫu (Trạng thái ban đầu: 'empty')
INSERT INTO students (class_id, name, alias_id, status) VALUES
    (1, 'Nguyễn Hoàng Long', 'STU_10A1_001_A7B2C', 'empty'),
    (1, 'Trần Minh Quân', 'STU_10A1_002_D4E5F', 'empty'),
    (1, 'Lê Thị Thu Thảo', 'STU_10A1_003_G8H9J', 'empty'),
    (2, 'Phạm Đức Trọng', 'STU_10A2_001_K1L2M', 'empty'),
    (2, 'Vũ Mai Phương', 'STU_10A2_002_N3P4Q', 'empty');

SELECT setval('classes_id_seq', COALESCE((SELECT MAX(id) FROM classes), 1));
SELECT setval('students_id_seq', COALESCE((SELECT MAX(id) FROM students), 1));

