-- Migration: 2026-10-21-add-hanet-sync-rate-limit.sql
-- Thêm cấu hình nhịp đồng bộ nền sang HANET Cloud (1 req/phút theo FR-007)
INSERT INTO settings (key, value) VALUES ('hanet_sync_rate_limit', '1') ON CONFLICT (key) DO NOTHING;
