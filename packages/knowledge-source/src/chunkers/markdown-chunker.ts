import { encode } from "gpt-tokenizer";

export interface ChunkerOptions {
  targetTokens: number;
  maxTokens: number;
  overlapTokens: number;
}

export interface Chunk {
  text: string;
  tokenCount: number;
  metadata: {
    heading_path: string;
    line_start: number;
    line_end: number;
    frontmatter: Record<string, unknown>;
  };
}

interface Section {
  headingPath: string;
  lineStart: number;
  lineEnd: number;
  body: string;
}

const FRONTMATTER_RE = /^---\n([\s\S]*?)\n---\n?/;

function parseFrontmatter(md: string): { frontmatter: Record<string, unknown>; rest: string; bodyStartLine: number } {
  const m = md.match(FRONTMATTER_RE);
  if (!m) return { frontmatter: {}, rest: md, bodyStartLine: 1 };
  const yaml = m[1];
  const frontmatter: Record<string, unknown> = {};
  for (const line of yaml.split("\n")) {
    const colon = line.indexOf(":");
    if (colon === -1) continue;
    const key = line.slice(0, colon).trim();
    const val = line.slice(colon + 1).trim();
    frontmatter[key] = val;
  }
  const consumed = m[0];
  return {
    frontmatter,
    rest: md.slice(consumed.length),
    bodyStartLine: consumed.split("\n").length,
  };
}

function splitSections(md: string, bodyStartLine: number): Section[] {
  const lines = md.split("\n");
  const sections: Section[] = [];
  let h1 = "";
  let h2 = "";
  let h3 = "";
  let current: { headingPath: string; lineStart: number; bodyLines: string[] } | null = null;
  let inCode = false;

  const flush = (endLine: number) => {
    if (!current) return;
    sections.push({
      headingPath: current.headingPath,
      lineStart: current.lineStart,
      lineEnd: endLine,
      body: current.bodyLines.join("\n"),
    });
    current = null;
  };

  lines.forEach((raw, i) => {
    const lineNum = bodyStartLine + i;
    if (raw.startsWith("```")) inCode = !inCode;
    if (!inCode) {
      const h1m = raw.match(/^#\s+(.+)/);
      const h2m = raw.match(/^##\s+(.+)/);
      const h3m = raw.match(/^###\s+(.+)/);
      if (h1m) {
        flush(lineNum - 1);
        h1 = h1m[1].trim();
        h2 = "";
        h3 = "";
        current = { headingPath: `# ${h1}`, lineStart: lineNum, bodyLines: [raw] };
        return;
      }
      if (h2m) {
        flush(lineNum - 1);
        h2 = h2m[1].trim();
        h3 = "";
        current = { headingPath: `# ${h1} > ## ${h2}`, lineStart: lineNum, bodyLines: [raw] };
        return;
      }
      if (h3m) {
        flush(lineNum - 1);
        h3 = h3m[1].trim();
        current = { headingPath: `# ${h1} > ## ${h2} > ### ${h3}`, lineStart: lineNum, bodyLines: [raw] };
        return;
      }
    }
    if (!current) {
      current = { headingPath: "(preamble)", lineStart: lineNum, bodyLines: [raw] };
    } else {
      current.bodyLines.push(raw);
    }
  });
  flush(bodyStartLine + lines.length - 1);
  return sections;
}

function countTokens(text: string): number {
  return encode(text).length;
}

/**
 * Hard-split a single oversized string by sentence, then by character count as fallback.
 */
function hardSplit(text: string, maxTokens: number): string[] {
  // Split by sentence (. ! ? followed by space or newline)
  const sentences = text.split(/(?<=[.!?])\s+/);
  const out: string[] = [];
  let buf: string[] = [];
  let bufTok = 0;
  for (const s of sentences) {
    const tok = countTokens(s);
    if (tok > maxTokens) {
      // Fallback: chunk by approximate token count using slice
      if (buf.length > 0) {
        out.push(buf.join(" "));
        buf = [];
        bufTok = 0;
      }
      // Slice text approximately — assume ~4 chars/token average
      const approxCharsPerChunk = maxTokens * 4;
      for (let i = 0; i < s.length; i += approxCharsPerChunk) {
        out.push(s.slice(i, i + approxCharsPerChunk));
      }
      continue;
    }
    if (bufTok + tok > maxTokens && buf.length > 0) {
      out.push(buf.join(" "));
      buf = [s];
      bufTok = tok;
    } else {
      buf.push(s);
      bufTok += tok;
    }
  }
  if (buf.length > 0) out.push(buf.join(" "));
  return out;
}

function splitByParagraphs(text: string, maxTokens: number): string[] {
  const paras = text.split(/\n\n+/);
  const out: string[] = [];
  let buf: string[] = [];
  let bufTok = 0;
  for (const p of paras) {
    const tok = countTokens(p);
    if (tok > maxTokens) {
      // Flush current buffer first
      if (buf.length > 0) {
        out.push(buf.join("\n\n"));
        buf = [];
        bufTok = 0;
      }
      // Hard-split oversized paragraph by sentence, then by chunk-size if still too big
      out.push(...hardSplit(p, maxTokens));
      continue;
    }
    if (bufTok + tok > maxTokens && buf.length > 0) {
      out.push(buf.join("\n\n"));
      buf = [p];
      bufTok = tok;
    } else {
      buf.push(p);
      bufTok += tok;
    }
  }
  if (buf.length > 0) out.push(buf.join("\n\n"));
  return out;
}

/**
 * Replace the first markdown heading line (# / ## / ###) in a section body
 * with the full breadcrumb heading_path so chunks are self-contained.
 * e.g. "## Section A\n\nBody" → "# Title > ## Section A\n\nBody"
 *
 * Uses the function form of replace to avoid JavaScript's special `$` replacement
 * tokens (e.g. $&, $1) corrupting headings that contain literal `$` characters.
 */
function replaceFirstHeadingWithPath(body: string, headingPath: string): string {
  return body.replace(/^#{1,3} .+/, () => headingPath);
}

export class MarkdownChunker {
  constructor(private readonly opts: ChunkerOptions) {}

  split(md: string, _ctx: { path: string }): Chunk[] {
    const { frontmatter, rest, bodyStartLine } = parseFrontmatter(md);
    const sections = splitSections(rest, bodyStartLine).filter(
      (s) => s.body.trim().length > 0
    );
    const chunks: Chunk[] = [];

    for (const section of sections) {
      // Replace the first raw heading line with the full breadcrumb path so
      // consumers see "# Title > ## Section A" instead of "## Section A".
      const bodyWithBreadcrumb = replaceFirstHeadingWithPath(section.body, section.headingPath);
      const tok = countTokens(bodyWithBreadcrumb);
      if (tok <= this.opts.maxTokens) {
        chunks.push({
          text: bodyWithBreadcrumb,
          tokenCount: tok,
          metadata: {
            heading_path: section.headingPath,
            line_start: section.lineStart,
            line_end: section.lineEnd,
            frontmatter,
          },
        });
      } else {
        // Bug 1 fix: strip the raw first heading line from the body before paragraph-splitting,
        // then prepend section.headingPath to EVERY part uniformly. This prevents the heading
        // appearing twice (once from replaceFirstHeadingWithPath, once from the explicit prepend).
        const bodyWithoutHeading = section.body.replace(/^#{1,3} .+\n?/, "");
        const parts = splitByParagraphs(bodyWithoutHeading, this.opts.targetTokens);
        for (const part of parts) {
          const text = `${section.headingPath}\n\n${part}`;
          chunks.push({
            text,
            tokenCount: countTokens(text),
            metadata: {
              heading_path: section.headingPath,
              line_start: section.lineStart,
              line_end: section.lineEnd,
              frontmatter,
            },
          });
        }
      }
    }
    return chunks;
  }
}
