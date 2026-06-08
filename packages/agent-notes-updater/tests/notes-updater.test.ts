import { MockRuntime } from "@agent-mouth/agent-runtime";
import { describe, expect, it, vi } from "vitest";
import { NotesUpdater } from "../src/notes-updater.js";

const thread = {
  id: "t1",
  workspace_id: "w1",
  contact_id: "c1",
  channel_id: "ch1",
  external_thread_id: null,
  related_thread_ids: [],
  last_message_at: null,
  closed: false,
  notes_last_updated_at: null,
  created_at: new Date(Date.now() - 86400_000).toISOString(),
};

const baseDeps = (msgCount: number, opts?: { closed?: boolean; throttleHours?: number }) => ({
  threads: {
    resolveOrCreate: vi.fn(),
    get: async () =>
      ({
        ...thread,
        closed: opts?.closed ?? false,
        notes_last_updated_at: opts?.throttleHours
          ? new Date(Date.now() - opts.throttleHours * 3600_000).toISOString()
          : null,
      }) as any,
    markNotesUpdated: vi.fn(async () => {}),
  },
  messages: {
    insert: vi.fn(),
    lastN: async () => [] as any,
    countSinceTimestamp: async () => msgCount,
  },
  contacts: {
    findById: async () =>
      ({ id: "c1", workspace_id: "w1", display_name: "G", notes: "prev", created_at: "" }) as any,
    upsertByDisplayName: vi.fn(),
    updateNotes: vi.fn(async () => {}),
  },
  audit: {
    sumCostUsdSince: vi.fn(),
    countSentOrDraftSince: vi.fn(),
    findRespondedFor: vi.fn(),
    write: vi.fn(async () => ({}) as any),
  },
});

describe("NotesUpdater", () => {
  it("skips when fewer than 5 msgs since last update and not closed", async () => {
    const deps = baseDeps(3);
    const rt = new MockRuntime();
    await rt.initialize({ body: "should not run" });
    const u = new NotesUpdater({ runtime: rt, ...deps } as any);
    await u.maybeUpdate({ workspaceId: "w1", contactId: "c1", threadId: "t1" });
    expect(deps.contacts.updateNotes).not.toHaveBeenCalled();
  });

  it("runs when 5+ msgs", async () => {
    const deps = baseDeps(5);
    const rt = new MockRuntime();
    await rt.initialize({ body: "G mentioned Tokyo trip in April." });
    const u = new NotesUpdater({ runtime: rt, ...deps } as any);
    await u.maybeUpdate({ workspaceId: "w1", contactId: "c1", threadId: "t1" });
    expect(deps.contacts.updateNotes).toHaveBeenCalledWith("c1", expect.stringContaining("Tokyo"));
  });

  it("skips NO_CHANGE response without updating", async () => {
    const deps = baseDeps(6);
    const rt = new MockRuntime();
    await rt.initialize({ body: "NO_CHANGE" });
    const u = new NotesUpdater({ runtime: rt, ...deps } as any);
    await u.maybeUpdate({ workspaceId: "w1", contactId: "c1", threadId: "t1" });
    expect(deps.contacts.updateNotes).not.toHaveBeenCalled();
  });

  it("throttles when notes were updated < 1h ago", async () => {
    const deps = baseDeps(20, { throttleHours: 0.5 });
    const rt = new MockRuntime();
    await rt.initialize({ body: "should not run" });
    const u = new NotesUpdater({ runtime: rt, ...deps } as any);
    await u.maybeUpdate({ workspaceId: "w1", contactId: "c1", threadId: "t1" });
    expect(deps.contacts.updateNotes).not.toHaveBeenCalled();
  });
});
