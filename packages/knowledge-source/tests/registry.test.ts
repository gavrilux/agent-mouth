import type { KnowledgeSource } from "@agent-mouth/core";
import { beforeEach, describe, expect, it } from "vitest";
import {
  _resetKnowledgeRegistry,
  listKnowledgeSourceTypes,
  registerKnowledgeSourceType,
  resolveKnowledgeSource,
} from "../src/registry.js";

describe("knowledge source registry", () => {
  beforeEach(() => _resetKnowledgeRegistry());

  it("registers a type and resolves it by config.type", async () => {
    const fake: KnowledgeSource = {
      type: "fake",
      init: async () => {},
      sync: async () => ({ added: [], modified: [], deleted: [], errors: [] }),
      listFiles: async () => [],
      readFile: async () => ({ content: "x", lastModified: new Date() }),
    };
    registerKnowledgeSourceType("fake", () => fake);
    expect(listKnowledgeSourceTypes()).toContain("fake");
    const k = await resolveKnowledgeSource({ type: "fake", config: {}, env: {} });
    expect(k.type).toBe("fake");
  });

  it("throws for unknown type", async () => {
    await expect(resolveKnowledgeSource({ type: "nope", config: {}, env: {} })).rejects.toThrow(
      /nope/,
    );
  });
});
