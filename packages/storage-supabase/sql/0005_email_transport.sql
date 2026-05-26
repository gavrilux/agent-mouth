-- Phase 1b schema — EmailTransport (Gmail OAuth + Pub/Sub webhook)
-- Spec: docs/superpowers/specs/2026-05-25-agent-mouth-phase-1b-design.md §5.5

-- contacts.metadata jsonb (identity auto-merge)
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS metadata jsonb NOT NULL DEFAULT '{}'::jsonb;
CREATE INDEX IF NOT EXISTS contacts_email_addresses_gin
  ON contacts USING gin ((metadata -> 'email_addresses'));

-- email_oauth_tokens — encrypted refresh tokens + Gmail watch state
CREATE TABLE IF NOT EXISTS email_oauth_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  channel_id uuid NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  email_address text NOT NULL,
  refresh_token_encrypted text NOT NULL,
  scopes text[] NOT NULL DEFAULT ARRAY[]::text[],
  last_history_id text,
  watch_expiration timestamptz,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','error','revoked')),
  last_error text,
  consecutive_renewal_failures int NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, email_address)
);
ALTER TABLE email_oauth_tokens ENABLE ROW LEVEL SECURITY;
CREATE POLICY "service_role full access" ON email_oauth_tokens
  FOR ALL TO anon, authenticated USING (true) WITH CHECK (true);

-- email_webhook_events — dedup at-least-once Pub/Sub delivery
CREATE TABLE IF NOT EXISTS email_webhook_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email_address text NOT NULL,
  history_id text NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (email_address, history_id)
);
ALTER TABLE email_webhook_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY "service_role full access" ON email_webhook_events
  FOR ALL TO anon, authenticated USING (true) WITH CHECK (true);
CREATE INDEX IF NOT EXISTS email_webhook_events_received_at_idx
  ON email_webhook_events (received_at);

-- dedup index on messages (idempotency across webhook + polling paths)
CREATE UNIQUE INDEX IF NOT EXISTS messages_channel_external_uniq
  ON messages (channel_id, external_message_id) WHERE external_message_id IS NOT NULL;
