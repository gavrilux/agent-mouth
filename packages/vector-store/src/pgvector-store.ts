import type {
  VectorChunkInput,
  VectorSearchFilter,
  VectorSearchResult,
  VectorStore,
} from "@agent-mouth/core";
import { Client } from "pg";

export interface PgvectorStoreOptions {
  tablePrefix?: string;
  tableSuffix?: string;
  embeddingDim?: number;
}

export class PgvectorStore implements VectorStore {
  readonly type = "pgvector";
  private client: Client | null = null;
  private readonly chunksTable: string;
  private readonly filesTable: string;
  private readonly sourcesTable: string;

  constructor(private readonly opts: PgvectorStoreOptions = {}) {
    const prefix = opts.tablePrefix ?? "knowledge_";
    const suffix = opts.tableSuffix ?? "";
    this.chunksTable = `${prefix}chunks${suffix}`;
    this.filesTable = `${prefix}files${suffix}`;
    this.sourcesTable = `${prefix}sources${suffix}`;
  }

  async init(env: Record<string, string | undefined>): Promise<void> {
    const url = env.DATABASE_URL;
    if (!url) throw new Error("DATABASE_URL required for PgvectorStore");
    this.client = new Client({ connectionString: url });
    await this.client.connect();
  }

  async close(): Promise<void> {
    if (this.client) await this.client.end();
    this.client = null;
  }

  async upsert(fileId: string, chunks: VectorChunkInput[]): Promise<void> {
    if (!this.client) throw new Error("not initialized");
    if (chunks.length === 0) return;
    await this.client.query("BEGIN");
    try {
      await this.client.query(`DELETE FROM ${this.chunksTable} WHERE file_id=$1`, [fileId]);
      for (const c of chunks) {
        const vectorLiteral = `[${c.embedding.join(",")}]`;
        await this.client.query(
          `INSERT INTO ${this.chunksTable} (file_id, chunk_index, text, embedding, token_count, metadata)
           VALUES ($1, $2, $3, $4::vector, $5, $6)`,
          [c.fileId, c.chunkIndex, c.text, vectorLiteral, c.tokenCount, JSON.stringify(c.metadata)],
        );
      }
      await this.client.query("COMMIT");
    } catch (err) {
      await this.client.query("ROLLBACK");
      throw err;
    }
  }

  async deleteByFileId(fileId: string): Promise<void> {
    if (!this.client) throw new Error("not initialized");
    await this.client.query(`DELETE FROM ${this.chunksTable} WHERE file_id=$1`, [fileId]);
  }

  async search(
    queryVector: number[],
    opts: { topK: number; filter: VectorSearchFilter },
  ): Promise<VectorSearchResult[]> {
    if (!this.client) throw new Error("not initialized");
    const vectorLiteral = `[${queryVector.join(",")}]`;
    const params: unknown[] = [vectorLiteral, opts.filter.workspaceId, opts.topK];
    let pathFilter = "";
    if (opts.filter.pathPrefix) {
      params.push(`${opts.filter.pathPrefix}%`);
      pathFilter = `AND f.path LIKE $${params.length}`;
    }
    let tipoFilter = "";
    if (opts.filter.frontmatterTipo) {
      params.push(opts.filter.frontmatterTipo);
      tipoFilter = `AND c.metadata->'frontmatter'->>'tipo' = $${params.length}`;
    }
    const sql = `
      SELECT
        c.file_id, f.path AS file_path, c.chunk_index, c.text,
        1 - (c.embedding <=> $1::vector) AS score,
        c.metadata
      FROM ${this.chunksTable} c
      JOIN ${this.filesTable} f ON f.id = c.file_id
      JOIN ${this.sourcesTable} s ON s.id = f.source_id
      WHERE s.workspace_id = $2
        AND c.embedding IS NOT NULL
        ${pathFilter}
        ${tipoFilter}
      ORDER BY c.embedding <=> $1::vector
      LIMIT $3
    `;
    const { rows } = await this.client.query(sql, params);
    return rows.map((r) => ({
      fileId: r.file_id,
      filePath: r.file_path,
      chunkIndex: r.chunk_index,
      text: r.text,
      score: Number(r.score),
      metadata: r.metadata,
    }));
  }
}
