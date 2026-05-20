import { describe, it, expect } from "vitest";
import type { OffsetStore } from "../src/offset-store";

describe("OffsetStore interface", () => {
  it("requires getOffset and saveOffset methods", () => {
    const stub: OffsetStore = {
      getOffset: async () => 0,
      saveOffset: async () => {},
    };
    expect(stub).toBeDefined();
  });
});
