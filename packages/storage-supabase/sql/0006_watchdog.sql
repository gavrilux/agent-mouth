-- 0006_watchdog.sql — anti-spam state for the watchdog sweep
-- Spec: docs/superpowers/specs/2026-06-05-agent-mouth-watchdog-design.md §5

CREATE TABLE IF NOT EXISTS watchdog_alerts (
  check_id        text PRIMARY KEY,
  status          text NOT NULL,            -- ok | warn | down
  first_seen_at   timestamptz,              -- inicio de la racha no-ok actual
  last_alerted_at timestamptz,              -- última alerta enviada por Telegram
  updated_at      timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE watchdog_alerts ENABLE ROW LEVEL SECURITY;
CREATE POLICY "service_role full access" ON watchdog_alerts
  FOR ALL TO anon, authenticated USING (true) WITH CHECK (true);
