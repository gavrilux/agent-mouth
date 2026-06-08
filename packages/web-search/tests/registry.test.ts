import type { WebSearchProvider } from "@agent-mouth/core";
import { beforeEach, describe, expect, it } from "vitest";
import {
  _resetWebSearchRegistry,
  listWebSearchProviders,
  registerWebSearchProvider,
  resolveWebSearchProvider,
} from "../src/registry.js";

describe("web search registry", () => {
  beforeEach(() => _resetWebSearchRegistry());

  it("registers and resolves provider by name", async () => {
    const fake: WebSearchProvider = {
      name: "fake",
      init: async () => {},
      search: async () => ({ results: [] }),
    };
    registerWebSearchProvider("fake", { apiKeyEnv: "FAKE_KEY", factory: () => fake });
    expect(listWebSearchProviders()).toContain("fake");
    const resolved = await resolveWebSearchProvider("fake", { FAKE_KEY: "x" });
    expect(resolved.name).toBe("fake");
  });

  it("throws when API key missing", async () => {
    registerWebSearchProvider("tavily", {
      apiKeyEnv: "TAVILY_API_KEY",
      factory: () => ({}) as WebSearchProvider,
    });
    await expect(resolveWebSearchProvider("tavily", {})).rejects.toThrow(/TAVILY_API_KEY/);
  });
});
