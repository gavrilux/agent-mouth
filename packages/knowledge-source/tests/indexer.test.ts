import { describe, it, expect, vi } from "vitest";
import type { KnowledgeSource, EmbeddingProvider, VectorStore } from "@agent-mouth/core";
import { indexSource, type KnowledgeFilesRepo } from "../src/indexer.js";
import { MarkdownChunker } from "../src/chunkers/markdown-chunker.js";

interface FakeFileRow {
  id: string;
  source_id: string;
  path: string;
  content_hash: string;
  indexed_at: Date | null;
}

class FakeFilesRepo implements KnowledgeFilesRepo {
  rows: FakeFileRow[] = [];
  async getByPath(sourceId: string, path: string) {
    const r = this.rows.find((r) => r.source_id === sourceId && r.path === path);
    if (!r) return null;
    return { id: r.id, content_hash: r.content_hash };
  }
  async upsert(row: { source_id: string; path: string; content_hash: string; indexed_at: Date | null }): Promise<string> {
    const existing = this.rows.find((r) => r.source_id === row.source_id && r.path === row.path);
    if (existing) {
      existing.content_hash = row.content_hash;
      existing.indexed_at = row.indexed_at;
      return existing.id;
    }
    const id = `f-${this.rows.length + 1}`;
    this.rows.push({ id, ...row });
    return id;
  }
  async deleteByPath(sourceId: string, path: string): Promise<string | null> {
    const idx = this.rows.findIndex((r) => r.source_id === sourceId && r.path === path);
    if (idx === -1) return null;
    const [removed] = this.rows.splice(idx, 1);
    return removed.id;
  }
}

describe("indexSource", () => {
  it("embeds added files and upserts chunks", async () => {
    const source: KnowledgeSource = {
      type: "fake",
      init: async () => {},
      sync: async () => ({
        added: [{ path: "a.md", contentHash: "h1", lastModified: new Date(), size: 10 }],
        modified: [],
        deleted: [],
        errors: [],
      }),
      listFiles: async () => [],
      readFile: async () => ({ content: "# A\n\nbody", lastModified: new Date() }),
    };
    const embedder: EmbeddingProvider = {
      name: "fake",
      dimensions: 4,
      init: async () => {},
      embed: async (texts) => texts.map(() => [0, 0, 0, 0]),
      embedQuery: async () => [0, 0, 0, 0],
    };
    const upsertSpy = vi.fn(async () => {});
    const store = {
      type: "fake",
      init: async () => {},
      upsert: upsertSpy,
      deleteByFileId: vi.fn(async () => {}),
      search: vi.fn(async () => []),
    } as unknown as VectorStore;
    const filesRepo = new FakeFilesRepo();
    const chunker = new MarkdownChunker({ targetTokens: 400, maxTokens: 500, overlapTokens: 50 });

    const result = await indexSource({
      sourceId: "src-1",
      source,
      embedder,
      vectorStore: store,
      chunker,
      filesRepo,
    });
    expect(result.added).toBe(1);
    expect(filesRepo.rows).toHaveLength(1);
    expect(upsertSpy).toHaveBeenCalledOnce();
  });

  it("deletes vectors for removed files", async () => {
    const source: KnowledgeSource = {
      type: "fake",
      init: async () => {},
      sync: async () => ({ added: [], modified: [], deleted: ["gone.md"], errors: [] }),
      listFiles: async () => [],
      readFile: async () => { throw new Error("nope"); },
    };
    const embedder: EmbeddingProvider = {
      name: "fake",
      dimensions: 4,
      init: async () => {},
      embed: async () => [],
      embedQuery: async () => [0, 0, 0, 0],
    };
    const deleteSpy = vi.fn(async () => {});
    const store = {
      type: "fake",
      init: async () => {},
      upsert: vi.fn(async () => {}),
      deleteByFileId: deleteSpy,
      search: vi.fn(async () => []),
    } as unknown as VectorStore;
    const filesRepo = new FakeFilesRepo();
    filesRepo.rows.push({
      id: "f-existing",
      source_id: "src-1",
      path: "gone.md",
      content_hash: "old",
      indexed_at: new Date(),
    });
    const chunker = new MarkdownChunker({ targetTokens: 400, maxTokens: 500, overlapTokens: 50 });

    const result = await indexSource({
      sourceId: "src-1",
      source,
      embedder,
      vectorStore: store,
      chunker,
      filesRepo,
    });
    expect(result.deleted).toBe(1);
    expect(deleteSpy).toHaveBeenCalledWith("f-existing");
    expect(filesRepo.rows).toHaveLength(0);
  });

  it("counts errors from sync result and increments errors when readFile throws", async () => {
    const source: KnowledgeSource = {
      type: "fake",
      init: async () => {},
      sync: async () => ({
        added: [{ path: "broken.md", contentHash: "h", lastModified: new Date(), size: 1 }],
        modified: [],
        deleted: [],
        errors: [{ path: "preexisting.md", error: "fs error" }],
      }),
      listFiles: async () => [],
      readFile: async () => { throw new Error("read fail"); },
    };
    const embedder: EmbeddingProvider = {
      name: "fake",
      dimensions: 4,
      init: async () => {},
      embed: async () => [[0]],
      embedQuery: async () => [0],
    };
    const store = {
      type: "fake",
      init: async () => {},
      upsert: vi.fn(async () => {}),
      deleteByFileId: vi.fn(async () => {}),
      search: vi.fn(async () => []),
    } as unknown as VectorStore;
    const filesRepo = new FakeFilesRepo();
    const chunker = new MarkdownChunker({ targetTokens: 400, maxTokens: 500, overlapTokens: 50 });

    const result = await indexSource({
      sourceId: "src-1",
      source,
      embedder,
      vectorStore: store,
      chunker,
      filesRepo,
    });
    expect(result.errors).toBeGreaterThanOrEqual(2);
    expect(result.added).toBe(0);
  });
});
