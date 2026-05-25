import { describe, it, expect } from "vitest";
import { parseSeedKnowledgeArgs } from "../src/cli/seed-knowledge.js";

describe("parseSeedKnowledgeArgs", () => {
  it("returns defaults when no flags", () => {
    const a = parseSeedKnowledgeArgs([]);
    expect(a.repoUrl).toBe("git@github.com:gavrilux/CerebroDigital.git");
    expect(a.branch).toBe("main");
    expect(a.localPath).toBe("/data/knowledge/cerebro");
    expect(a.force).toBe(false);
    expect(a.workspaceId).toBeUndefined();
  });

  it("overrides repo-url, branch, local-path", () => {
    const a = parseSeedKnowledgeArgs([
      "--repo-url",
      "https://github.com/x/y.git",
      "--branch",
      "develop",
      "--local-path",
      "/tmp/knowledge",
    ]);
    expect(a.repoUrl).toBe("https://github.com/x/y.git");
    expect(a.branch).toBe("develop");
    expect(a.localPath).toBe("/tmp/knowledge");
  });

  it("recognises --force", () => {
    expect(parseSeedKnowledgeArgs(["--force"]).force).toBe(true);
  });

  it("captures --workspace-id", () => {
    expect(parseSeedKnowledgeArgs(["--workspace-id", "abc-123"]).workspaceId).toBe("abc-123");
  });
});
