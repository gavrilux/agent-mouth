import { describe, expectTypeOf, it } from "vitest";
import type {
  EmbeddingProvider,
  KnowledgeFile,
  KnowledgeSource,
  KnowledgeSourceConfig,
  Tool,
  ToolContext,
  VectorSearchResult,
  VectorStore,
  WebSearchProvider,
  WebSearchResult,
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
