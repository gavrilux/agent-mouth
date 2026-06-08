import type { EmbeddingProvider, VectorStore } from "@agent-mouth/core";
import { describe, expect, it } from "vitest";
import { SearchKnowledgeTool } from "../src/search-knowledge-tool.js";

function ctx(): any {
  return {
    workspaceId: "ws-1",
    contactId: "c",
    threadId: "t",
    policy: {} as any,
    logger: { info: () => {}, warn: () => {}, error: () => {} },
  };
}

describe("SearchKnowledgeTool", () => {
  it("embeds query, searches vector store, returns chunks with paths", async () => {
    const embedder: EmbeddingProvider = {
      name: "fake",
      dimensions: 4,
      init: async () => {},
      embed: async (txts) => txts.map(() => [0, 1, 0, 0]),
      embedQuery: async () => [0, 1, 0, 0],
    };
    const store: VectorStore = {
      type: "fake",
      init: async () => {},
      upsert: async () => {},
      deleteByFileId: async () => {},
      search: async () => [
        {
          fileId: "f1",
          filePath: "02-Proyectos/x.md",
          chunkIndex: 0,
          text: "matching text",
          score: 0.87,
          metadata: { heading_path: "# X > ## S", frontmatter: { tipo: "proyecto" } },
        },
      ],
    };
    const tool = new SearchKnowledgeTool({ embedder, vectorStore: store });
    const res = await tool.execute({ query: "where is x" }, ctx());
    expect(res.ok).toBe(true);
    const out = res.output as any;
    expect(out.chunks).toHaveLength(1);
    expect(out.chunks[0].file_path).toBe("02-Proyectos/x.md");
    expect(out.chunks[0].heading_path).toBe("# X > ## S");
  });

  it("passes workspaceId filter from ctx", async () => {
    let captured: any;
    const embedder: EmbeddingProvider = {
      name: "fake",
      dimensions: 4,
      init: async () => {},
      embed: async () => [[0, 0, 0, 0]],
      embedQuery: async () => [0, 0, 0, 0],
    };
    const store: VectorStore = {
      type: "fake",
      init: async () => {},
      upsert: async () => {},
      deleteByFileId: async () => {},
      search: async (_v, opts) => {
        captured = opts;
        return [];
      },
    };
    const tool = new SearchKnowledgeTool({ embedder, vectorStore: store });
    await tool.execute({ query: "x", filter: { path_prefix: "02-" } }, ctx());
    expect(captured.filter.workspaceId).toBe("ws-1");
    expect(captured.filter.pathPrefix).toBe("02-");
  });

  it("returns ok=false on embedder error and handles non-Error throws", async () => {
    const embedder: EmbeddingProvider = {
      name: "fake",
      dimensions: 4,
      init: async () => {},
      embed: async () => [],
      embedQuery: async () => {
        throw "string-thrown";
      },
    };
    const store: VectorStore = {
      type: "fake",
      init: async () => {},
      upsert: async () => {},
      deleteByFileId: async () => {},
      search: async () => [],
    };
    const tool = new SearchKnowledgeTool({ embedder, vectorStore: store });
    const res = await tool.execute({ query: "x" }, ctx());
    expect(res.ok).toBe(false);
    expect(res.error).toBe("string-thrown");
  });
});
