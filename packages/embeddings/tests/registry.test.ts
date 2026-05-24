import { describe, it, expect, beforeEach } from "vitest";
import type { EmbeddingProvider } from "@agent-mouth/core";
import {
  registerEmbeddingProvider,
  resolveEmbeddingProvider,
  _resetEmbeddingRegistry,
} from "../src/registry.js";

describe("embedding provider registry", () => {
  beforeEach(() => _resetEmbeddingRegistry());

  it("registers and resolves provider by name", async () => {
    const fake: EmbeddingProvider = {
      name: "fake",
      dimensions: 4,
      init: async () => {},
      embed: async (texts) => texts.map(() => [0, 0, 0, 0]),
      embedQuery: async () => [0, 0, 0, 0],
    };
    registerEmbeddingProvider("fake", { apiKeyEnv: "FAKE_KEY", factory: () => fake });
    const resolved = await resolveEmbeddingProvider("fake", { FAKE_KEY: "x" });
    expect(resolved.name).toBe("fake");
  });

  it("throws when API key env var is missing", async () => {
    registerEmbeddingProvider("openai", {
      apiKeyEnv: "OPENAI_API_KEY",
      factory: () => ({} as EmbeddingProvider),
    });
    await expect(resolveEmbeddingProvider("openai", {})).rejects.toThrow(/OPENAI_API_KEY/);
  });
});
