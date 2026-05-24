import { describe, it, expect } from "vitest";
import type { KnowledgeSource } from "@agent-mouth/core";
import { ReadKnowledgeFileTool } from "../src/read-knowledge-file-tool.js";

function ctx(): any {
  return {
    workspaceId: "w",
    contactId: "c",
    threadId: "t",
    policy: {} as any,
    logger: { info: () => {}, warn: () => {}, error: () => {} },
  };
}

describe("ReadKnowledgeFileTool", () => {
  it("returns full content + last_modified + token_count", async () => {
    const src: KnowledgeSource = {
      type: "fake",
      init: async () => {},
      sync: async () => ({ added: [], modified: [], deleted: [], errors: [] }),
      listFiles: async () => [],
      readFile: async () => ({ content: "# Title\n\nbody content", lastModified: new Date("2026-05-23T12:00:00Z") }),
    };
    const tool = new ReadKnowledgeFileTool({ knowledgeSource: src });
    const res = await tool.execute({ path: "x.md" }, ctx());
    expect(res.ok).toBe(true);
    const out = res.output as any;
    expect(out.content).toContain("# Title");
    expect(out.path).toBe("x.md");
    expect(out.token_count).toBeGreaterThan(0);
    expect(out.truncated).toBe(false);
  });

  it("returns truncated=true when file exceeds 50k tokens", async () => {
    const huge = "lorem ipsum ".repeat(30000); // ~60k tokens
    const src: KnowledgeSource = {
      type: "fake",
      init: async () => {},
      sync: async () => ({ added: [], modified: [], deleted: [], errors: [] }),
      listFiles: async () => [],
      readFile: async () => ({ content: huge, lastModified: new Date() }),
    };
    const tool = new ReadKnowledgeFileTool({ knowledgeSource: src });
    const res = await tool.execute({ path: "big.md" }, ctx());
    expect((res.output as any).truncated).toBe(true);
    expect((res.output as any).token_count).toBeLessThanOrEqual(50000);
  });

  it("returns ok=false when readFile throws", async () => {
    const src: KnowledgeSource = {
      type: "fake",
      init: async () => {},
      sync: async () => ({ added: [], modified: [], deleted: [], errors: [] }),
      listFiles: async () => [],
      readFile: async () => {
        throw new Error("not found");
      },
    };
    const tool = new ReadKnowledgeFileTool({ knowledgeSource: src });
    const res = await tool.execute({ path: "missing.md" }, ctx());
    expect(res.ok).toBe(false);
    expect(res.error).toContain("not found");
  });

  it("handles non-Error throws safely", async () => {
    const src: KnowledgeSource = {
      type: "fake",
      init: async () => {},
      sync: async () => ({ added: [], modified: [], deleted: [], errors: [] }),
      listFiles: async () => [],
      readFile: async () => { throw "string-thrown"; },
    };
    const tool = new ReadKnowledgeFileTool({ knowledgeSource: src });
    const res = await tool.execute({ path: "missing.md" }, ctx());
    expect(res.ok).toBe(false);
    expect(res.error).toBe("string-thrown");
  });
});
