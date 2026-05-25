import { describe, it, expectTypeOf } from "vitest";
import type {
  KnowledgeFile,
  KnowledgeSource,
  KnowledgeSourceConfig,
  VectorStore,
  VectorSearchResult,
  WebSearchProvider,
  WebSearchResult,
  EmbeddingProvider,
  Tool,
  ToolContext,
} from "../src/index.js";

describe("phase-3 core types are exported", () => {
  it("KnowledgeSource has init/sync/listFiles/readFile", () => {
    expectTypeOf<KnowledgeSource>().toHaveProperty("init");
    expectTypeOf<KnowledgeSource>().toHaveProperty("sync");
    expectTypeOf<KnowledgeSource>().toHaveProperty("listFiles");
    expectTypeOf<KnowledgeSource>().toHaveProperty("readFile");
  });
  it("VectorStore has upsert/search/deleteByFileId", () => {
    expectTypeOf<VectorStore>().toHaveProperty("upsert");
    expectTypeOf<VectorStore>().toHaveProperty("search");
    expectTypeOf<VectorStore>().toHaveProperty("deleteByFileId");
  });
  it("Tool has name/description/inputSchema/execute", () => {
    expectTypeOf<Tool>().toHaveProperty("name");
    expectTypeOf<Tool>().toHaveProperty("description");
    expectTypeOf<Tool>().toHaveProperty("inputSchema");
    expectTypeOf<Tool>().toHaveProperty("execute");
  });
});
