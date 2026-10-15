-- ==============================================================================
-- MIGRATION: 011_election_rounds_and_scheduled_voting.sql
-- Quản lý các Đợt Bầu Cử (Election Rounds), Lịch sử và Ấn định thời gian
-- ==============================================================================

-- 1. Bảng quản lý đợt bầu cử (Election Rounds)
CREATE TABLE IF NOT EXISTS giatruong.election_rounds (
    id SERIAL PRIMARY KEY,
    round_number INT NOT NULL DEFAULT 1,
    title VARCHAR(150) NOT NULL,
    status VARCHAR(30) NOT NULL DEFAULT 'scheduled', -- 'scheduled', 'in_progress', 'completed', 'cancelled'
    scheduled_start_at TIMESTAMPTZ,
    started_at TIMESTAMPTZ,
    expires_at TIMESTAMPTZ,
    duration_minutes INT NOT NULL DEFAULT 8,
    total_votes INT NOT NULL DEFAULT 0,
    ended_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

-- 2. Thêm cột round_id và clean_voter_name vào voting_sessions và votes
ALTER TABLE giatruong.voting_sessions 
ADD COLUMN IF NOT EXISTS round_id INT REFERENCES giatruong.election_rounds(id),
ADD COLUMN IF NOT EXISTS clean_voter_name VARCHAR(100);

ALTER TABLE giatruong.votes 
ADD COLUMN IF NOT EXISTS round_id INT REFERENCES giatruong.election_rounds(id),
ADD COLUMN IF NOT EXISTS clean_voter_name VARCHAR(100);

-- Cho phép voter_phone nullable nếu cử tri chỉ nhập Tên
ALTER TABLE giatruong.voting_sessions ALTER COLUMN voter_phone DROP NOT NULL;
ALTER TABLE giatruong.votes ALTER COLUMN voter_phone DROP NOT NULL;

-- 3. Khởi tạo Đợt 1 mặc định nếu bảng election_rounds chưa có dữ liệu
INSERT INTO giatruong.election_rounds (round_number, title, status, duration_minutes, started_at)
SELECT 1, 'Bầu Cử Ban Đại Diện Gia Trưởng - Khóa Mới (Đợt 1)', 'completed', 8, NOW()
WHERE NOT EXISTS (SELECT 1 FROM giatruong.election_rounds);

-- Cập nhật round_id = 1 cho các bản ghi cũ
UPDATE giatruong.voting_sessions SET round_id = 1 WHERE round_id IS NULL;
UPDATE giatruong.votes SET round_id = 1 WHERE round_id IS NULL;

-- 4. Tạo partial unique indexes chống trùng phiếu theo từng Round
DROP INDEX IF EXISTS giatruong.uq_votes_round_phone;
DROP INDEX IF EXISTS giatruong.uq_votes_round_name;

CREATE UNIQUE INDEX IF NOT EXISTS uq_votes_round_phone 
  ON giatruong.votes (round_id, voter_phone) 
  WHERE voter_phone IS NOT NULL AND voter_phone != '';

CREATE UNIQUE INDEX IF NOT EXISTS uq_votes_round_name 
  ON giatruong.votes (round_id, clean_voter_name) 
  WHERE (voter_phone IS NULL OR voter_phone = '') AND clean_voter_name IS NOT NULL AND clean_voter_name != '';

CREATE INDEX IF NOT EXISTS idx_giatruong_sessions_round ON giatruong.voting_sessions(round_id, status);
CREATE INDEX IF NOT EXISTS idx_giatruong_votes_round ON giatruong.votes(round_id);

-- 5. Cấu hình current_round_id trong settings nếu chưa có
INSERT INTO giatruong.settings (key, value) VALUES ('current_round_id', '1')
ON CONFLICT (key) DO NOTHING;
