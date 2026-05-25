-- Phase 3 schema — knowledge stores + per-policy tool authorization
-- Spec: docs/superpowers/specs/2026-05-23-agent-mouth-phase-3-design.md §2.3

CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS knowledge_sources (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id),
  type TEXT NOT NULL,
  config JSONB NOT NULL,
  last_synced_at TIMESTAMPTZ,
  last_sync_status TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_knowledge_sources_workspace
  ON knowledge_sources(workspace_id);

CREATE TABLE IF NOT EXISTS knowledge_files (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id UUID NOT NULL REFERENCES knowledge_sources(id) ON DELETE CASCADE,
  path TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  last_modified TIMESTAMPTZ,
  indexed_at TIMESTAMPTZ,
  UNIQUE (source_id, path)
);
CREATE INDEX IF NOT EXISTS idx_knowledge_files_source
  ON knowledge_files(source_id);

CREATE TABLE IF NOT EXISTS knowledge_chunks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  file_id UUID NOT NULL REFERENCES knowledge_files(id) ON DELETE CASCADE,
  chunk_index INTEGER NOT NULL,
  text TEXT NOT NULL,
  embedding vector(1536),
  token_count INTEGER,
  metadata JSONB,
  UNIQUE (file_id, chunk_index)
);
CREATE INDEX IF NOT EXISTS idx_knowledge_chunks_embedding
  ON knowledge_chunks USING hnsw (embedding vector_cosine_ops);

ALTER TABLE policies
  ADD COLUMN IF NOT EXISTS allowed_tools TEXT NOT NULL DEFAULT '["*"]';
