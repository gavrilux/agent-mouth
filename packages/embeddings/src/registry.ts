import type { EmbeddingProvider } from "@agent-mouth/core";

export interface EmbeddingProviderRegistration {
  apiKeyEnv: string;
  factory: () => EmbeddingProvider;
}

const registry = new Map<string, EmbeddingProviderRegistration>();

export function registerEmbeddingProvider(
  name: string,
  reg: EmbeddingProviderRegistration,
): void {
  registry.set(name, reg);
}

export function listEmbeddingProviders(): string[] {
  return Array.from(registry.keys());
}

export async function resolveEmbeddingProvider(
  name: string,
  env: Record<string, string | undefined>,
): Promise<EmbeddingProvider> {
  const reg = registry.get(name);
  if (!reg) {
    throw new Error(
      `No embedding provider registered for "${name}". Known: ${listEmbeddingProviders().join(", ") || "(none)"}`,
    );
  }
  const apiKey = env[reg.apiKeyEnv];
  if (!apiKey) {
    throw new Error(
      `Embedding provider "${name}" requires ${reg.apiKeyEnv} but it is not set`,
    );
  }
  const provider = reg.factory();
  await provider.init(env);
  return provider;
}

/** Test-only: clears the registry. */
export function _resetEmbeddingRegistry(): void {
  registry.clear();
}
