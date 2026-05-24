import type { EmbeddingProvider } from "@agent-mouth/core";

const ENDPOINT = "https://api.openai.com/v1/embeddings";
const MODEL = "text-embedding-3-small";

export class OpenAIEmbeddingProvider implements EmbeddingProvider {
  readonly name = "openai";
  readonly dimensions = 1536;
  private apiKey = "";

  async init(env: Record<string, string | undefined>): Promise<void> {
    const key = env["OPENAI_API_KEY"];
    if (!key) throw new Error("OPENAI_API_KEY required");
    this.apiKey = key;
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    const out: number[][] = [];
    for (let i = 0; i < texts.length; i += 100) {
      const batch = texts.slice(i, i + 100);
      const res = await fetch(ENDPOINT, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ model: MODEL, input: batch }),
      });
      if (!res.ok) {
        const body = await res.text();
        throw new Error(`OpenAI embeddings ${res.status}: ${body}`);
      }
      const data = (await res.json()) as { data: Array<{ embedding: number[] }> };
      for (const item of data.data) out.push(item.embedding);
    }
    return out;
  }

  async embedQuery(text: string): Promise<number[]> {
    const [vec] = await this.embed([text]);
    if (!vec) throw new Error("No embedding returned for query");
    return vec;
  }
}
