import type { Tool, Policy } from "@agent-mouth/core";

const tools = new Map<string, Tool>();

export function registerTool(tool: Tool): void {
  tools.set(tool.name, tool);
}

export function listTools(): Tool[] {
  return Array.from(tools.values());
}

export function getTool(name: string): Tool | undefined {
  return tools.get(name);
}

export function resolveToolsForPolicy(policy: Policy): Tool[] {
  const raw = policy.allowed_tools ?? "[]";
  let allowed: string[];
  try {
    allowed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(allowed) || allowed.length === 0) return [];
  if (allowed.includes("*")) {
    return listTools().filter((t) => !t.requiresExplicitGrant);
  }
  return listTools().filter((t) => allowed.includes(t.name));
}

export function _resetToolRegistry(): void {
  tools.clear();
}
