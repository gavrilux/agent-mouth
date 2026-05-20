import { describe, it, expect } from "vitest";
import type {
  Transport,
  TransportConfig,
  ReceivedMessage,
  SentMessage,
  Identity,
  Contact,
} from "../src/transport";

describe("Transport interface contract", () => {
  it("exports Transport with all required methods", () => {
    const _stub: Transport = {
      init: async (_: TransportConfig) => {},
      whoami: async () => ({ handle: "x", display_name: "X" } as Identity),
      listContacts: async () => [] as Contact[],
      send: async () => ({ message_id: "x", timestamp: new Date() } as SentMessage),
      receive: async () => [] as ReceivedMessage[],
      waitForMessages: async () => [] as ReceivedMessage[],
      close: async () => {},
    };
    expect(_stub).toBeDefined();
  });
});
