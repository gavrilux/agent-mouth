import { Client } from "pg";
import type { KnowledgeFilesRepo } from "@agent-mouth/knowledge-source";

export interface SupabaseKnowledgeFilesRepoOptions {
  connectionString: string;
}

export class SupabaseKnowledgeFilesRepo implements KnowledgeFilesRepo {
  private client: Client;

  constructor(opts: SupabaseKnowledgeFilesRepoOptions) {
    this.client = new Client({ connectionString: opts.connectionString });
  }

  async init(): Promise<void> {
    await this.client.connect();
  }

  async close(): Promise<void> {
    await this.client.end();
  }

  async getByPath(sourceId: string, path: string) {
    const { rows } = await this.client.query(
      `SELECT id, content_hash FROM knowledge_files WHERE source_id = $1 AND path = $2 LIMIT 1`,
      [sourceId, path],
    );
    if (rows.length === 0) return null;
    return { id: rows[0].id, content_hash: rows[0].content_hash };
  }

  async upsert(row: {
    source_id: string;
    path: string;
    content_hash: string;
    indexed_at: Date | null;
  }): Promise<string> {
    const { rows } = await this.client.query(
      `INSERT INTO knowledge_files (source_id, path, content_hash, indexed_at)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (source_id, path)
       DO UPDATE SET content_hash = EXCLUDED.content_hash, indexed_at = EXCLUDED.indexed_at
       RETURNING id`,
      [row.source_id, row.path, row.content_hash, row.indexed_at],
    );
    return rows[0].id;
  }

  async deleteByPath(sourceId: string, path: string): Promise<string | null> {
    const { rows } = await this.client.query(
      `DELETE FROM knowledge_files WHERE source_id = $1 AND path = $2 RETURNING id`,
      [sourceId, path],
    );
    if (rows.length === 0) return null;
    return rows[0].id;
  }
}
