import type { WebSearchProvider } from "@agent-mouth/core";

export interface WebSearchProviderRegistration {
  apiKeyEnv: string;
  factory: () => WebSearchProvider;
}

const registry = new Map<string, WebSearchProviderRegistration>();

export function registerWebSearchProvider(name: string, reg: WebSearchProviderRegistration): void {
  registry.set(name, reg);
}

export function listWebSearchProviders(): string[] {
  return Array.from(registry.keys());
}

export async function resolveWebSearchProvider(
  name: string,
  env: Record<string, string | undefined>,
): Promise<WebSearchProvider> {
  const reg = registry.get(name);
  if (!reg) {
    throw new Error(`No web search provider for "${name}". Known: ${listWebSearchProviders().join(", ") || "(none)"}`);
  }
  const apiKey = env[reg.apiKeyEnv];
  if (!apiKey) {
    throw new Error(`Web search provider "${name}" requires ${reg.apiKeyEnv} but it is not set`);
  }
  const provider = reg.factory();
  await provider.init(env);
  return provider;
}

/** Test-only: clears the registry. */
export function _resetWebSearchRegistry(): void {
  registry.clear();
}
