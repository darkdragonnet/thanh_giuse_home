-- =============================================================================
-- Migration 013: Add object_events table for tracking HANET CheckinData (log) events
-- Idempotent schema definition
-- =============================================================================

CREATE TABLE IF NOT EXISTS object_events (
  id SERIAL PRIMARY KEY,
  hanet_event_id TEXT,
  person_type INTEGER NOT NULL,
  person_id TEXT,
  person_name TEXT,
  alias_id TEXT,
  device_id TEXT,
  device_name TEXT,
  place_id TEXT,
  place_name TEXT,
  mask INTEGER,
  detected_image_url TEXT,
  event_time BIGINT,
  received_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_object_events_person_type ON object_events (person_type);
CREATE INDEX IF NOT EXISTS idx_object_events_received_at ON object_events (received_at DESC);
CREATE INDEX IF NOT EXISTS idx_object_events_device_id ON object_events (device_id);
