import type { Tool, ToolContext, VectorStore, EmbeddingProvider } from "@agent-mouth/core";

const EMBED_COST_PER_QUERY = 0.00002;

export interface SearchKnowledgeInput {
  query: string;
  max_results?: number;
  filter?: { path_prefix?: string; frontmatter_tipo?: string };
}

export class SearchKnowledgeTool implements Tool<SearchKnowledgeInput> {
  readonly name = "search_knowledge";
  readonly description =
    "Search the user's personal knowledge base (Cerebro Digital — projects, decisions, sessions, profile). Use when the user references their work, asks about past decisions, project status, or anything personal. Returns relevant chunks with file paths so you can call read_knowledge_file for full context.";
  readonly inputSchema = {
    type: "object" as const,
    properties: {
      query: { type: "string" },
      max_results: { type: "integer", default: 5, maximum: 15 },
      filter: {
        type: "object",
        properties: {
          path_prefix: { type: "string", description: "e.g. '02-Proyectos/'" },
          frontmatter_tipo: { type: "string", description: "e.g. 'proyecto'" },
        },
      },
    },
    required: ["query"],
  };
  readonly requiresExplicitGrant = false;

  constructor(private readonly deps: { embedder: EmbeddingProvider; vectorStore: VectorStore }) {}

  async execute(input: SearchKnowledgeInput, ctx: ToolContext) {
    const start = Date.now();
    try {
      const vec = await this.deps.embedder.embedQuery(input.query);
      const hits = await this.deps.vectorStore.search(vec, {
        topK: input.max_results ?? 5,
        filter: {
          workspaceId: ctx.workspaceId,
          pathPrefix: input.filter?.path_prefix,
          frontmatterTipo: input.filter?.frontmatter_tipo,
        },
      });
      return {
        ok: true,
        output: {
          chunks: hits.map((h) => ({
            file_path: h.filePath,
            heading_path: (h.metadata as Record<string, unknown>)?.heading_path ?? "",
            text: h.text,
            score: h.score,
          })),
        },
        costUsd: EMBED_COST_PER_QUERY,
        latencyMs: Date.now() - start,
      };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
        costUsd: 0,
        latencyMs: Date.now() - start,
      };
    }
  }
}
