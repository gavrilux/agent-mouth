import { describe, expect, it, vi } from "vitest";
import { handleEmailPollFallback } from "../src/email-poll-fallback.js";

describe("handleEmailPollFallback", () => {
  it("iterates active tokens and triggers email.fetch logic for each", async () => {
    const tokens = [
      {
        id: "t1",
        workspace_id: "ws1",
        channel_id: "ch1",
        email_address: "a@a.com",
        refresh_token_encrypted: "e",
        scopes: [],
        last_history_id: "10",
        watch_expiration: null,
        status: "active",
        last_error: null,
        consecutive_renewal_failures: 0,
        created_at: "x",
        updated_at: "x",
      },
      {
        id: "t2",
        workspace_id: "ws1",
        channel_id: "ch2",
        email_address: "b@b.com",
        refresh_token_encrypted: "e",
        scopes: [],
        last_history_id: "20",
        watch_expiration: null,
        status: "active",
        last_error: null,
        consecutive_renewal_failures: 0,
        created_at: "x",
        updated_at: "x",
      },
    ];
    const tokenStore = { list: vi.fn(async () => tokens) };
    const fetchOne = vi.fn(async () => undefined);

    await handleEmailPollFallback({
      tokenStore: tokenStore as never,
      fetchOne: fetchOne as never,
    });
    expect(fetchOne).toHaveBeenCalledTimes(2);
    expect(fetchOne).toHaveBeenCalledWith("a@a.com", "10");
    expect(fetchOne).toHaveBeenCalledWith("b@b.com", "20");
  });

  it("skips non-active tokens", async () => {
    const tokens = [
      {
        id: "t1",
        workspace_id: "ws1",
        channel_id: "ch1",
        email_address: "a@a.com",
        refresh_token_encrypted: "e",
        scopes: [],
        last_history_id: "10",
        watch_expiration: null,
        status: "error",
        last_error: null,
        consecutive_renewal_failures: 0,
        created_at: "x",
        updated_at: "x",
      },
    ];
    const tokenStore = { list: vi.fn(async () => tokens) };
    const fetchOne = vi.fn();
    await handleEmailPollFallback({
      tokenStore: tokenStore as never,
      fetchOne: fetchOne as never,
    });
    expect(fetchOne).not.toHaveBeenCalled();
  });

  it("continues on per-token failure", async () => {
    const tokens = [
      {
        id: "t1",
        email_address: "a@a.com",
        last_history_id: "10",
        status: "active",
        refresh_token_encrypted: "e",
        workspace_id: "x",
        channel_id: "x",
        scopes: [],
        watch_expiration: null,
        last_error: null,
        consecutive_renewal_failures: 0,
        created_at: "x",
        updated_at: "x",
      },
      {
        id: "t2",
        email_address: "b@b.com",
        last_history_id: "20",
        status: "active",
        refresh_token_encrypted: "e",
        workspace_id: "x",
        channel_id: "x",
        scopes: [],
        watch_expiration: null,
        last_error: null,
        consecutive_renewal_failures: 0,
        created_at: "x",
        updated_at: "x",
      },
    ];
    const tokenStore = { list: vi.fn(async () => tokens) };
    const fetchOne = vi
      .fn()
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce(undefined);

    await handleEmailPollFallback({
      tokenStore: tokenStore as never,
      fetchOne: fetchOne as never,
    });
    expect(fetchOne).toHaveBeenCalledTimes(2);
  });
});
