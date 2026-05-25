import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { Client } from "pg";
import { SupabaseKnowledgeFilesRepo } from "../src/knowledge-files-repo.js";

const DATABASE_URL = process.env.PGVECTOR_TEST_URL;

(DATABASE_URL ? describe : describe.skip)("SupabaseKnowledgeFilesRepo", () => {
  let client: Client;
  let repo: SupabaseKnowledgeFilesRepo;
  let sourceId: string;
  const wsId = "00000000-0000-0000-0000-000000000001";

  beforeAll(async () => {
    client = new Client({ connectionString: DATABASE_URL });
    await client.connect();
    await client.query(`CREATE EXTENSION IF NOT EXISTS vector`);
    await client.query(
      `DROP TABLE IF EXISTS knowledge_chunks, knowledge_files, knowledge_sources, workspaces CASCADE`,
    );
    await client.query(
      `CREATE TABLE workspaces (id uuid PRIMARY KEY, name text NOT NULL);
       CREATE TABLE knowledge_sources (
         id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
         workspace_id uuid NOT NULL REFERENCES workspaces(id),
         type text NOT NULL,
         config jsonb NOT NULL,
         created_at timestamptz DEFAULT now()
       );
       CREATE TABLE knowledge_files (
         id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
         source_id uuid NOT NULL REFERENCES knowledge_sources(id) ON DELETE CASCADE,
         path text NOT NULL,
         content_hash text NOT NULL,
         indexed_at timestamptz,
         UNIQUE(source_id, path)
       );
       INSERT INTO workspaces (id, name) VALUES ($1, 'test');`,
      [wsId],
    );
    const r = await client.query(
      `INSERT INTO knowledge_sources (workspace_id, type, config) VALUES ($1, 'git', '{}'::jsonb) RETURNING id`,
      [wsId],
    );
    sourceId = r.rows[0].id;
    repo = new SupabaseKnowledgeFilesRepo({ connectionString: DATABASE_URL! });
    await repo.init();
  });

  afterAll(async () => {
    await client.query(`DROP TABLE knowledge_chunks, knowledge_files, knowledge_sources, workspaces CASCADE`);
    await client.end();
    await repo.close();
  });

  beforeEach(async () => {
    await client.query(`DELETE FROM knowledge_files`);
  });

  it("upsert inserts a new row and returns id", async () => {
    const id = await repo.upsert({
      source_id: sourceId,
      path: "a.md",
      content_hash: "h1",
      indexed_at: new Date(),
    });
    expect(id).toBeTruthy();
  });

  it("upsert updates existing row by (source_id, path)", async () => {
    const id1 = await repo.upsert({
      source_id: sourceId,
      path: "a.md",
      content_hash: "h1",
      indexed_at: new Date(),
    });
    const id2 = await repo.upsert({
      source_id: sourceId,
      path: "a.md",
      content_hash: "h2",
      indexed_at: new Date(),
    });
    expect(id1).toBe(id2);
  });

  it("getByPath returns null when missing, row when present", async () => {
    expect(await repo.getByPath(sourceId, "missing.md")).toBeNull();
    const id = await repo.upsert({
      source_id: sourceId,
      path: "a.md",
      content_hash: "h",
      indexed_at: new Date(),
    });
    const got = await repo.getByPath(sourceId, "a.md");
    expect(got).toEqual({ id, content_hash: "h" });
  });

  it("deleteByPath returns id if existed, null otherwise", async () => {
    const id = await repo.upsert({
      source_id: sourceId,
      path: "a.md",
      content_hash: "h",
      indexed_at: new Date(),
    });
    const removed = await repo.deleteByPath(sourceId, "a.md");
    expect(removed).toBe(id);
    const removedAgain = await repo.deleteByPath(sourceId, "a.md");
    expect(removedAgain).toBeNull();
  });
});
