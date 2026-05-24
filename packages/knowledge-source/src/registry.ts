import type { KnowledgeSource, KnowledgeSourceConfig } from "@agent-mouth/core";

const factories = new Map<string, () => KnowledgeSource>();

export function registerKnowledgeSourceType(type: string, factory: () => KnowledgeSource): void {
  factories.set(type, factory);
}

export function listKnowledgeSourceTypes(): string[] {
  return Array.from(factories.keys());
}

export async function resolveKnowledgeSource(args: {
  type: string;
  config: KnowledgeSourceConfig;
  env: Record<string, string | undefined>;
}): Promise<KnowledgeSource> {
  const factory = factories.get(args.type);
  if (!factory) {
    throw new Error(
      `No knowledge source for type "${args.type}". Known: ${listKnowledgeSourceTypes().join(", ") || "(none)"}`,
    );
  }
  const source = factory();
  await source.init(args.config, args.env);
  return source;
}

/** Test-only: clears the registry. */
export function _resetKnowledgeRegistry(): void {
  factories.clear();
}
