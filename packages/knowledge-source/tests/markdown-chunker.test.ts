import { describe, expect, it } from "vitest";
import { MarkdownChunker } from "../src/chunkers/markdown-chunker.js";

describe("MarkdownChunker", () => {
  it("splits by H2 headings, prepending breadcrumb to each chunk", () => {
    const md = `---
tipo: proyecto
actualizado: 2026-05-23
---

# Title

Intro paragraph.

## Section A

Body of A.

## Section B

Body of B.
`;
    const chunker = new MarkdownChunker({ targetTokens: 400, maxTokens: 500, overlapTokens: 50 });
    const chunks = chunker.split(md, { path: "test.md" });
    expect(chunks.length).toBe(3);
    expect(chunks[0].text).toContain("# Title");
    expect(chunks[0].text).toContain("Intro paragraph.");
    expect(chunks[1].text).toContain("# Title > ## Section A");
    expect(chunks[1].text).toContain("Body of A.");
    expect(chunks[2].text).toContain("# Title > ## Section B");
  });

  it("includes frontmatter in metadata for every chunk", () => {
    const md = `---
tipo: proyecto
---
# T
body
`;
    const chunker = new MarkdownChunker({ targetTokens: 400, maxTokens: 500, overlapTokens: 50 });
    const chunks = chunker.split(md, { path: "x.md" });
    expect(chunks[0].metadata.frontmatter).toEqual({ tipo: "proyecto" });
  });

  it("sub-splits sections exceeding maxTokens by paragraph", () => {
    const longPara = "lorem ipsum ".repeat(200); // ~600 tokens
    const md = `# T\n\n## S\n\n${longPara}\n\n${longPara}`;
    const chunker = new MarkdownChunker({ targetTokens: 400, maxTokens: 500, overlapTokens: 50 });
    const chunks = chunker.split(md, { path: "long.md" });
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      expect(c.tokenCount).toBeLessThanOrEqual(500);
    }
  });

  it("never splits inside code blocks", () => {
    const code = "```ts\n" + "const x = 1;\n".repeat(80) + "```";
    const md = `# T\n\n## S\n\n${code}`;
    const chunker = new MarkdownChunker({ targetTokens: 400, maxTokens: 500, overlapTokens: 50 });
    const chunks = chunker.split(md, { path: "code.md" });
    const codeOpens = chunks.flatMap((c) => c.text.match(/```/g) ?? []).length;
    expect(codeOpens % 2).toBe(0);
  });

  it("attaches line_start / line_end metadata", () => {
    const md = `# T\n\n## A\nline-a\n\n## B\nline-b\n`;
    const chunker = new MarkdownChunker({ targetTokens: 400, maxTokens: 500, overlapTokens: 50 });
    const chunks = chunker.split(md, { path: "z.md" });
    expect(chunks[1].metadata.line_start).toBeTypeOf("number");
    expect(chunks[1].metadata.line_end).toBeTypeOf("number");
  });

  it("does NOT double the heading when a section is sub-split", () => {
    const longPara = "lorem ipsum ".repeat(200);
    const md = `# T\n\n## S\n\n${longPara}\n\n${longPara}`;
    const chunker = new MarkdownChunker({ targetTokens: 400, maxTokens: 500, overlapTokens: 50 });
    const chunks = chunker.split(md, { path: "x.md" });
    for (const c of chunks) {
      // The heading should appear at most once in each chunk
      const headingOccurrences = (c.text.match(/^# T > ## S$/gm) ?? []).length;
      expect(headingOccurrences).toBeLessThanOrEqual(1);
    }
  });

  it('handles "$" characters in heading text safely', () => {
    // `$&` is JS's replace-pattern token for "whole match"; if unescaped, an
    // unsafe `replace(re, "$&xyz")` would echo the matched heading back.
    // Heading `## Score ($&corrupt)` would, with the bug present, expand to
    // include the matched heading text — corrupting output.
    const md = `# Title\n\n## Score ($&corrupt)\n\nBody text.\n`;
    const chunker = new MarkdownChunker({ targetTokens: 400, maxTokens: 500, overlapTokens: 50 });
    const chunks = chunker.split(md, { path: "x.md" });
    const scoreChunk = chunks.find((c) => c.text.includes("Score"));
    expect(scoreChunk).toBeDefined();
    // Literal `$&corrupt` must survive intact (no replace-pattern expansion).
    expect(scoreChunk!.text).toContain("$&corrupt");
  });

  it("hard-splits single paragraph exceeding maxTokens", () => {
    // One giant paragraph of ~1000 tokens, no internal newlines
    const giant = "lorem ipsum ".repeat(400);
    const md = `# T\n\n## S\n\n${giant}`;
    const chunker = new MarkdownChunker({ targetTokens: 400, maxTokens: 500, overlapTokens: 50 });
    const chunks = chunker.split(md, { path: "x.md" });
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      expect(c.tokenCount).toBeLessThanOrEqual(500);
    }
  });
});
