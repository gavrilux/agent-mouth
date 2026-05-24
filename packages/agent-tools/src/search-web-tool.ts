import type { Tool, ToolContext, WebSearchProvider } from "@agent-mouth/core";

const ESTIMATED_COST_PER_CALL = 0.001;

export interface SearchWebInput {
  query: string;
  max_results?: number;
}

export class SearchWebTool implements Tool<SearchWebInput> {
  readonly name = "search_web";
  readonly description =
    "Search the public web for current information. Use when the user asks about news, prices, weather, recent events, or anything that may have changed since your training cutoff. Returns curated results with citations.";
  readonly inputSchema = {
    type: "object" as const,
    properties: {
      query: { type: "string", description: "Search query in natural language" },
      max_results: { type: "integer", default: 5, maximum: 10 },
    },
    required: ["query"],
  };
  readonly requiresExplicitGrant = false;

  constructor(private readonly deps: { provider: WebSearchProvider }) {}

  async execute(input: SearchWebInput, _ctx: ToolContext) {
    const start = Date.now();
    try {
      const out = await this.deps.provider.search(input.query, { maxResults: input.max_results ?? 5 });
      return {
        ok: true,
        output: out,
        costUsd: ESTIMATED_COST_PER_CALL,
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
