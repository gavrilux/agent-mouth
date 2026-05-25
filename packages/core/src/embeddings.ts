export interface EmbeddingProvider {
  readonly name: string;
  readonly dimensions: number;
  init(env: Record<string, string | undefined>): Promise<void>;
  embed(texts: string[]): Promise<number[][]>;
  embedQuery(text: string): Promise<number[]>;
}
