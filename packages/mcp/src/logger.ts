import pino from "pino";

export const logger = pino({
  level: process.env.AGENT_MOUTH_LOG ?? "info",
  transport: { target: "pino/file", options: { destination: 2 } }, // stderr (stdout reserved for MCP)
});
