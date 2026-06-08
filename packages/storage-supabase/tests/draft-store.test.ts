import { beforeAll, describe, expect, it } from "vitest";
import { SupabaseDraftStore } from "../src/draft-store.js";

const SUPABASE_URL = process.env.SUPABASE_URL!;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY!;
const SKIP = !SUPABASE_URL || !SUPABASE_ANON_KEY;
const MSG_ID = process.env.TEST_MESSAGE_ID;

describe.skipIf(SKIP || !MSG_ID)("SupabaseDraftStore", () => {
  let store: SupabaseDraftStore;
  beforeAll(() => {
    store = new SupabaseDraftStore({ url: SUPABASE_URL, anonKey: SUPABASE_ANON_KEY });
  });

  it("inserts a pending draft and finds it", async () => {
    const draft = await store.insert({
      message_id: MSG_ID!,
      proposed_body: "test draft",
      agent_reasoning: "for testing",
      tools_called: [],
    });
    expect(draft.status).toBe("pending");
    const found = await store.findPendingByMessageId(MSG_ID!);
    expect(found?.id).toBe(draft.id);
  });
});
