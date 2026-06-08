export interface KnowledgeFile {
  path: string;
  contentHash: string;
  lastModified: Date;
  size: number;
}

export interface SyncResult {
  added: KnowledgeFile[];
  modified: KnowledgeFile[];
  deleted: string[]; // paths
  errors: Array<{ path: string; error: string }>;
}

export interface KnowledgeSourceConfig {
  [key: string]: unknown;
}

export interface KnowledgeSource {
  readonly type: string;
  init(config: KnowledgeSourceConfig, env: Record<string, string | undefined>): Promise<void>;
  sync(): Promise<SyncResult>;
  listFiles(): Promise<KnowledgeFile[]>;
  readFile(path: string): Promise<{ content: string; lastModified: Date }>;
}
