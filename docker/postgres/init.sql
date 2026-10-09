-- ==============================================================================
-- KHỞI TẠO CƠ SỞ DỮ LIỆU POSTGRESQL 16
-- Dự án: Hệ thống Onboarding Đăng ký Khuôn mặt Học sinh (HANET Cloud)
-- ==============================================================================

-- 1. Định nghĩa kiểu ENUM trạng thái học sinh
CREATE TYPE student_status AS ENUM (
    'empty',            -- Chưa nộp ảnh
    'pending',          -- Đã nộp ảnh, đang trong hàng đợi BullMQ chờ HANET xử lý
    'success',          -- Đã đăng ký thành công trên HANET Cloud (đã có person_id)
    'error',            -- Lỗi tạm thời (chờ retry)
    'manual_review'     -- Lỗi ảnh/mặt không đạt chuẩn hoặc retry >= 3 (cần admin xử lý thủ công)
);

-- 2. Bảng Lớp học (classes)
CREATE TABLE classes (
    id SERIAL PRIMARY KEY,
    code VARCHAR(50) UNIQUE NOT NULL,           -- Mã lớp (VD: '10A1', '10A2')
    name VARCHAR(100) NOT NULL,                 -- Tên hiển thị (VD: 'Lớp 10A1')
    teacher_name VARCHAR(100),                  -- Tên Giáo viên chủ nhiệm
    token VARCHAR(64) NOT NULL,                 -- Mã PIN giáo viên dùng để Bypass Rate Limit
    is_locked BOOLEAN DEFAULT FALSE,            -- Cờ khóa lớp khi đã hoàn thành hoặc có sự cố
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 3. Bảng Học sinh (students)
CREATE TABLE students (
    id SERIAL PRIMARY KEY,
    class_id INT REFERENCES classes(id) ON DELETE CASCADE,
    name VARCHAR(100) NOT NULL,                 -- Họ và tên học sinh
    alias_id VARCHAR(64) UNIQUE NOT NULL,       -- Mã định danh duy nhất ngẫu nhiên (UUID/NanoID)
    status student_status DEFAULT 'empty',      -- Trạng thái máy trạng thái
    person_id VARCHAR(100),                     -- ID khuôn mặt do HANET Cloud cấp (Source of Truth)
    face_url TEXT,                              -- Đường dẫn ảnh trên CDN của HANET
    local_image_path TEXT,                      -- Đường dẫn ảnh tạm trên Docker Shared Volume
    last_error_code VARCHAR(50),                -- Mã lỗi gần nhất (VD: '-503', 'FACE_NOT_FOUND')
    last_error_message TEXT,                    -- Chi tiết thông báo lỗi từ worker hoặc HANET
    retry_count INT DEFAULT 0,                  -- Số lần đã thử lại
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Tạo Index tối ưu hóa truy vấn thường xuyên
CREATE INDEX idx_students_class_id ON students(class_id);
CREATE INDEX idx_students_status ON students(status);
CREATE INDEX idx_students_alias_id ON students(alias_id);

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

-- 5. Bảng Cấu hình hệ thống (settings - Chốt chặn khẩn cấp Kill Switch)
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
