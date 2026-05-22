-- Phase 2: agent runtime, guardrails, audit, notes updater
-- See: docs/superpowers/specs/2026-05-22-agent-mouth-phase-2-design.md §3

-- 1. Per-policy guardrail caps + model override
ALTER TABLE policies
  ADD COLUMN model_id TEXT,
  ADD COLUMN rate_limit_per_hour INTEGER NOT NULL DEFAULT 10,
  ADD COLUMN max_tokens_out INTEGER NOT NULL DEFAULT 8000,
  ADD COLUMN max_tool_calls INTEGER NOT NULL DEFAULT 10,
  ADD COLUMN forbidden_topics_regex TEXT[] NOT NULL DEFAULT '{}',
  ADD COLUMN escalate_triggers_regex TEXT[] NOT NULL DEFAULT '{}';

-- 2. Daily budget cap per workspace
ALTER TABLE workspaces
  ADD COLUMN daily_budget_usd_cap NUMERIC(10,4) NOT NULL DEFAULT 5.0;

-- 3. Audit log columns dedicated for budget/rate queries
ALTER TABLE audit_log
  ADD COLUMN decision TEXT CHECK (decision IN ('sent','draft','blocked','escalated','no_action')),
  ADD COLUMN block_reason TEXT,
  ADD COLUMN model_id TEXT,
  ADD COLUMN tokens_in INTEGER,
  ADD COLUMN tokens_out INTEGER,
  ADD COLUMN tokens_cached INTEGER,
  ADD COLUMN cost_usd NUMERIC(12,6),
  ADD COLUMN latency_ms INTEGER;

CREATE INDEX IF NOT EXISTS idx_audit_workspace_day ON audit_log(workspace_id, created_at)
  WHERE decision IN ('sent','draft');

CREATE INDEX IF NOT EXISTS idx_audit_contact_recent ON audit_log(related_contact_id, created_at)
  WHERE decision IN ('sent','draft');

CREATE INDEX IF NOT EXISTS idx_messages_thread_direction ON messages(thread_id, direction, created_at DESC);

-- 4. Notes updater throttle per thread
ALTER TABLE threads
  ADD COLUMN notes_last_updated_at TIMESTAMPTZ;
