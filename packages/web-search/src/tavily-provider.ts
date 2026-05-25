import type { WebSearchProvider, WebSearchResult } from "@agent-mouth/core";

const ENDPOINT = "https://api.tavily.com/search";

export class TavilyProvider implements WebSearchProvider {
  readonly name = "tavily";
  private apiKey = "";

  async init(env: Record<string, string | undefined>): Promise<void> {
    const key = env.TAVILY_API_KEY;
    if (!key) throw new Error("TAVILY_API_KEY required");
    this.apiKey = key;
  }

  async search(query: string, opts: { maxResults: number }): Promise<WebSearchResult> {
    const res = await fetch(ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        api_key: this.apiKey,
        query,
        max_results: opts.maxResults,
        include_answer: true,
        search_depth: "basic",
      }),
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Tavily ${res.status}: ${body}`);
    }
    const data = (await res.json()) as {
      answer?: string;
      results: Array<{ title: string; url: string; content: string; published_date?: string }>;
    };
    return {
      answer: data.answer,
      results: data.results.map((r) => ({
        title: r.title,
        url: r.url,
        snippet: r.content,
        publishedAt: r.published_date,
      })),
    };
  }
}
