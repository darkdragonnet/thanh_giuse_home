-- Migration: 001_add_admin_requests_and_status.sql
-- Mục đích: Đảm bảo ENUM student_status có đủ 5 giá trị và tạo bảng admin_requests

-- 1. Cập nhật ENUM student_status đủ 5 giá trị
DO $$ 
BEGIN 
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'student_status') THEN
    CREATE TYPE student_status AS ENUM ('empty', 'pending', 'success', 'error', 'manual_review');
  ELSE
    ALTER TYPE student_status ADD VALUE IF NOT EXISTS 'manual_review';
  END IF;
END $$;

-- 2. Tạo ENUM admin_request_status
DO $$ 
BEGIN 
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'admin_request_status') THEN
    CREATE TYPE admin_request_status AS ENUM ('new', 'processing', 'done');
  END IF;
END $$;

-- 3. Tạo bảng admin_requests
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

-- 4. Tạo Index cho admin_requests
CREATE INDEX IF NOT EXISTS idx_admin_requests_status ON admin_requests(status);
CREATE INDEX IF NOT EXISTS idx_admin_requests_alias ON admin_requests(alias_id);
