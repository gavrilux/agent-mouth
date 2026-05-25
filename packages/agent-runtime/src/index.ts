export * from "./types.js";
export { buildSystemPrompt, buildUserMessages } from "./prompt-builder.js";
export { MockRuntime } from "./mock-runtime.js";
export type { MockRuntimeConfig } from "./mock-runtime.js";
export { ClaudeRuntime } from "./claude-runtime.js";
export { GeminiRuntime } from "./gemini-runtime.js";
export {
  type RuntimeProvider,
  registerRuntime,
  listProviders,
  findProvider,
  resolveRuntime,
  _resetRuntimeRegistry,
} from "./registry.js";

// --- Built-in providers ---
// Side-effect: registers Claude and Gemini on module import.
// To add a new provider externally, call registerRuntime(...) before startWorker.
import { ClaudeRuntime } from "./claude-runtime.js";
import { GeminiRuntime } from "./gemini-runtime.js";
import { registerRuntime } from "./registry.js";

registerRuntime({
  prefix: "claude-",
  apiKeyEnv: "ANTHROPIC_API_KEY",
  name: "Anthropic Claude",
  factory: () => new ClaudeRuntime(),
});

registerRuntime({
  prefix: "gemini-",
  apiKeyEnv: "GOOGLE_API_KEY",
  name: "Google Gemini",
  factory: () => new GeminiRuntime(),
});
