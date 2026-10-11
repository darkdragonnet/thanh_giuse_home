-- Migration: 002_add_sync_conflicts.sql
-- Mục đích: Tạo bảng sync_conflicts và bổ sung trạng thái conflict_pending_review, failed_quota_exceeded, synced

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

-- Điều chỉnh FK class_id cho phép ON DELETE SET NULL nếu đang là CASCADE
ALTER TABLE students ALTER COLUMN class_id DROP NOT NULL;

CREATE TABLE IF NOT EXISTS sync_conflicts (
    id SERIAL PRIMARY KEY,
    alias_id VARCHAR(100) NOT NULL,
    cloud_person_id VARCHAR(100),
    cloud_alias_id VARCHAR(100),
    cloud_name VARCHAR(255),
    cloud_face_url TEXT,
    conflict_type VARCHAR(50) NOT NULL,         -- 'UNMAPPED_CLASS_PREFIX', 'DUPLICATE_FACE', etc.
    status VARCHAR(50) DEFAULT 'pending_review',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    resolved_at TIMESTAMP WITH TIME ZONE
);

CREATE INDEX IF NOT EXISTS idx_sync_conflicts_alias ON sync_conflicts(alias_id);
