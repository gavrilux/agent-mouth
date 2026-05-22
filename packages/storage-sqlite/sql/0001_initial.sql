-- Agent Mouth — base schema (Phase 0)
-- See: docs/superpowers/specs/2026-05-20-agent-mouth-vision-design.md §4

CREATE TABLE IF NOT EXISTS workspaces (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  owner_user_id TEXT,
  plan TEXT NOT NULL DEFAULT 'self-host',
  daily_budget_usd_cap REAL NOT NULL DEFAULT 5.0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  email TEXT UNIQUE,
  role TEXT NOT NULL DEFAULT 'admin',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS channels (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  type TEXT NOT NULL CHECK (type IN ('telegram', 'email', 'whatsapp', 'discord', 'slack')),
  config TEXT NOT NULL,                -- JSON-serialized, encrypted at app level
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'error')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS contacts (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  display_name TEXT NOT NULL,
  notes TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS channel_identities (
  id TEXT PRIMARY KEY,
  contact_id TEXT NOT NULL REFERENCES contacts(id),
  channel_id TEXT NOT NULL REFERENCES channels(id),
  identifier TEXT NOT NULL,
  verified INTEGER NOT NULL DEFAULT 0,  -- boolean
  UNIQUE (channel_id, identifier)
);

CREATE TABLE IF NOT EXISTS policies (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  contact_id TEXT REFERENCES contacts(id),
  channel_type TEXT,
  policy TEXT NOT NULL CHECK (policy IN ('auto', 'suggest', 'escalate', 'silent')),
  system_prompt TEXT NOT NULL DEFAULT '',
  rules TEXT NOT NULL DEFAULT '{}',     -- JSON-serialized
  priority INTEGER NOT NULL DEFAULT 0,
  model_id TEXT,
  rate_limit_per_hour INTEGER NOT NULL DEFAULT 10,
  max_tokens_out INTEGER NOT NULL DEFAULT 8000,
  max_tool_calls INTEGER NOT NULL DEFAULT 10,
  forbidden_topics_regex TEXT NOT NULL DEFAULT '[]',    -- JSON array
  escalate_triggers_regex TEXT NOT NULL DEFAULT '[]',   -- JSON array
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_policies_resolution
  ON policies(workspace_id, contact_id, channel_type, priority DESC);

CREATE TABLE IF NOT EXISTS threads (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  contact_id TEXT NOT NULL REFERENCES contacts(id),
  channel_id TEXT NOT NULL REFERENCES channels(id),
  external_thread_id TEXT,
  related_thread_ids TEXT NOT NULL DEFAULT '[]', -- JSON array
  last_message_at TEXT,
  closed INTEGER NOT NULL DEFAULT 0,
  notes_last_updated_at TEXT,                    -- ISO timestamp
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL REFERENCES threads(id),
  channel_id TEXT NOT NULL REFERENCES channels(id),
  channel_identity_id TEXT REFERENCES channel_identities(id),
  direction TEXT NOT NULL CHECK (direction IN ('inbound', 'outbound')),
  content TEXT NOT NULL,
  attachments TEXT NOT NULL DEFAULT '[]',  -- JSON array
  raw_payload TEXT,                        -- JSON
  external_message_id TEXT,
  sent_by TEXT CHECK (sent_by IN ('human', 'agent') OR sent_by IS NULL),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_messages_thread ON messages(thread_id, created_at DESC);

CREATE TABLE IF NOT EXISTS drafts (
  id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL REFERENCES messages(id),
  proposed_body TEXT NOT NULL,
  agent_reasoning TEXT NOT NULL DEFAULT '',
  tools_called TEXT NOT NULL DEFAULT '[]', -- JSON array
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'edited')),
  approved_by TEXT REFERENCES users(id),
  approved_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS audit_log (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  action TEXT NOT NULL,
  actor TEXT NOT NULL CHECK (actor IN ('human', 'agent', 'system')),
  details TEXT NOT NULL DEFAULT '{}',     -- JSON
  related_message_id TEXT REFERENCES messages(id),
  related_contact_id TEXT REFERENCES contacts(id),
  decision TEXT CHECK (decision IN ('sent','draft','blocked','escalated','no_action')),
  block_reason TEXT,
  model_id TEXT,
  tokens_in INTEGER,
  tokens_out INTEGER,
  tokens_cached INTEGER,
  cost_usd REAL,
  latency_ms INTEGER,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_audit_workspace_created ON audit_log(workspace_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_workspace_day ON audit_log(workspace_id, created_at);
CREATE INDEX IF NOT EXISTS idx_audit_contact_recent ON audit_log(related_contact_id, created_at);
CREATE INDEX IF NOT EXISTS idx_messages_thread_direction ON messages(thread_id, direction, created_at DESC);
