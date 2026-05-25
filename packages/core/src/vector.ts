export interface VectorChunkInput {
  fileId: string;
  chunkIndex: number;
  text: string;
  embedding: number[];
  tokenCount: number;
  metadata: Record<string, unknown>;
}

export interface VectorSearchFilter {
  workspaceId: string;
  pathPrefix?: string;
  frontmatterTipo?: string;
}

export interface VectorSearchResult {
  fileId: string;
  filePath: string;
  chunkIndex: number;
  text: string;
  score: number;
  metadata: Record<string, unknown>;
}

export interface VectorStore {
  readonly type: string;
  init(env: Record<string, string | undefined>): Promise<void>;
  upsert(fileId: string, chunks: VectorChunkInput[]): Promise<void>;
  deleteByFileId(fileId: string): Promise<void>;
  search(
    queryVector: number[],
    opts: { topK: number; filter: VectorSearchFilter },
  ): Promise<VectorSearchResult[]>;
}
