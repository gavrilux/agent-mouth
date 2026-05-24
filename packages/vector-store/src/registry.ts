import type { VectorStore } from "@agent-mouth/core";

const factories = new Map<string, () => VectorStore>();

export function registerVectorStoreType(type: string, factory: () => VectorStore): void {
  factories.set(type, factory);
}

export function listVectorStoreTypes(): string[] {
  return Array.from(factories.keys());
}

export async function resolveVectorStore(args: {
  type: string;
  env: Record<string, string | undefined>;
}): Promise<VectorStore> {
  const factory = factories.get(args.type);
  if (!factory) {
    throw new Error(`No vector store for type "${args.type}". Known: ${listVectorStoreTypes().join(", ") || "(none)"}`);
  }
  const store = factory();
  await store.init(args.env);
  return store;
}

export function _resetVectorStoreRegistry(): void {
  factories.clear();
}
