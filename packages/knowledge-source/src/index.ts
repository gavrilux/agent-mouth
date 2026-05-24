export * from "./chunkers/index.js";
export * from "./registry.js";
export * from "./git-source.js";

import { registerKnowledgeSourceType } from "./registry.js";
import { GitKnowledgeSource } from "./git-source.js";

registerKnowledgeSourceType("git", () => new GitKnowledgeSource());

export * from "./indexer.js";
