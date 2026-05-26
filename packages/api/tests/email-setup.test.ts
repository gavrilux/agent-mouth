import { describe, expect, it } from "vitest";
import { parseEmailSetupArgs } from "../src/cli/email-setup.js";

describe("parseEmailSetupArgs", () => {
  it("returns defaults when no args", () => {
    const args = parseEmailSetupArgs([]);
    expect(args.port).toBe(53682);
    expect(args.scopes).toContain("https://www.googleapis.com/auth/gmail.readonly");
  });

  it("parses --port and --workspace-id", () => {
    const args = parseEmailSetupArgs(["--port", "9999", "--workspace-id", "ws-uuid"]);
    expect(args.port).toBe(9999);
    expect(args.workspaceId).toBe("ws-uuid");
  });

  it("parses --topic", () => {
    const args = parseEmailSetupArgs(["--topic", "projects/p/topics/gmail-notifications"]);
    expect(args.topicName).toBe("projects/p/topics/gmail-notifications");
  });
});
