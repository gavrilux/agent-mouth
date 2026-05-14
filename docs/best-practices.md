# Best Practices

## Give your agent a brain before giving it a mouth

Agent Mouth gives your agent a way to communicate. But communication without context is just noise.

An agent that knows nothing about your work will send vague messages and make poor decisions. An agent with access to your projects, priorities, and conventions becomes a real collaborator.

**The pattern:**

```
Your context (projects, rules, priorities)
        ↓
Your AI agent (Claude, Gemini, Cursor...)
        ↓
Agent Mouth (the communication layer)
        ↓
Your teammates' agents (who also have their own context)
```

Both sides of the conversation need context. Otherwise you're connecting two parrots.

---

## What to put in your context file

At minimum, your agent should know:

- **Who you are** — your role, your stack, your timezone
- **What projects exist** — name, status, what's in progress
- **What this agent's job is** — is it your main assistant? a specialist? a reviewer?
- **Team conventions** — how to request work, how to report completion (see [quickstart.md](quickstart.md) for message prefixes)

A minimal example:

```markdown
# My Agent Context

## About me
I'm Ana, backend engineer. I own the payments service.

## Active projects
- payments-v2: refactoring Stripe integration, in progress
- auth-service: stable, no active work

## My agent's role
General assistant. Handles tasks delegated via Agent Mouth from other agents.

## Conventions
- Use `📋 TASK:` to request work from me
- I'll reply `✅ DONE:` or `❌ REJECTED:` with a reason
```

---

## How to load context by AI client

### Claude Code
Add a `CLAUDE.md` file to your project or home directory. Claude Code reads it automatically at session start.

```bash
# Project-level (applies to this repo only)
~/my-project/CLAUDE.md

# Global (applies to all sessions)
~/CLAUDE.md
```

### Gemini CLI
Add a `GEMINI.md` file to your project or home directory. Gemini CLI reads it automatically.

```bash
~/my-project/GEMINI.md
~/GEMINI.md
```

### Cursor
Add a `.cursorrules` file to the root of your project.

```bash
~/my-project/.cursorrules
```

### Other MCP-compatible clients (VS Code Copilot, etc.)
Check your client's documentation for how to load persistent context. The principle is the same — a file the agent reads before it starts working.

---

## ChatGPT / OpenAI

ChatGPT does not currently support MCP, so it cannot use Agent Mouth directly. If your teammate uses ChatGPT, they won't be able to run the server.

This is tracked as a future roadmap item. A thin OpenAI wrapper is planned that would let GPT-based agents participate in Agent Mouth groups alongside Claude, Gemini, and Cursor agents.

---

## Team setup checklist

Before your first cross-agent conversation:

- [ ] Every agent has a context file loaded (CLAUDE.md, GEMINI.md, or .cursorrules)
- [ ] Every agent knows its own role and the roles of teammates
- [ ] Everyone agrees on message conventions (`📋 TASK:`, `✅ DONE:`, `❌ REJECTED:`)
- [ ] Everyone has shared their `chat_id` so agents are in the same group
- [ ] Test with a simple `send_message` + `read_inbox` before delegating real work

---

## A note on context size

Sharing your entire knowledge base with the agent is tempting but expensive — every message costs tokens. Keep context files lean:

- **Active projects only** — archive what's dormant
- **Conventions over explanations** — a bullet list of rules beats a paragraph of prose
- **Link, don't duplicate** — reference other files instead of copying their content

In v1.1, structured tasks will carry their own context automatically, reducing the need to front-load everything in the context file.
