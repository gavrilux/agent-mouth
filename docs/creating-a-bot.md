# Creating a Telegram Bot for Agent Mouth

## 1. Talk to @BotFather

Open Telegram → search for **@BotFather** → start chat → send `/newbot`.

You'll be prompted for:
- **Name**: "Gavrilo · Backend" (free-form, shown to humans)
- **Username**: must end in `_bot`, e.g. `gavrilo_backend_bot`

@BotFather replies with a **token** like `7234567890:AAH-xxxxxxxxxxxxxxxxxxxxxxxxxxxx`. Keep it secret.

## 2. Disable privacy mode

Bots by default only see messages that mention them. Agent Mouth needs to see everything to filter properly.

In @BotFather: `/setprivacy` → pick your bot → **Disable**.

## 3. Add to your group

Open your Telegram group → group settings → Add members → search for your bot's username → add.

Then promote it to admin (group settings → administrators → add admin).

## 4. Verify

Send any message in the group. Your bot is now seeing it (even though it won't reply yet — that's Agent Mouth's job).

## 5. Run agent-mouth init

```bash
npx agent-mouth init
```

It will auto-detect your chat_id if you send a message during the prompt.
