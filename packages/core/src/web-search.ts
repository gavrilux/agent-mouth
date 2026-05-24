export interface WebSearchHit {
  title: string;
  url: string;
  snippet: string;
  publishedAt?: string;
}

export interface WebSearchResult {
  results: WebSearchHit[];
  answer?: string;
}

export interface WebSearchProvider {
  readonly name: string;
  init(env: Record<string, string | undefined>): Promise<void>;
  search(
    query: string,
    opts: { maxResults: number },
  ): Promise<WebSearchResult>;
}
