import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig, defaultConfigPath } from "../config.js";
import { TelegramTransport, type TelegramConfig } from "../transports/telegram.js";
import { buildServer } from "../server.js";
import { logger } from "../logger.js";

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
