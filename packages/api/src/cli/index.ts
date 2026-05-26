#!/usr/bin/env node
import { init } from "./init.js";
import { join } from "./join.js";
import { serve } from "./serve.js";
import { serveHttp } from "./serve-http.js";
import { emailSetup } from "./email-setup.js";

const cmd = process.argv[2];
const args = process.argv.slice(3);

async function main() {
  switch (cmd) {
    case "serve":
      return serve();
    case "serve-http":
      return serveHttp();
    case "init":
      return init(args);
    case "join":
      return join(args);
    case "email:setup":
      return emailSetup(args);
    default:
      console.error("Usage: agent-mouth <serve|serve-http|init|join|email:setup>");
      process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
