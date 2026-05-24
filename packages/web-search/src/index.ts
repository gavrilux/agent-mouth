export * from "./registry.js";
export * from "./tavily-provider.js";
export * from "./types.js";

import { registerWebSearchProvider } from "./registry.js";
import { TavilyProvider } from "./tavily-provider.js";

registerWebSearchProvider("tavily", {
  apiKeyEnv: "TAVILY_API_KEY",
  factory: () => new TavilyProvider(),
});
