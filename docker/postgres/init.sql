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
    normalized_name VARCHAR(255),               -- Họ tên chuẩn hóa chữ thường không dấu phục vụ đối soát
    qr_token VARCHAR(32) UNIQUE NOT NULL,       -- Chuỗi định danh cố định 16 ký tự URL-safe
    alias_id VARCHAR(100) UNIQUE,               -- Cho phép NULL khi khởi tạo từ Excel; chuẩn 9 ký tự khi có person_id
    status student_status DEFAULT 'empty',      -- Trạng thái máy trạng thái
    person_id VARCHAR(100) UNIQUE,              -- ID khuôn mặt do HANET Cloud cấp (Source of Truth)
    face_url TEXT,                              -- Đường dẫn ảnh trên CDN của HANET
    local_image_path TEXT,                      -- Đường dẫn ảnh tạm trên Docker Shared Volume
    cloud_alias_synced BOOLEAN DEFAULT FALSE,   -- Cờ đồng bộ alias_id chuẩn 9 ký tự lên HANET Cloud
    is_updating BOOLEAN DEFAULT FALSE,          -- Cờ đang cập nhật ảnh mới ở kênh /u/:qr_token
    last_error_code VARCHAR(50) DEFAULT NULL,   -- Mã lỗi gần nhất (VD: '-503', '-9008')
    last_error_message TEXT DEFAULT NULL,       -- Chi tiết thông báo lỗi từ worker hoặc HANET
    retry_count INT DEFAULT 0,                  -- Số lần đã thử lại
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Bảng nháp lưu trữ Snapshot 1 lần từ HANET Cloud (staging_cloud_faces)
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


-- Bảng đối soát xung đột đồng bộ (sync_conflicts)
CREATE TABLE IF NOT EXISTS sync_conflicts (
    id SERIAL PRIMARY KEY,
    student_id INT REFERENCES students(id) ON DELETE SET NULL,
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
CREATE INDEX IF NOT EXISTS idx_students_class_id_status ON students(class_id, status);
CREATE INDEX IF NOT EXISTS idx_students_qr_token ON students(qr_token);
CREATE INDEX IF NOT EXISTS idx_students_alias_id ON students(alias_id);
CREATE INDEX IF NOT EXISTS idx_students_cloud_synced ON students(cloud_alias_synced) WHERE status = 'success';
CREATE INDEX IF NOT EXISTS idx_staging_cloud_faces_lookup ON staging_cloud_faces(target_class_id, normalized_name);
CREATE INDEX IF NOT EXISTS idx_sync_conflicts_alias ON sync_conflicts(alias_id);

-- 4. Bảng Nhật ký hoạt động (logs)
CREATE TABLE IF NOT EXISTS logs (
    id BIGSERIAL PRIMARY KEY,
    student_id INT REFERENCES students(id) ON DELETE SET NULL,
    alias_id VARCHAR(64),
    class_id INT,
    action VARCHAR(50) NOT NULL,                -- REGISTER, UPDATE_PHOTO, RETRY, MANUAL_OVERRIDE
    result_code VARCHAR(50),                    -- SUCCESS, ERROR, REJECTED
    result_message TEXT,
    ip VARCHAR(45),                             -- Địa chỉ IP của client (IPv4/IPv6)
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_logs_student_id ON logs(student_id);
CREATE INDEX IF NOT EXISTS idx_logs_alias_id ON logs(alias_id);
CREATE INDEX IF NOT EXISTS idx_logs_created_at ON logs(created_at DESC);

-- 5. Bảng Yêu cầu hỗ trợ Admin (admin_requests)
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

CREATE INDEX IF NOT EXISTS idx_admin_requests_student_id ON admin_requests(student_id);
CREATE INDEX IF NOT EXISTS idx_admin_requests_status ON admin_requests(status);
CREATE INDEX IF NOT EXISTS idx_admin_requests_alias ON admin_requests(alias_id);

-- 6. Bảng Cấu hình hệ thống (settings - Chốt chặn khẩn cấp Kill Switch & Rate Limit)
CREATE TABLE IF NOT EXISTS settings (
    key VARCHAR(50) PRIMARY KEY,
    value TEXT NOT NULL
);

-- ==============================================================================
-- CẤU HÌNH HỆ THỐNG MẶC ĐỊNH (IDEMPOTENT INITIALIZATION)
-- ==============================================================================

-- Cấu hình toàn cục: Bật tính năng đăng ký và nhịp đồng bộ HANET Cloud
INSERT INTO settings (key, value) VALUES
    ('registration_enabled', 'true'),
    ('max_daily_capacity', '1200'),
    ('maintenance_mode', 'false'),
    ('hanet_sync_rate_limit', '1')
ON CONFLICT (key) DO NOTHING;

-- GHI CHÚ QUAN TRỌNG:
-- Dữ liệu mẫu (classes, students) đã được tách sang file: docker/postgres/seed-dev.sql
-- TUYỆT ĐỐI không chèn dữ liệu seed mẫu vào init.sql để bảo vệ an toàn cho CSDL vận hành.


-- ==============================================================================
-- HỆ THỐNG BỎ PHIẾU BAN ĐẠI DIỆN GIA TRƯỞNG (SCHEMA RIÊNG BIỆT: giatruong)
-- ==============================================================================
CREATE SCHEMA IF NOT EXISTS giatruong;

CREATE TABLE IF NOT EXISTS giatruong.settings (
    key VARCHAR(50) PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO giatruong.settings (key, value) VALUES
    ('voting_status', 'closed'),
    ('real_duration_minutes', '8'),
    ('trial_duration_minutes', '4'),
    ('max_picks', '8'),
    ('admin_secret_token', 'admin_secret_giatruong_2026')
ON CONFLICT (key) DO NOTHING;

CREATE TABLE IF NOT EXISTS giatruong.candidates (
    id SERIAL PRIMARY KEY,
    name VARCHAR(100) NOT NULL,
    clean_name VARCHAR(100) UNIQUE NOT NULL,
    is_incumbent BOOLEAN DEFAULT FALSE,
    is_active BOOLEAN DEFAULT TRUE,
    display_order DOUBLE PRECISION DEFAULT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_giatruong_candidates_active ON giatruong.candidates(is_active);
CREATE INDEX IF NOT EXISTS idx_giatruong_candidates_order ON giatruong.candidates(display_order);

INSERT INTO giatruong.candidates (name, clean_name, is_incumbent, is_active, display_order) VALUES
  ('Gioan Baotixita Trần Tứ Hạnh', 'gioan baotixita tran tu hanh', TRUE, TRUE, random()),
  ('Gioakim Phạm Hữu Long', 'gioakim pham huu long', FALSE, TRUE, NULL),
  ('Micae Vũ Văn Trung', 'micae vu van trung', FALSE, TRUE, NULL),
  ('Giuse Tô Huy Cường', 'giuse to huy cuong', FALSE, TRUE, NULL),
  ('Phaolô Nguyễn Văn Trường', 'phaolo nguyen van truong', FALSE, TRUE, NULL),
  ('Gioan Baotixita Dương Văn Quảng', 'gioan baotixita duong van quang', FALSE, TRUE, NULL),
  ('Giuse Nguyễn Tuấn Tài', 'giuse nguyen tuan tai', FALSE, TRUE, NULL),
  ('Giuse Trần Văn Điệp', 'giuse tran van diep', FALSE, TRUE, NULL),
  ('Martinô Bùi Phước Tùng', 'martino bui phuoc tung', FALSE, TRUE, NULL),
  ('Phêrô Trần Như Cường', 'phero tran nhu cuong', FALSE, TRUE, NULL),
  ('Giuse Nguyễn Anh Tuấn', 'giuse nguyen anh tuan', FALSE, TRUE, NULL),
  ('Phêrô Trịnh Văn Đoan', 'phero trinh van doan', FALSE, TRUE, NULL),
  ('Giuse Trần Như Khoa', 'giuse tran nhu khoa', FALSE, TRUE, random()),
  ('Antôn Trương Văn Quang', 'anton truong van quang', TRUE, TRUE, NULL),
  ('Giuse Nguyễn Văn Quảng', 'giuse nguyen van quang', FALSE, TRUE, NULL),
  ('Phêrô Phaolô Nguyễn Tiến Trung', 'phero phaolo nguyen tien trung', FALSE, TRUE, NULL),
  ('Phêrô Phạm Văn Thông', 'phero pham van thong', FALSE, TRUE, random()),
  ('Giuse Nguyễn Duy Trực', 'giuse nguyen duy truc', FALSE, TRUE, random()),
  ('Đaminh Hoàng Anh Thủy', 'daminh hoang anh thuy', TRUE, TRUE, random()),
  ('Phêrô Nguyễn Văn Phương', 'phero nguyen van phuong', FALSE, TRUE, random()),
  ('Phêrô Phạm Văn Hiếu', 'phero pham van hieu', FALSE, TRUE, NULL),
  ('Giuse Trần Xuân Hiệp', 'giuse tran xuan hiep', FALSE, TRUE, NULL),
  ('Giuse Lê Văn Đảo', 'giuse le van dao', FALSE, TRUE, NULL),
  ('Phaolô Phạm Thanh Bình', 'phaolo pham thanh binh', FALSE, TRUE, NULL),
  ('Giuse Nguyễn Viết Quân', 'giuse nguyen viet quan', FALSE, TRUE, NULL),
  ('Phêrô Huỳnh Văn Đang', 'phero huynh van dang', TRUE, TRUE, random()),
  ('Antôn Lê Danh Thống', 'anton le danh thong', FALSE, TRUE, NULL),
  ('Lorenxô Phạm Văn Tú', 'lorenxo pham van tu', FALSE, TRUE, NULL),
  ('Vicentê Nguyễn Văn Hoan', 'vicente nguyen van hoan', FALSE, TRUE, NULL),
  ('Giuse Nguyễn Văn Cao', 'giuse nguyen van cao', FALSE, TRUE, NULL),
  ('Phanxicô Trần Minh Duy Thiện', 'phanxico tran minh duy thien', FALSE, TRUE, NULL),
  ('Phêrô Tạ Ngọc San', 'phero ta ngoc san', FALSE, TRUE, NULL),
  ('Giuse Phạm Văn Tấn', 'giuse pham van tan', FALSE, TRUE, NULL),
  ('Giuse Phạm Văn Khánh', 'giuse pham van khanh', FALSE, TRUE, NULL),
  ('Giuse Lê Quốc Dũng', 'giuse le quoc dung', FALSE, TRUE, NULL),
  ('Phêrô Nguyễn Văn Hai', 'phero nguyen van hai', FALSE, TRUE, NULL),
  ('Giuse Trần Công Đính', 'giuse tran cong dinh', FALSE, TRUE, NULL),
  ('Phaolo Nguyễn Văn Thành', 'phaolo nguyen van thanh', FALSE, TRUE, random()),
  ('Augustinô Ngô Văn Xuân', 'augustino ngo van xuan', TRUE, TRUE, NULL),
  ('Phêrô Phạm Văn Uy', 'phero pham van uy', TRUE, TRUE, NULL),
  ('Phêrô Nguyễn Văn Khoa', 'phero nguyen van khoa', TRUE, TRUE, NULL)
ON CONFLICT (clean_name) DO UPDATE
SET name = EXCLUDED.name,
    is_incumbent = EXCLUDED.is_incumbent,
    display_order = EXCLUDED.display_order,
    is_active = TRUE;



-- 3. Bảng Quản Lý Các Đợt Bầu Cử (Election Rounds)
CREATE TABLE IF NOT EXISTS giatruong.election_rounds (
    id SERIAL PRIMARY KEY,
    round_number INT NOT NULL DEFAULT 1,
    title VARCHAR(150) NOT NULL,
    status VARCHAR(30) NOT NULL DEFAULT 'scheduled', -- 'scheduled', 'in_progress', 'completed', 'cancelled'
    scheduled_start_at TIMESTAMP WITH TIME ZONE,
    started_at TIMESTAMP WITH TIME ZONE,
    expires_at TIMESTAMP WITH TIME ZONE,
    duration_minutes INT NOT NULL DEFAULT 8,
    total_votes INT NOT NULL DEFAULT 0,
    ended_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO giatruong.election_rounds (round_number, title, status, duration_minutes)
VALUES (1, 'Bầu Cử Ban Điều Hành Gia Trưởng - Khóa Mới', 'scheduled', 8)
ON CONFLICT DO NOTHING;

-- 4. Bảng Phiên Bỏ Phiếu (Voting Sessions)
CREATE TABLE IF NOT EXISTS giatruong.voting_sessions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    round_id INT REFERENCES giatruong.election_rounds(id),
    voter_name VARCHAR(100) NOT NULL,
    clean_voter_name VARCHAR(100),
    voter_phone VARCHAR(100),
    is_trial BOOLEAN NOT NULL DEFAULT FALSE,
    started_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
    submitted_at TIMESTAMP WITH TIME ZONE,
    status VARCHAR(20) NOT NULL DEFAULT 'in_progress',
    CONSTRAINT chk_voting_status CHECK (status IN ('in_progress', 'completed', 'expired'))
);

CREATE INDEX IF NOT EXISTS idx_giatruong_sessions_round ON giatruong.voting_sessions(round_id, status);
CREATE INDEX IF NOT EXISTS idx_giatruong_sessions_phone ON giatruong.voting_sessions(voter_phone, is_trial);
CREATE INDEX IF NOT EXISTS idx_giatruong_sessions_expires ON giatruong.voting_sessions(expires_at);

-- 5. Bảng Phiếu Bầu (Votes)
CREATE TABLE IF NOT EXISTS giatruong.votes (
    id SERIAL PRIMARY KEY,
    round_id INT REFERENCES giatruong.election_rounds(id),
    session_id UUID UNIQUE NOT NULL REFERENCES giatruong.voting_sessions(id) ON DELETE CASCADE,
    clean_voter_name VARCHAR(100),
    voter_phone VARCHAR(100),
    is_trial BOOLEAN NOT NULL DEFAULT FALSE,
    submitted_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_votes_round_phone 
  ON giatruong.votes (round_id, voter_phone) 
  WHERE voter_phone IS NOT NULL AND voter_phone != '';

CREATE UNIQUE INDEX IF NOT EXISTS uq_votes_round_name 
  ON giatruong.votes (round_id, clean_voter_name) 
  WHERE (voter_phone IS NULL OR voter_phone = '') AND clean_voter_name IS NOT NULL AND clean_voter_name != '';

CREATE INDEX IF NOT EXISTS idx_giatruong_votes_round ON giatruong.votes(round_id);
CREATE INDEX IF NOT EXISTS idx_giatruong_votes_phone ON giatruong.votes(voter_phone, is_trial);
CREATE INDEX IF NOT EXISTS idx_giatruong_votes_trial ON giatruong.votes(is_trial);

-- 6. Bảng Chi Tiết Phiếu Bầu (Vote Details)
CREATE TABLE IF NOT EXISTS giatruong.vote_details (
    id SERIAL PRIMARY KEY,
    vote_id INT NOT NULL REFERENCES giatruong.votes(id) ON DELETE CASCADE,
    candidate_id INT REFERENCES giatruong.candidates(id),
    custom_candidate_name VARCHAR(100),
    is_new BOOLEAN DEFAULT FALSE
);

CREATE INDEX IF NOT EXISTS idx_giatruong_vote_details_cand ON giatruong.vote_details(candidate_id);
CREATE INDEX IF NOT EXISTS idx_giatruong_vote_details_vote ON giatruong.vote_details(vote_id);


