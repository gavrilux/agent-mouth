import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { defaultConfigPath, loadConfig } from "../config.js";
import { logger } from "../logger.js";
import { buildServer } from "../server.js";
import { type TelegramConfig, TelegramTransport } from "../transports/telegram.js";

export async function serve(): Promise<void> {
  const configPath = defaultConfigPath();
  const config = await loadConfig(configPath);
  if (!config || !config.telegram) {
    logger.error("No config found. Run `agent-mouth init` first.");
    process.exit(1);
  }
  const transport = new TelegramTransport();
  await transport.init(config.telegram as TelegramConfig);
  const server = buildServer({ transport, configPath });
  await server.connect(new StdioServerTransport());
  logger.info({ handle: config.telegram.handle }, "agent-mouth serving over stdio");
}
