#!/usr/bin/env node
// Thin dispatcher. All logic lives in @agent-mouth/api.

const cmd = process.argv[2];
const args = process.argv.slice(3);

async function main() {
  switch (cmd) {
    case "serve": {
      const { serve } = await import("@agent-mouth/api/cli/serve");
      return serve();
    }
    case "serve-http": {
      const { serveHttp } = await import("@agent-mouth/api/cli/serve-http");
      return serveHttp();
    }
    case "init": {
      const { init } = await import("@agent-mouth/api/cli/init");
      return init(args);
    }
    case "join": {
      const { join } = await import("@agent-mouth/api/cli/join");
      return join(args);
    }
    case "seed-knowledge": {
      const { seedKnowledge } = await import("@agent-mouth/api/cli/seed-knowledge");
      return seedKnowledge(args);
    }
    default:
      console.error("Usage: agent-mouth <serve|serve-http|init|join|seed-knowledge>");
      process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
