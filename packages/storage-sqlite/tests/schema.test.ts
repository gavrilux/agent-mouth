import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

describe("SQLite schema", () => {
  it("parses and creates all 10 tables in 0001_initial.sql", () => {
    const sql = readFileSync(join(__dirname, "../sql/0001_initial.sql"), "utf8");
    const db = new Database(":memory:");
    db.exec(sql);

    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as Array<{ name: string }>;

    const tableNames = tables.map((t) => t.name);
    expect(tableNames).toEqual([
      "audit_log",
      "channel_identities",
      "channels",
      "contacts",
      "drafts",
      "messages",
      "policies",
      "threads",
      "users",
      "workspaces",
    ]);

    db.close();
  });
});
