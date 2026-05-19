#!/usr/bin/env node
import { init } from "./init.js";
import { join } from "./join.js";
import { serve } from "./serve.js";
import { serveHttp } from "./serve-http.js";

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
    default:
      console.error("Usage: agent-mouth <serve|serve-http|init|join>");
      process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
