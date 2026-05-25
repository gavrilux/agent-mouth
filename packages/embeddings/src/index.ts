export * from "./registry.js";
export * from "./openai-provider.js";
export * from "./types.js";

import { registerEmbeddingProvider } from "./registry.js";
import { OpenAIEmbeddingProvider } from "./openai-provider.js";

registerEmbeddingProvider("openai", {
  apiKeyEnv: "OPENAI_API_KEY",
  factory: () => new OpenAIEmbeddingProvider(),
});
