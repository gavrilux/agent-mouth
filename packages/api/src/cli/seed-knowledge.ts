import { Client as PgClient } from "pg";
import { SupabaseWorkspaceStore } from "@agent-mouth/storage-supabase";
import { logger } from "../logger.js";

export interface SeedKnowledgeArgs {
  repoUrl: string;
  branch: string;
  localPath: string;
  workspaceId?: string;
  force: boolean;
}

export function parseSeedKnowledgeArgs(argv: string[]): SeedKnowledgeArgs {
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined;
  };
  return {
    repoUrl: get("--repo-url") ?? "git@github.com:gavrilux/CerebroDigital.git",
    branch: get("--branch") ?? "main",
    localPath: get("--local-path") ?? "/data/knowledge/cerebro",
    workspaceId: get("--workspace-id"),
    force: argv.includes("--force"),
  };
}

export async function seedKnowledge(argv: string[]): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    logger.error("Missing DATABASE_URL");
    process.exit(1);
  }
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_ANON_KEY;
  if (!supabaseUrl || !supabaseKey) {
    logger.error("Missing SUPABASE_URL or SUPABASE_ANON_KEY");
    process.exit(1);
  }

  const opts = parseSeedKnowledgeArgs(argv);

  let workspaceId = opts.workspaceId;
  if (!workspaceId) {
    try {
      const workspaceStore = new SupabaseWorkspaceStore(supabaseUrl, supabaseKey);
      const workspace = await workspaceStore.getDefault();
      workspaceId = workspace.id;
    } catch (err) {
      logger.error(
        { err: err instanceof Error ? err.message : String(err) },
        "failed to resolve default workspace — pass --workspace-id to override",
      );
      process.exit(1);
    }
  }

  // `**/credenciales*` matches credentials files at any depth; the root-only
  // form would miss nested copies.
  const config = {
    repo_url: opts.repoUrl,
    branch: opts.branch,
    local_path: opts.localPath,
    deploy_key_env_var: "KNOWLEDGE_GIT_DEPLOY_KEY",
    include_globs: ["**/*.md"],
    exclude_globs: [".git/**", "*.backup-*", "node_modules/**", "**/credenciales*"],
  };

  const pg = new PgClient({ connectionString: databaseUrl, connectionTimeoutMillis: 10_000 });
  try {
    await pg.connect();

    if (!opts.force) {
      const { rows: existing } = await pg.query(
        `SELECT id FROM knowledge_sources WHERE workspace_id = $1 LIMIT 1`,
        [workspaceId],
      );
      if (existing.length > 0) {
        logger.info(
          { id: existing[0].id, workspaceId },
          "knowledge_sources row already exists — skipping (use --force to insert anyway)",
        );
        return;
      }
    }

    const { rows } = await pg.query(
      `INSERT INTO knowledge_sources (workspace_id, type, config) VALUES ($1, 'git', $2::jsonb) RETURNING id`,
      [workspaceId, JSON.stringify(config)],
    );
    logger.info(
      { id: rows[0].id, workspaceId, repoUrl: opts.repoUrl },
      "seeded knowledge source",
    );
  } finally {
    await pg.end().catch(() => {});
  }
}
