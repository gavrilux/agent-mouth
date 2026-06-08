import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PgvectorStore } from "../src/pgvector-store.js";

const DATABASE_URL = process.env.PGVECTOR_TEST_URL;
const SHOULD_RUN = !!DATABASE_URL;

(SHOULD_RUN ? describe : describe.skip)("PgvectorStore (live pg)", () => {
  let store: PgvectorStore;
  let client: Client;
  const wsId = "00000000-0000-0000-0000-000000000001";

  beforeAll(async () => {
    client = new Client({ connectionString: DATABASE_URL });
    await client.connect();
    await client.query(`CREATE EXTENSION IF NOT EXISTS vector`);
    await client.query(`
      DROP TABLE IF EXISTS knowledge_chunks_test CASCADE;
      DROP TABLE IF EXISTS knowledge_files_test CASCADE;
      DROP TABLE IF EXISTS knowledge_sources_test CASCADE;
    `);
    await client.query(`
      CREATE TABLE knowledge_sources_test (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        workspace_id uuid NOT NULL
      );
      CREATE TABLE knowledge_files_test (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        source_id uuid NOT NULL REFERENCES knowledge_sources_test(id) ON DELETE CASCADE,
        path text NOT NULL
      );
      CREATE TABLE knowledge_chunks_test (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        file_id uuid NOT NULL REFERENCES knowledge_files_test(id) ON DELETE CASCADE,
        chunk_index integer NOT NULL,
        text text NOT NULL,
        embedding vector(4),
        token_count integer,
        metadata jsonb,
        UNIQUE (file_id, chunk_index)
      );
    `);
    store = new PgvectorStore({
      tablePrefix: "knowledge_",
      tableSuffix: "_test",
      embeddingDim: 4,
    });
    await store.init({ DATABASE_URL: DATABASE_URL! });
  });

  afterAll(async () => {
    await client.query(
      `DROP TABLE knowledge_chunks_test, knowledge_files_test, knowledge_sources_test CASCADE`,
    );
    await client.end();
    await store.close();
  });

  beforeEach(async () => {
    await client.query(`DELETE FROM knowledge_chunks_test`);
    await client.query(`DELETE FROM knowledge_files_test`);
    await client.query(`DELETE FROM knowledge_sources_test`);
  });

  it("upserts chunks and searches by cosine similarity", async () => {
    const srcRes = await client.query(
      `INSERT INTO knowledge_sources_test (workspace_id) VALUES ($1) RETURNING id`,
      [wsId],
    );
    const sourceId = srcRes.rows[0].id;
    const fileRes = await client.query(
      `INSERT INTO knowledge_files_test (source_id, path) VALUES ($1, $2) RETURNING id`,
      [sourceId, "test.md"],
    );
    const fileId = fileRes.rows[0].id;
    await store.upsert(fileId, [
      {
        fileId,
        chunkIndex: 0,
        text: "hello",
        embedding: [1, 0, 0, 0],
        tokenCount: 1,
        metadata: { heading_path: "H1" },
      },
      {
        fileId,
        chunkIndex: 1,
        text: "world",
        embedding: [0, 1, 0, 0],
        tokenCount: 1,
        metadata: { heading_path: "H2" },
      },
    ]);
    const results = await store.search([1, 0, 0, 0], {
      topK: 5,
      filter: { workspaceId: wsId },
    });
    expect(results[0].text).toBe("hello");
  });

  it("deleteByFileId removes chunks", async () => {
    const srcRes = await client.query(
      `INSERT INTO knowledge_sources_test (workspace_id) VALUES ($1) RETURNING id`,
      [wsId],
    );
    const sourceId = srcRes.rows[0].id;
    const fileRes = await client.query(
      `INSERT INTO knowledge_files_test (source_id, path) VALUES ($1, $2) RETURNING id`,
      [sourceId, "x.md"],
    );
    const fileId = fileRes.rows[0].id;
    await store.upsert(fileId, [
      { fileId, chunkIndex: 0, text: "x", embedding: [1, 0, 0, 0], tokenCount: 1, metadata: {} },
    ]);
    await store.deleteByFileId(fileId);
    const { rows } = await client.query(
      `SELECT count(*)::int FROM knowledge_chunks_test WHERE file_id=$1`,
      [fileId],
    );
    expect(rows[0].count).toBe(0);
  });

  it("filters search by workspaceId", async () => {
    const ws1 = wsId;
    const ws2 = "00000000-0000-0000-0000-000000000002";
    const ws1Source = (
      await client.query(
        `INSERT INTO knowledge_sources_test (workspace_id) VALUES ($1) RETURNING id`,
        [ws1],
      )
    ).rows[0].id;
    const ws2Source = (
      await client.query(
        `INSERT INTO knowledge_sources_test (workspace_id) VALUES ($1) RETURNING id`,
        [ws2],
      )
    ).rows[0].id;
    const f1 = (
      await client.query(
        `INSERT INTO knowledge_files_test (source_id, path) VALUES ($1, 'a') RETURNING id`,
        [ws1Source],
      )
    ).rows[0].id;
    const f2 = (
      await client.query(
        `INSERT INTO knowledge_files_test (source_id, path) VALUES ($1, 'b') RETURNING id`,
        [ws2Source],
      )
    ).rows[0].id;
    await store.upsert(f1, [
      {
        fileId: f1,
        chunkIndex: 0,
        text: "ws1",
        embedding: [1, 0, 0, 0],
        tokenCount: 1,
        metadata: {},
      },
    ]);
    await store.upsert(f2, [
      {
        fileId: f2,
        chunkIndex: 0,
        text: "ws2",
        embedding: [1, 0, 0, 0],
        tokenCount: 1,
        metadata: {},
      },
    ]);
    const results = await store.search([1, 0, 0, 0], { topK: 10, filter: { workspaceId: ws1 } });
    expect(results.map((r) => r.text)).toEqual(["ws1"]);
  });
});
