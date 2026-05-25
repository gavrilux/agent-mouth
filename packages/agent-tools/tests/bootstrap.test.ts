import { describe, it, expect, beforeEach } from "vitest";
import type {
  WebSearchProvider,
  VectorStore,
  EmbeddingProvider,
  KnowledgeSource,
} from "@agent-mouth/core";
import { bootstrapTools, listTools, _resetToolRegistry } from "../src/index.js";

const fakeWebSearch: WebSearchProvider = {
  name: "fake",
  init: async () => {},
  search: async () => ({ results: [] }),
};

const fakeStore: VectorStore = {
  type: "fake",
  init: async () => {},
  upsert: async () => {},
  deleteByFileId: async () => {},
  search: async () => [],
};

const fakeEmbedder: EmbeddingProvider = {
  name: "fake",
  dimensions: 4,
  init: async () => {},
  embed: async () => [],
  embedQuery: async () => [0, 0, 0, 0],
};

const fakeKnowledge: KnowledgeSource = {
  type: "fake",
  init: async () => {},
  sync: async () => ({ added: [], modified: [], deleted: [], errors: [] }),
  listFiles: async () => [],
  readFile: async () => ({ content: "", lastModified: new Date() }),
};

describe("bootstrapTools", () => {
  beforeEach(() => _resetToolRegistry());

  it("registers all three tools by name", () => {
    bootstrapTools({
      webSearchProvider: fakeWebSearch,
      vectorStore: fakeStore,
      embedder: fakeEmbedder,
      knowledgeSource: fakeKnowledge,
    });
    const names = listTools().map((t) => t.name).sort();
    expect(names).toEqual(["read_knowledge_file", "search_knowledge", "search_web"]);
  });
});
