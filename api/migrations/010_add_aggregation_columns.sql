-- Migration 010: Add aggregation columns to detection_jobs
-- Phase 3: Cross-module result aggregation support

ALTER TABLE detection_jobs 
  ADD COLUMN IF NOT EXISTS aggregated_score NUMERIC(5,2),
  ADD COLUMN IF NOT EXISTS aggregated_verdict VARCHAR(50),
  ADD COLUMN IF NOT EXISTS aggregated_risk_level VARCHAR(20),
  ADD COLUMN IF NOT EXISTS modules_succeeded TEXT[] DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS modules_failed TEXT[] DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS modules_skipped TEXT[] DEFAULT '{}';

-- Index for filtering by aggregated risk level
CREATE INDEX IF NOT EXISTS idx_jobs_aggregated_risk 
  ON detection_jobs (org_id, aggregated_risk_level) 
  WHERE aggregated_risk_level IS NOT NULL;

-- Index for filtering by aggregated verdict
CREATE INDEX IF NOT EXISTS idx_jobs_aggregated_verdict 
  ON detection_jobs (org_id, aggregated_verdict) 
  WHERE aggregated_verdict IS NOT NULL;
