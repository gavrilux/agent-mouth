export * from "./registry.js";
export * from "./pgvector-store.js";

import { PgvectorStore } from "./pgvector-store.js";
import { registerVectorStoreType } from "./registry.js";

registerVectorStoreType("pgvector", () => new PgvectorStore());
