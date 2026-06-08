import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TavilyProvider } from "../src/tavily-provider.js";

describe("TavilyProvider", () => {
  beforeEach(() => vi.stubGlobal("fetch", vi.fn()));
  afterEach(() => vi.unstubAllGlobals());

  it("calls https://api.tavily.com/search with api_key and query", async () => {
    (globalThis.fetch as any).mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        answer: "Node 22 is current LTS.",
        results: [
          {
            title: "Node Releases",
            url: "https://nodejs.org/en",
            content: "Node 22.0.0 ...",
            published_date: "2026-04-01",
          },
        ],
      }),
    });
    const p = new TavilyProvider();
    await p.init({ TAVILY_API_KEY: "tvly-test" });
    const out = await p.search("node lts", { maxResults: 5 });
    expect(out.answer).toBe("Node 22 is current LTS.");
    expect(out.results[0]).toEqual({
      title: "Node Releases",
      url: "https://nodejs.org/en",
      snippet: "Node 22.0.0 ...",
      publishedAt: "2026-04-01",
    });
    expect(globalThis.fetch).toHaveBeenCalledWith(
      "https://api.tavily.com/search",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("sends api_key, query, max_results, include_answer=true in request body", async () => {
    (globalThis.fetch as any).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ results: [] }),
    });
    const p = new TavilyProvider();
    await p.init({ TAVILY_API_KEY: "tvly-test" });
    await p.search("q", { maxResults: 7 });
    const call = (globalThis.fetch as any).mock.calls[0];
    const body = JSON.parse(call[1].body);
    expect(body).toMatchObject({
      api_key: "tvly-test",
      query: "q",
      max_results: 7,
      include_answer: true,
    });
  });

  it("throws on non-ok response with status code", async () => {
    (globalThis.fetch as any).mockResolvedValueOnce({
      ok: false,
      status: 401,
      text: async () => "unauthorized",
    });
    const p = new TavilyProvider();
    await p.init({ TAVILY_API_KEY: "x" });
    await expect(p.search("q", { maxResults: 5 })).rejects.toThrow(/401/);
  });

  it("throws on init when TAVILY_API_KEY missing", async () => {
    const p = new TavilyProvider();
    await expect(p.init({})).rejects.toThrow(/TAVILY_API_KEY/);
  });
});
