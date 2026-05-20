-- packages/storage-supabase/sql/0002_apply_phase0_schema.sql
-- Run via Supabase SQL Editor on the agent-mouth project. Idempotent.

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE TABLE IF NOT EXISTS workspaces (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  owner_user_id UUID,
  plan TEXT NOT NULL DEFAULT 'self-host',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id),
  email TEXT UNIQUE,
  role TEXT NOT NULL DEFAULT 'admin',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS channels (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id),
  type TEXT NOT NULL CHECK (type IN ('telegram','email','whatsapp','discord','slack')),
  config JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused','error')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS contacts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id),
  display_name TEXT NOT NULL,
  notes TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS uniq_contact_ws_name ON contacts(workspace_id, display_name);

CREATE TABLE IF NOT EXISTS channel_identities (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id UUID NOT NULL REFERENCES contacts(id),
  channel_id UUID NOT NULL REFERENCES channels(id),
  identifier TEXT NOT NULL,
  verified BOOLEAN NOT NULL DEFAULT FALSE,
  UNIQUE (channel_id, identifier)
);

CREATE TABLE IF NOT EXISTS policies (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id),
  contact_id UUID REFERENCES contacts(id),
  channel_type TEXT,
  policy TEXT NOT NULL CHECK (policy IN ('auto','suggest','escalate','silent')),
  system_prompt TEXT NOT NULL DEFAULT '',
  rules JSONB NOT NULL DEFAULT '{}',
  priority INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_policies_resolution
  ON policies(workspace_id, contact_id, channel_type, priority DESC);

CREATE TABLE IF NOT EXISTS threads (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id),
  contact_id UUID NOT NULL REFERENCES contacts(id),
  channel_id UUID NOT NULL REFERENCES channels(id),
  external_thread_id TEXT,
  related_thread_ids UUID[] NOT NULL DEFAULT '{}',
  last_message_at TIMESTAMPTZ,
  closed BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS uniq_thread_channel_external
  ON threads(channel_id, external_thread_id);

CREATE TABLE IF NOT EXISTS messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  thread_id UUID NOT NULL REFERENCES threads(id),
  channel_id UUID NOT NULL REFERENCES channels(id),
  channel_identity_id UUID REFERENCES channel_identities(id),
  direction TEXT NOT NULL CHECK (direction IN ('inbound','outbound')),
  content TEXT NOT NULL,
  attachments JSONB NOT NULL DEFAULT '[]',
  raw_payload JSONB,
  external_message_id TEXT,
  sent_by TEXT CHECK (sent_by IN ('human','agent') OR sent_by IS NULL),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_messages_thread ON messages(thread_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_messages_ws_created ON messages(channel_id, created_at DESC);

CREATE TABLE IF NOT EXISTS drafts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id UUID NOT NULL REFERENCES messages(id),
  proposed_body TEXT NOT NULL,
  agent_reasoning TEXT NOT NULL DEFAULT '',
  tools_called JSONB NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','edited')),
  approved_by UUID REFERENCES users(id),
  approved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS audit_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id),
  action TEXT NOT NULL,
  actor TEXT NOT NULL CHECK (actor IN ('human','agent','system')),
  details JSONB NOT NULL DEFAULT '{}',
  related_message_id UUID REFERENCES messages(id),
  related_contact_id UUID REFERENCES contacts(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_audit_workspace_created ON audit_log(workspace_id, created_at DESC);

-- The existing offset store table (was created ad-hoc during Phase 0)
CREATE TABLE IF NOT EXISTS agent_mouth_offsets (
  handle TEXT PRIMARY KEY,
  update_id BIGINT NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
