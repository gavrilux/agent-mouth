import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { OpenAIEmbeddingProvider } from "../src/openai-provider.js";

describe("OpenAIEmbeddingProvider", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("posts to /v1/embeddings with model and input batch", async () => {
    (globalThis.fetch as any).mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        data: [{ embedding: [0.1, 0.2] }, { embedding: [0.3, 0.4] }],
      }),
    });
    const p = new OpenAIEmbeddingProvider();
    await p.init({ OPENAI_API_KEY: "sk-test" });
    const out = await p.embed(["hello", "world"]);
    expect(out).toEqual([[0.1, 0.2], [0.3, 0.4]]);
    expect(globalThis.fetch).toHaveBeenCalledWith(
      "https://api.openai.com/v1/embeddings",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ Authorization: "Bearer sk-test" }),
      }),
    );
  });

  it("embedQuery returns first vector from embed call", async () => {
    (globalThis.fetch as any).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ data: [{ embedding: [1, 2, 3] }] }),
    });
    const p = new OpenAIEmbeddingProvider();
    await p.init({ OPENAI_API_KEY: "sk-test" });
    const v = await p.embedQuery("query");
    expect(v).toEqual([1, 2, 3]);
  });

  it("throws on non-ok response", async () => {
    (globalThis.fetch as any).mockResolvedValueOnce({
      ok: false,
      status: 429,
      text: async () => "rate limit",
    });
    const p = new OpenAIEmbeddingProvider();
    await p.init({ OPENAI_API_KEY: "sk-test" });
    await expect(p.embed(["x"])).rejects.toThrow(/429/);
  });
});
