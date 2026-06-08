import { describe, expect, it } from "vitest";
import { EpisodicMemoryBuilder } from "../src/episodic.js";

const fakeContactStore = {
  findById: async (_w: string, id: string) =>
    id === "c1"
      ? {
          id: "c1",
          workspace_id: "w1",
          display_name: "Test",
          notes: "Likes coffee.",
          created_at: "",
        }
      : null,
  upsertByDisplayName: async () => {
    throw new Error("not used");
  },
  updateNotes: async () => {
    throw new Error("not used");
  },
};

describe("EpisodicMemoryBuilder", () => {
  it("returns contact notes", async () => {
    const b = new EpisodicMemoryBuilder(fakeContactStore as any);
    const notes = await b.build("w1", "c1");
    expect(notes).toBe("Likes coffee.");
  });

  it("returns empty string if contact not found", async () => {
    const b = new EpisodicMemoryBuilder(fakeContactStore as any);
    const notes = await b.build("w1", "missing");
    expect(notes).toBe("");
  });
});
