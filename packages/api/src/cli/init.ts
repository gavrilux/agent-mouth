import { Bot } from "grammy";
import { defaultConfigPath, saveConfig } from "../config.js";
import { prompt } from "./_prompt.js";

export async function init(_args: string[]): Promise<void> {
  console.log("🪞 Agent Mouth — init\n");
  console.log("Before running this, you should have:");
  console.log("  1. Created a bot via @BotFather and have its TOKEN");
  console.log("  2. Created or joined a Telegram group");
  console.log("  3. Added your bot to the group as admin");
  console.log("  4. Disabled the bot's privacy mode (@BotFather → /setprivacy → Disable)\n");

  const botToken = await prompt("Bot token (from @BotFather):");
  if (!botToken) {
    console.error("Bot token required.");
    process.exit(1);
  }

  const probeBot = new Bot(botToken);
  let me: { username?: string; first_name: string } | undefined;
  try {
    me = await probeBot.api.getMe();
  } catch (err) {
    console.error("Token rejected by Telegram:", (err as Error).message);
    process.exit(1);
  }
  const verifiedMe = me!;
  console.log(`✓ Bot verified: @${verifiedMe.username} (${verifiedMe.first_name})`);

  let chatId = await prompt(
    "Group chat_id (leave empty to auto-detect — then send any message in your group):",
  );
  if (!chatId) {
    console.log("⏳ Waiting for a message in any group your bot is in (30s timeout)...");
    const updates = await probeBot.api.getUpdates({
      timeout: 30,
      allowed_updates: ["message"],
      limit: 5,
    });
    const groupUpdate = updates.find(
      (u: { message?: { chat: { type: string; id: number; title?: string } } }) =>
        u.message &&
        (u.message.chat.type === "group" || u.message.chat.type === "supergroup"),
    );
    if (!groupUpdate) {
      console.error(
        "No group message received in 30s. Send a message in the group, then re-run init.",
      );
      process.exit(1);
    }
    chatId = String(groupUpdate.message!.chat.id);
    const title = (groupUpdate.message!.chat as { title?: string }).title ?? "untitled";
    console.log(`✓ Detected chat_id: ${chatId} ("${title}")`);
  }

  const handle = verifiedMe.username!;
  const displayName = (await prompt("Display name (Enter for default):")) || verifiedMe.first_name;

  await saveConfig(defaultConfigPath(), {
    transport: "telegram",
    telegram: {
      bot_token: botToken,
      chat_id: chatId,
      handle,
      display_name: displayName,
    },
    last_seen_update_id: 0,
  });

  console.log(`\n✓ Configured as @${handle} in group ${chatId}`);
  console.log(`✓ Config saved to ${defaultConfigPath()}`);
  console.log("\nAdd this to ~/.claude/settings.json under mcpServers:");
  console.log(`   { "agent-mouth": { "command": "npx", "args": ["agent-mouth", "serve"] } }`);
  console.log(`\n🎉 Share this with teammates: chat_id = ${chatId}`);
  console.log(`   They run: npx agent-mouth join --chat-id ${chatId}`);
}
