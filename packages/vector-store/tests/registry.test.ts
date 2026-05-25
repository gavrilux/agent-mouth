import { describe, it, expect, beforeEach } from "vitest";
import type { VectorStore } from "@agent-mouth/core";
import {
  registerVectorStoreType,
  resolveVectorStore,
  listVectorStoreTypes,
  _resetVectorStoreRegistry,
} from "../src/registry.js";

describe("vector store registry", () => {
  beforeEach(() => _resetVectorStoreRegistry());

  it("registers and resolves by type", async () => {
    const fake: VectorStore = {
      type: "fake",
      init: async () => {},
      upsert: async () => {},
      deleteByFileId: async () => {},
      search: async () => [],
    };
    registerVectorStoreType("fake", () => fake);
    expect(listVectorStoreTypes()).toContain("fake");
    const store = await resolveVectorStore({ type: "fake", env: {} });
    expect(store.type).toBe("fake");
  });

  it("throws for unknown type", async () => {
    await expect(resolveVectorStore({ type: "nope", env: {} })).rejects.toThrow(/nope/);
  });
});
