-- =============================================================================
-- Migration 012: Add webhook_events table for tracking HANET webhook push events
-- Idempotent schema definition
-- =============================================================================

CREATE TABLE IF NOT EXISTS webhook_events (
  id SERIAL PRIMARY KEY,
  received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  hanet_event_id TEXT,
  data_type TEXT,
  action_type TEXT,
  person_id TEXT,
  device_id TEXT,
  place_id TEXT,
  place_name TEXT,
  person_name TEXT,
  device_name TEXT,
  alias_id TEXT,
  student_id INT,
  class_id INT,
  hash_valid BOOLEAN,
  disposition TEXT NOT NULL CHECK (disposition IN ('applied', 'deferred', 'invalid_hash', 'ignored', 'failed')),
  kill_switch_active BOOLEAN NOT NULL DEFAULT FALSE,
  error_message TEXT,
  payload JSONB
);

CREATE INDEX IF NOT EXISTS idx_webhook_events_received_at ON webhook_events (received_at DESC);
CREATE INDEX IF NOT EXISTS idx_webhook_events_data_type ON webhook_events (data_type);
CREATE INDEX IF NOT EXISTS idx_webhook_events_disposition ON webhook_events (disposition);
