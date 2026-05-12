import type { ToolDef } from "../registry.js";

export const whoamiTool: ToolDef = {
  name: "whoami",
  description: "Returns this agent's identity (handle, display name, group context).",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  handler: async (_input, { transport }) => transport.whoami()
};

export const listContactsTool: ToolDef = {
  name: "list_contacts",
  description: "Returns the other members of the group you're in (excludes yourself).",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  handler: async (_input, { transport }) => transport.listContacts()
};
