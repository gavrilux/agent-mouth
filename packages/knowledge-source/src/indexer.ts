import type {
  EmbeddingProvider,
  KnowledgeSource,
  SyncResult,
  VectorStore,
} from "@agent-mouth/core";
import type { MarkdownChunker } from "./chunkers/markdown-chunker.js";

export interface KnowledgeFilesRepo {
  getByPath(sourceId: string, path: string): Promise<{ id: string; content_hash: string } | null>;
  upsert(row: {
    source_id: string;
    path: string;
    content_hash: string;
    indexed_at: Date | null;
  }): Promise<string>;
  deleteByPath(sourceId: string, path: string): Promise<string | null>;
}

export interface IndexResult {
  added: number;
  modified: number;
  deleted: number;
  errors: number;
}

export interface IndexSourceArgs {
  sourceId: string;
  source: KnowledgeSource;
  embedder: EmbeddingProvider;
  vectorStore: VectorStore;
  chunker: MarkdownChunker;
  filesRepo: KnowledgeFilesRepo;
}

export async function indexSource(args: IndexSourceArgs): Promise<IndexResult> {
  const sync: SyncResult = await args.source.sync();
  const result: IndexResult = {
    added: 0,
    modified: 0,
    deleted: 0,
    errors: sync.errors.length,
  };

  for (const path of sync.deleted) {
    try {
      const removedId = await args.filesRepo.deleteByPath(args.sourceId, path);
      if (removedId) {
        await args.vectorStore.deleteByFileId(removedId);
        result.deleted++;
      }
    } catch {
      result.errors++;
    }
  }

  for (const kind of ["added", "modified"] as const) {
    for (const kf of sync[kind]) {
      try {
        const { content } = await args.source.readFile(kf.path);
        const chunks = args.chunker.split(content, { path: kf.path });
        const fileId = await args.filesRepo.upsert({
          source_id: args.sourceId,
          path: kf.path,
          content_hash: kf.contentHash,
          indexed_at: null,
        });
        if (chunks.length === 0) {
          await args.filesRepo.upsert({
            source_id: args.sourceId,
            path: kf.path,
            content_hash: kf.contentHash,
            indexed_at: new Date(),
          });
          if (kind === "added") result.added++;
          else result.modified++;
          continue;
        }
        const embeddings = await args.embedder.embed(chunks.map((c) => c.text));
        if (embeddings.length !== chunks.length) {
          throw new Error(
            `Embedder returned ${embeddings.length} vectors for ${chunks.length} chunks`,
          );
        }
        await args.vectorStore.upsert(
          fileId,
          chunks.map((c, i) => ({
            fileId,
            chunkIndex: i,
            text: c.text,
            embedding: embeddings[i]!,
            tokenCount: c.tokenCount,
            metadata: c.metadata,
          })),
        );
        await args.filesRepo.upsert({
          source_id: args.sourceId,
          path: kf.path,
          content_hash: kf.contentHash,
          indexed_at: new Date(),
        });
        if (kind === "added") result.added++;
        else result.modified++;
      } catch {
        result.errors++;
      }
    }
  }

  return result;
}
