import { encode, decode } from "gpt-tokenizer";
import type { Tool, ToolContext, KnowledgeSource } from "@agent-mouth/core";

const MAX_TOKENS = 50000;

export interface ReadKnowledgeFileInput {
  path: string;
}

export class ReadKnowledgeFileTool implements Tool<ReadKnowledgeFileInput> {
  readonly name = "read_knowledge_file";
  readonly description =
    "Read the full content of a file from the knowledge base. Use after search_knowledge if a chunk looks relevant and you need more context, or when you already know the exact path.";
  readonly inputSchema = {
    type: "object" as const,
    properties: {
      path: { type: "string", description: "Relative path returned by search_knowledge, e.g. '02-Proyectos/agent-mouth.md'" },
    },
    required: ["path"],
  };
  readonly requiresExplicitGrant = false;

  constructor(private readonly deps: { knowledgeSource: KnowledgeSource }) {}

  async execute(input: ReadKnowledgeFileInput, _ctx: ToolContext) {
    const start = Date.now();
    try {
      const { content, lastModified } = await this.deps.knowledgeSource.readFile(input.path);
      const tokens = encode(content);
      let outContent = content;
      let truncated = false;
      if (tokens.length > MAX_TOKENS) {
        outContent = decode(tokens.slice(0, MAX_TOKENS));
        truncated = true;
      }
      return {
        ok: true,
        output: {
          path: input.path,
          content: outContent,
          last_modified: lastModified.toISOString(),
          token_count: truncated ? MAX_TOKENS : tokens.length,
          truncated,
        },
        costUsd: 0,
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
