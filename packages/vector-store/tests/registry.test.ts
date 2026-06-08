import type { VectorStore } from "@agent-mouth/core";
import { beforeEach, describe, expect, it } from "vitest";
import {
  _resetVectorStoreRegistry,
  listVectorStoreTypes,
  registerVectorStoreType,
  resolveVectorStore,
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
