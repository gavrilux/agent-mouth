export * from "./registry.js";
export * from "./types.js";
export * from "./search-web-tool.js";
export * from "./search-knowledge-tool.js";
export * from "./read-knowledge-file-tool.js";

import type {
  EmbeddingProvider,
  KnowledgeSource,
  VectorStore,
  WebSearchProvider,
} from "@agent-mouth/core";
import { ReadKnowledgeFileTool } from "./read-knowledge-file-tool.js";
import { registerTool } from "./registry.js";
import { SearchKnowledgeTool } from "./search-knowledge-tool.js";
import { SearchWebTool } from "./search-web-tool.js";

export interface BootstrapToolsDeps {
  webSearchProvider: WebSearchProvider;
  vectorStore: VectorStore;
  embedder: EmbeddingProvider;
  knowledgeSource: KnowledgeSource;
}

export function bootstrapTools(deps: BootstrapToolsDeps): void {
  registerTool(new SearchWebTool({ provider: deps.webSearchProvider }));
  registerTool(new SearchKnowledgeTool({ embedder: deps.embedder, vectorStore: deps.vectorStore }));
  registerTool(new ReadKnowledgeFileTool({ knowledgeSource: deps.knowledgeSource }));
}
