export * from "./registry.js";
export * from "./pgvector-store.js";

import { registerVectorStoreType } from "./registry.js";
import { PgvectorStore } from "./pgvector-store.js";

registerVectorStoreType("pgvector", () => new PgvectorStore());
