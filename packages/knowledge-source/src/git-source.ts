import { createHash } from "node:crypto";
import { readFileSync, statSync, existsSync, readdirSync, writeFileSync, chmodSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import simpleGit from "simple-git";
import type { SimpleGit } from "simple-git";
import type { KnowledgeSource, KnowledgeFile, SyncResult, KnowledgeSourceConfig } from "@agent-mouth/core";

export interface GitKnowledgeSourceConfig extends KnowledgeSourceConfig {
  repo_url: string;
  branch: string;
  local_path: string;
  include_globs?: string[];
  exclude_globs?: string[];
  deploy_key_env_var?: string;
}

function matchesGlob(path: string, globs: string[]): boolean {
  for (const glob of globs) {
    // Escape special regex chars (except * which we handle separately)
    const escaped = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    // Replace ** with a placeholder, then * with [^/]*, then restore ** as .*
    // Also handle **/ at start to match root-level files (zero or more dir segments)
    const pattern = escaped
      .replace(/\*\*/g, "::DS::")
      .replace(/\*/g, "[^/]*")
      .replace(/::DS::\//, "(?:.*/)?") // **/ matches zero or more dir segments
      .replace(/::DS::/g, ".*");       // remaining ** (e.g. at end) matches anything
    const re = new RegExp("^" + pattern + "$");
    if (re.test(path)) return true;
  }
  return false;
}

function walkAll(root: string, sub = ""): string[] {
  const out: string[] = [];
  const dir = sub ? join(root, sub) : root;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === ".git") continue;
    const rel = sub ? `${sub}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      out.push(...walkAll(root, rel));
    } else {
      out.push(rel);
    }
  }
  return out;
}

function hashFile(absPath: string): string {
  const content = readFileSync(absPath);
  return createHash("sha256").update(content).digest("hex");
}

export class GitKnowledgeSource implements KnowledgeSource {
  readonly type = "git";
  private cfg!: GitKnowledgeSourceConfig;
  private lastHashes = new Map<string, string>();
  private sshCommand: string | null = null;

  async init(config: KnowledgeSourceConfig, env: Record<string, string | undefined>): Promise<void> {
    this.cfg = config as GitKnowledgeSourceConfig;
    if (!this.cfg.repo_url || !this.cfg.branch || !this.cfg.local_path) {
      throw new Error("GitKnowledgeSource requires repo_url, branch, local_path");
    }
    if (this.cfg.deploy_key_env_var) {
      const key = env[this.cfg.deploy_key_env_var];
      if (!key) {
        throw new Error(
          `GitKnowledgeSource: deploy_key_env_var "${this.cfg.deploy_key_env_var}" is set in config but the env var has no value`,
        );
      }
      const dir = mkdtempSync(join(tmpdir(), "git-ks-"));
      const keyFile = join(dir, "id_deploy");
      writeFileSync(keyFile, key.endsWith("\n") ? key : key + "\n");
      chmodSync(keyFile, 0o600);
      this.sshCommand = `ssh -i ${keyFile} -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o IdentitiesOnly=yes`;
    }
  }

  private getGit(baseDir?: string): SimpleGit {
    const opts: { baseDir?: string; env?: NodeJS.ProcessEnv } = {};
    if (baseDir) opts.baseDir = baseDir;
    if (this.sshCommand) opts.env = { ...process.env, GIT_SSH_COMMAND: this.sshCommand };
    return simpleGit(opts);
  }

  async sync(): Promise<SyncResult> {
    if (!existsSync(join(this.cfg.local_path, ".git"))) {
      const top = this.getGit();
      await top.clone(this.cfg.repo_url, this.cfg.local_path, ["--depth", "1", "--branch", this.cfg.branch]);
    } else {
      const repo = this.getGit(this.cfg.local_path);
      await repo.fetch("origin", this.cfg.branch);
      await repo.reset(["--hard", `origin/${this.cfg.branch}`]);
    }

    const include = this.cfg.include_globs ?? ["**/*.md"];
    const exclude = this.cfg.exclude_globs ?? [];

    const allFiles = walkAll(this.cfg.local_path).filter(
      (p) => matchesGlob(p, include) && !matchesGlob(p, exclude),
    );

    const currentHashes = new Map<string, string>();
    const added: KnowledgeFile[] = [];
    const modified: KnowledgeFile[] = [];
    const errors: SyncResult["errors"] = [];

    for (const path of allFiles) {
      try {
        const abs = join(this.cfg.local_path, path);
        const h = hashFile(abs);
        currentHashes.set(path, h);
        const prev = this.lastHashes.get(path);
        const stat = statSync(abs);
        const kf: KnowledgeFile = { path, contentHash: h, lastModified: stat.mtime, size: stat.size };
        if (prev === undefined) added.push(kf);
        else if (prev !== h) modified.push(kf);
      } catch (err) {
        errors.push({ path, error: (err as Error).message });
      }
    }

    const deleted: string[] = [];
    for (const prevPath of this.lastHashes.keys()) {
      if (!currentHashes.has(prevPath)) deleted.push(prevPath);
    }

    this.lastHashes = currentHashes;
    return { added, modified, deleted, errors };
  }

  async listFiles(): Promise<KnowledgeFile[]> {
    const include = this.cfg.include_globs ?? ["**/*.md"];
    const exclude = this.cfg.exclude_globs ?? [];
    const all = walkAll(this.cfg.local_path).filter(
      (p) => matchesGlob(p, include) && !matchesGlob(p, exclude),
    );
    return all.map((path) => {
      const abs = join(this.cfg.local_path, path);
      const stat = statSync(abs);
      return { path, contentHash: hashFile(abs), lastModified: stat.mtime, size: stat.size };
    });
  }

  async readFile(path: string): Promise<{ content: string; lastModified: Date }> {
    const abs = join(this.cfg.local_path, path);
    if (!existsSync(abs)) throw new Error(`File not found: ${path}`);
    const content = readFileSync(abs, "utf-8");
    const stat = statSync(abs);
    return { content, lastModified: stat.mtime };
  }
}
