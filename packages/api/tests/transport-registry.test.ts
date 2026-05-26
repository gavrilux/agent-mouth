import { describe, expect, it, vi } from "vitest";
import { TransportRegistry } from "../src/transports/registry.js";

describe("TransportRegistry", () => {
  it("registers and gets transports by ChannelType", () => {
    const reg = new TransportRegistry();
    const tg = { send: vi.fn() } as never;
    const em = { send: vi.fn() } as never;
    reg.register("telegram", tg);
    reg.register("email", em);
    expect(reg.get("telegram")).toBe(tg);
    expect(reg.get("email")).toBe(em);
  });

  it("throws on get of unregistered type", () => {
    const reg = new TransportRegistry();
    expect(() => reg.get("whatsapp")).toThrow(/no transport.*whatsapp/i);
  });

  it("has(type) returns boolean", () => {
    const reg = new TransportRegistry();
    expect(reg.has("telegram")).toBe(false);
    reg.register("telegram", {} as never);
    expect(reg.has("telegram")).toBe(true);
  });

  it("list() returns all registered channel types", () => {
    const reg = new TransportRegistry();
    reg.register("telegram", {} as never);
    reg.register("email", {} as never);
    expect(reg.list().sort()).toEqual(["email", "telegram"]);
  });
});
