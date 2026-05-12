import { Bot } from "grammy";
import { defaultConfigPath, saveConfig } from "../config.js";
import { prompt } from "./_prompt.js";

export async function join(args: string[]): Promise<void> {
  console.log("🪞 Agent Mouth — join existing group\n");

  // Parse --chat-id flag
  let chatId: string | undefined;
  const idx = args.indexOf("--chat-id");
  if (idx >= 0 && args[idx + 1]) chatId = args[idx + 1];

  console.log("Before running this, you should have:");
  console.log("  1. Created YOUR bot via @BotFather and have its TOKEN");
  console.log("  2. Had a teammate add your bot to the existing group\n");

  if (!chatId) chatId = await prompt("Group chat_id (from your teammate):");
  if (!chatId) {
    console.error("chat_id required.");
    process.exit(1);
  }

  const botToken = await prompt("Bot token (from @BotFather):");
  if (!botToken) {
    console.error("Bot token required.");
    process.exit(1);
  }

  const probeBot = new Bot(botToken);
  let me;
  try {
    me = await probeBot.api.getMe();
  } catch (err) {
    console.error("Token rejected:", (err as Error).message);
    process.exit(1);
  }

  // Verify bot is in the group
  try {
    await probeBot.api.getChat(chatId);
  } catch (err) {
    console.error(`Cannot access group ${chatId}. Make sure your bot was added: ${(err as Error).message}`);
    process.exit(1);
  }

  const handle = me.username!;
  const displayName = await prompt("Display name (Enter for default):") || me.first_name;

  await saveConfig(defaultConfigPath(), {
    transport: "telegram",
    telegram: { bot_token: botToken, chat_id: chatId, handle, display_name: displayName },
    last_seen_update_id: 0
  });

  console.log(`\n✓ Joined group ${chatId} as @${handle}`);
  console.log("Add to ~/.claude/settings.json:");
  console.log(`   { "agent-mouth": { "command": "npx", "args": ["agent-mouth", "serve"] } }`);
}
