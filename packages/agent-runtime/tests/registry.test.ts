import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MockRuntime } from "../src/mock-runtime.js";
import {
  _resetRuntimeRegistry,
  findProvider,
  listProviders,
  registerRuntime,
  resolveRuntime,
} from "../src/registry.js";

beforeEach(() => {
  _resetRuntimeRegistry();
});

afterEach(() => {
  _resetRuntimeRegistry();
});

describe("runtime registry", () => {
  it("registers and lists providers", () => {
    registerRuntime({
      prefix: "test-",
      apiKeyEnv: "TEST_KEY",
      name: "Test",
      factory: () => new MockRuntime(),
    });
    expect(listProviders().map((p) => p.prefix)).toEqual(["test-"]);
  });

  it("findProvider matches by prefix", () => {
    registerRuntime({
      prefix: "claude-",
      apiKeyEnv: "ANTHROPIC_API_KEY",
      name: "Anthropic",
      factory: () => new MockRuntime(),
    });
    expect(findProvider("claude-sonnet-4-6")?.name).toBe("Anthropic");
    expect(findProvider("gpt-4")).toBeUndefined();
  });

  it("re-registering same prefix replaces the provider", () => {
    const f1 = vi.fn(() => new MockRuntime());
    const f2 = vi.fn(() => new MockRuntime());
    registerRuntime({ prefix: "x-", apiKeyEnv: "X", name: "First", factory: f1 });
    registerRuntime({ prefix: "x-", apiKeyEnv: "X", name: "Second", factory: f2 });
    expect(listProviders()).toHaveLength(1);
    expect(findProvider("x-foo")?.name).toBe("Second");
  });

  it("resolveRuntime constructs and initializes via the matching provider", async () => {
    const mock = new MockRuntime();
    const init = vi.spyOn(mock, "initialize");
    registerRuntime({
      prefix: "demo-",
      apiKeyEnv: "DEMO_KEY",
      name: "Demo",
      factory: () => mock,
    });

    const rt = await resolveRuntime("demo-fast", { DEMO_KEY: "secret" });
    expect(rt).toBe(mock);
    expect(init).toHaveBeenCalledWith({ apiKey: "secret", defaultModel: "demo-fast" });
  });

  it("resolveRuntime throws when no provider matches the prefix", async () => {
    registerRuntime({
      prefix: "claude-",
      apiKeyEnv: "ANTHROPIC_API_KEY",
      name: "Anthropic",
      factory: () => new MockRuntime(),
    });
    await expect(resolveRuntime("gpt-4", {})).rejects.toThrow(
      /No runtime provider for model "gpt-4"/,
    );
  });

  it("resolveRuntime throws when the required API key is missing", async () => {
    registerRuntime({
      prefix: "claude-",
      apiKeyEnv: "ANTHROPIC_API_KEY",
      name: "Anthropic",
      factory: () => new MockRuntime(),
    });
    await expect(resolveRuntime("claude-sonnet-4-6", {})).rejects.toThrow(
      /requires ANTHROPIC_API_KEY/,
    );
  });
});
