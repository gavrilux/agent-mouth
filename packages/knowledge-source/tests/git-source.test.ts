import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import simpleGit from "simple-git";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GitKnowledgeSource } from "../src/git-source.js";

let upstreamRepo: string;
let workdir: string;

beforeEach(async () => {
  upstreamRepo = mkdtempSync(join(tmpdir(), "ks-upstream-"));
  workdir = mkdtempSync(join(tmpdir(), "ks-work-"));
  // Initialize as bare-ish working repo
  const g = simpleGit(upstreamRepo);
  await g.init(["--initial-branch=main"]);
  writeFileSync(join(upstreamRepo, "a.md"), "# A\n\ncontent");
  mkdirSync(join(upstreamRepo, "sub"), { recursive: true });
  writeFileSync(join(upstreamRepo, "sub", "b.md"), "# B\n\nmore");
  writeFileSync(join(upstreamRepo, "ignore.txt"), "skip me");
  await g.add(".");
  await g.addConfig("user.email", "test@test").addConfig("user.name", "Test");
  await g.commit("init");
  // workdir must NOT exist when clone happens. mkdtempSync created it — remove it.
  rmSync(workdir, { recursive: true, force: true });
});

afterEach(() => {
  rmSync(upstreamRepo, { recursive: true, force: true });
  rmSync(workdir, { recursive: true, force: true });
});

describe("GitKnowledgeSource", () => {
  it("clones on first sync and reports added .md files only", async () => {
    const src = new GitKnowledgeSource();
    await src.init(
      {
        repo_url: upstreamRepo,
        branch: "main",
        local_path: workdir,
        include_globs: ["**/*.md"],
        exclude_globs: [],
      },
      {},
    );
    const result = await src.sync();
    const paths = result.added.map((f) => f.path).sort();
    expect(paths).toEqual(["a.md", "sub/b.md"]);
    expect(result.deleted).toEqual([]);
  });

  it("listFiles returns only .md files post-sync", async () => {
    const src = new GitKnowledgeSource();
    await src.init(
      {
        repo_url: upstreamRepo,
        branch: "main",
        local_path: workdir,
        include_globs: ["**/*.md"],
        exclude_globs: [],
      },
      {},
    );
    await src.sync();
    const files = await src.listFiles();
    expect(files.map((f) => f.path).sort()).toEqual(["a.md", "sub/b.md"]);
  });

  it("readFile returns content + lastModified", async () => {
    const src = new GitKnowledgeSource();
    await src.init(
      {
        repo_url: upstreamRepo,
        branch: "main",
        local_path: workdir,
        include_globs: ["**/*.md"],
        exclude_globs: [],
      },
      {},
    );
    await src.sync();
    const { content } = await src.readFile("a.md");
    expect(content).toContain("# A");
  });

  it("detects modifications on subsequent sync via content hash", async () => {
    const src = new GitKnowledgeSource();
    await src.init(
      {
        repo_url: upstreamRepo,
        branch: "main",
        local_path: workdir,
        include_globs: ["**/*.md"],
        exclude_globs: [],
      },
      {},
    );
    await src.sync();
    writeFileSync(join(upstreamRepo, "a.md"), "# A\n\nchanged");
    const g = simpleGit(upstreamRepo);
    await g.add(".").commit("modify a");
    const result = await src.sync();
    expect(result.modified.map((f) => f.path)).toContain("a.md");
  });

  it("detects deletions on subsequent sync", async () => {
    const src = new GitKnowledgeSource();
    await src.init(
      {
        repo_url: upstreamRepo,
        branch: "main",
        local_path: workdir,
        include_globs: ["**/*.md"],
        exclude_globs: [],
      },
      {},
    );
    await src.sync();
    rmSync(join(upstreamRepo, "a.md"));
    const g = simpleGit(upstreamRepo);
    await g.add(["-A"]).commit("delete a");
    const result = await src.sync();
    expect(result.deleted).toContain("a.md");
  });

  it("throws if deploy_key_env_var is set but env var is empty", async () => {
    const src = new GitKnowledgeSource();
    await expect(
      src.init(
        {
          repo_url: upstreamRepo,
          branch: "main",
          local_path: workdir,
          deploy_key_env_var: "MY_DEPLOY_KEY",
        },
        {}, // empty env — MY_DEPLOY_KEY missing
      ),
    ).rejects.toThrow(/MY_DEPLOY_KEY.*no value/);
  });
});
