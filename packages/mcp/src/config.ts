import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface TelegramConfigBlock {
  bot_token: string;
  chat_id: string;
  handle: string;
  display_name?: string;
}

export interface AgentMouthConfig {
  transport: "telegram";
  telegram?: TelegramConfigBlock;
  last_seen_update_id: number;
}

export function defaultConfigPath(): string {
  return join(homedir(), ".agent-mouth", "config.json");
}

export async function loadConfig(
  path: string = defaultConfigPath(),
): Promise<AgentMouthConfig | null> {
  try {
    const raw = await readFile(path, "utf8");
    return JSON.parse(raw) as AgentMouthConfig;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

export async function saveConfig(path: string, config: AgentMouthConfig): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(config, null, 2), "utf8");
  await chmod(path, 0o600);
}
