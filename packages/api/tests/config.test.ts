import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type AgentMouthConfig, loadConfig, saveConfig } from "../src/config";

describe("config", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "am-"));
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("returns null when file does not exist", async () => {
    expect(await loadConfig(join(tmp, "config.json"))).toBeNull();
  });

  it("round-trips a Telegram config", async () => {
    const cfg: AgentMouthConfig = {
      transport: "telegram",
      telegram: {
        bot_token: "123:abc",
        chat_id: "-100456",
        handle: "gavrilo-backend",
        display_name: "Gavrilo Backend",
      },
      last_seen_update_id: 0,
    };
    const path = join(tmp, "config.json");
    await saveConfig(path, cfg);
    const loaded = await loadConfig(path);
    expect(loaded).toEqual(cfg);
  });
});
