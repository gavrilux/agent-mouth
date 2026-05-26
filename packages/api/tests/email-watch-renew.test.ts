import { describe, expect, it, vi } from "vitest";
import { handleEmailWatchRenew } from "../src/email-watch-renew.js";

describe("handleEmailWatchRenew", () => {
  it("calls driver.watch for each active token and updates expiration", async () => {
    const tokens = [
      { id: "t1", email_address: "a@a.com", refresh_token_encrypted: "e", status: "active", consecutive_renewal_failures: 0 },
    ];
    const watch = vi.fn(async () => ({ history_id: "999", expiration: "2026-06-15T00:00:00.000Z" }));
    const updateWatchExpiration = vi.fn(async () => undefined);
    const incrementRenewalFailures = vi.fn(async () => 1);
    const markError = vi.fn(async () => undefined);
    const decrypt = vi.fn(() => "rt");

    await handleEmailWatchRenew({
      tokenStore: { list: vi.fn(async () => tokens), updateWatchExpiration, incrementRenewalFailures, markError } as never,
      driver: { watch } as never,
      decrypt,
      encryptionKey: "k",
      topicName: "projects/p/topics/x",
    });
    expect(watch).toHaveBeenCalled();
    expect(updateWatchExpiration).toHaveBeenCalledWith("t1", "2026-06-15T00:00:00.000Z");
  });

  it("marks status=error after 3 consecutive failures", async () => {
    const tokens = [
      { id: "t1", email_address: "a@a.com", refresh_token_encrypted: "e", status: "active", consecutive_renewal_failures: 2 },
    ];
    const watch = vi.fn(async () => { throw new Error("API down"); });
    const incrementRenewalFailures = vi.fn(async () => 3);
    const markError = vi.fn(async () => undefined);

    await handleEmailWatchRenew({
      tokenStore: { list: vi.fn(async () => tokens), updateWatchExpiration: vi.fn(), incrementRenewalFailures, markError } as never,
      driver: { watch } as never,
      decrypt: vi.fn(() => "rt"),
      encryptionKey: "k",
      topicName: "x",
    });
    expect(incrementRenewalFailures).toHaveBeenCalledWith("t1");
    expect(markError).toHaveBeenCalled();
  });

  it("skips inactive tokens", async () => {
    const tokens = [
      { id: "t1", email_address: "a@a.com", refresh_token_encrypted: "e", status: "revoked", consecutive_renewal_failures: 0 },
    ];
    const watch = vi.fn();
    await handleEmailWatchRenew({
      tokenStore: { list: vi.fn(async () => tokens), updateWatchExpiration: vi.fn(), incrementRenewalFailures: vi.fn(), markError: vi.fn() } as never,
      driver: { watch } as never,
      decrypt: vi.fn(),
      encryptionKey: "k",
      topicName: "x",
    });
    expect(watch).not.toHaveBeenCalled();
  });
});
