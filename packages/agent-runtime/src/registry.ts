import type { AgentRuntime, RuntimeConfig } from "./types.js";

export interface RuntimeProvider {
  /** Model-id prefix that this provider claims (e.g. "claude-", "gemini-", "gpt-"). */
  prefix: string;
  /** Env var name where the API key is expected (e.g. "ANTHROPIC_API_KEY"). */
  apiKeyEnv: string;
  /** Human-readable name for logs and errors. */
  name: string;
  /** Constructs a fresh runtime instance (not yet initialized). */
  factory: () => AgentRuntime;
}

const providers: RuntimeProvider[] = [];

export function registerRuntime(provider: RuntimeProvider): void {
  const existing = providers.findIndex((p) => p.prefix === provider.prefix);
  if (existing >= 0) {
    providers[existing] = provider;
    return;
  }
  providers.push(provider);
}

export function listProviders(): readonly RuntimeProvider[] {
  return providers;
}

export function findProvider(model: string): RuntimeProvider | undefined {
  return providers.find((p) => model.startsWith(p.prefix));
}

/**
 * Resolves a runtime for the given model id using the registry.
 * Looks up the provider by prefix, reads the API key from the supplied env map,
 * and returns an initialized runtime ready to call `respond`.
 *
 * Throws if no provider matches the prefix or the API key env var is missing.
 */
export async function resolveRuntime(
  model: string,
  env: Record<string, string | undefined>,
  extraConfig: Omit<RuntimeConfig, "apiKey" | "defaultModel"> = {},
): Promise<AgentRuntime> {
  const provider = findProvider(model);
  if (!provider) {
    const known = providers.map((p) => p.prefix).join(", ") || "(none registered)";
    throw new Error(`No runtime provider for model "${model}". Known prefixes: ${known}`);
  }
  const apiKey = env[provider.apiKeyEnv];
  if (!apiKey) {
    throw new Error(
      `Model "${model}" requires ${provider.apiKeyEnv} but it is not set in the environment`,
    );
  }
  const runtime = provider.factory();
  await runtime.initialize({ ...extraConfig, apiKey, defaultModel: model });
  return runtime;
}

/** Test-only: clears the registry. */
export function _resetRuntimeRegistry(): void {
  providers.length = 0;
}
