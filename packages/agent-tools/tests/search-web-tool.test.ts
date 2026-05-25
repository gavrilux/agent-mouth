import { describe, it, expect } from "vitest";
import type { WebSearchProvider } from "@agent-mouth/core";
import { SearchWebTool } from "../src/search-web-tool.js";

function ctx(): any {
  return {
    workspaceId: "w",
    contactId: "c",
    threadId: "t",
    policy: {} as any,
    logger: { info: () => {}, warn: () => {}, error: () => {} },
  };
}

describe("SearchWebTool", () => {
  it("returns provider results wrapped with cost", async () => {
    const fakeProvider: WebSearchProvider = {
      name: "fake",
      init: async () => {},
      search: async (q) => ({
        answer: `answer for ${q}`,
        results: [{ title: "T", url: "https://x.com", snippet: "s" }],
      }),
    };
    const tool = new SearchWebTool({ provider: fakeProvider });
    const res = await tool.execute({ query: "node lts" }, ctx());
    expect(res.ok).toBe(true);
    expect(res.output).toEqual({
      results: [{ title: "T", url: "https://x.com", snippet: "s", publishedAt: undefined }],
      answer: "answer for node lts",
    });
    expect(res.costUsd).toBeGreaterThan(0);
    expect(res.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it("returns ok=false on provider error", async () => {
    const fail: WebSearchProvider = {
      name: "fail",
      init: async () => {},
      search: async () => {
        throw new Error("boom");
      },
    };
    const tool = new SearchWebTool({ provider: fail });
    const res = await tool.execute({ query: "x" }, ctx());
    expect(res.ok).toBe(false);
    expect(res.error).toContain("boom");
  });

  it("stringifies non-Error throws safely", async () => {
    const provider: WebSearchProvider = {
      name: "weird",
      init: async () => {},
      // eslint-disable-next-line @typescript-eslint/no-throw-literal
      search: async () => { throw "string-thrown"; },
    };
    const tool = new SearchWebTool({ provider });
    const res = await tool.execute({ query: "x" }, ctx());
    expect(res.ok).toBe(false);
    expect(res.error).toBe("string-thrown");
  });

  it("defaults max_results to 5 when not provided", async () => {
    let capturedMax = 0;
    const spy: WebSearchProvider = {
      name: "spy",
      init: async () => {},
      search: async (_q, opts) => {
        capturedMax = opts.maxResults;
        return { results: [] };
      },
    };
    const tool = new SearchWebTool({ provider: spy });
    await tool.execute({ query: "x" }, ctx());
    expect(capturedMax).toBe(5);
  });
});
