-- ==============================================================================
-- MIGRATION: 010_giatruong_voting_schema.sql
-- Hệ Thống Bỏ Phiếu Ban Đại Diện Gia Trưởng (Mượn Docker Service PostgreSQL 16)
-- Phân lập an toàn tuyệt đối qua schema 'giatruong'
-- ==============================================================================

CREATE SCHEMA IF NOT EXISTS giatruong;

-- 1. Bảng Cấu Hình Hệ Thống (Settings)
CREATE TABLE IF NOT EXISTS giatruong.settings (
    key VARCHAR(50) PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Dữ liệu cấu hình ban đầu
INSERT INTO giatruong.settings (key, value) VALUES
    ('voting_status', 'closed'),           -- 'trial_only' | 'real_only' | 'closed'
    ('real_duration_minutes', '8'),
    ('trial_duration_minutes', '4'),
    ('max_picks', '8'),
    ('admin_secret_token', 'admin_secret_giatruong_2026')
ON CONFLICT (key) DO NOTHING;

-- 2. Bảng Danh Sách Ứng Viên (Candidates)
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

-- 41 Ứng viên chính thức
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



-- 3. Bảng Phiên Bỏ Phiếu (Voting Sessions)
CREATE TABLE IF NOT EXISTS giatruong.voting_sessions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    voter_name VARCHAR(100) NOT NULL,
    voter_phone VARCHAR(20) NOT NULL,
    is_trial BOOLEAN NOT NULL DEFAULT FALSE,
    started_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
    submitted_at TIMESTAMP WITH TIME ZONE,
    status VARCHAR(20) NOT NULL DEFAULT 'in_progress',
    CONSTRAINT chk_voting_status CHECK (status IN ('in_progress', 'completed', 'expired'))
);

CREATE INDEX IF NOT EXISTS idx_giatruong_sessions_phone ON giatruong.voting_sessions(voter_phone, is_trial);
CREATE INDEX IF NOT EXISTS idx_giatruong_sessions_expires ON giatruong.voting_sessions(expires_at);

-- 4. Bảng Kết Quả Phiếu Bầu (Votes)
CREATE TABLE IF NOT EXISTS giatruong.votes (
    id SERIAL PRIMARY KEY,
    session_id UUID UNIQUE NOT NULL REFERENCES giatruong.voting_sessions(id) ON DELETE CASCADE,
    voter_phone VARCHAR(20) NOT NULL,
    is_trial BOOLEAN NOT NULL DEFAULT FALSE,
    submitted_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_giatruong_votes_phone ON giatruong.votes(voter_phone, is_trial);
CREATE INDEX IF NOT EXISTS idx_giatruong_votes_trial ON giatruong.votes(is_trial);

-- 5. Chi Tiết Lựa Chọn Trong Phiếu (Vote Details - tối đa 8 ứng viên)
CREATE TABLE IF NOT EXISTS giatruong.vote_details (
    id SERIAL PRIMARY KEY,
    vote_id INT NOT NULL REFERENCES giatruong.votes(id) ON DELETE CASCADE,
    candidate_id INT REFERENCES giatruong.candidates(id),
    custom_candidate_name VARCHAR(100),
    is_new BOOLEAN DEFAULT FALSE
);

CREATE INDEX IF NOT EXISTS idx_giatruong_vote_details_cand ON giatruong.vote_details(candidate_id);
CREATE INDEX IF NOT EXISTS idx_giatruong_vote_details_vote ON giatruong.vote_details(vote_id);
