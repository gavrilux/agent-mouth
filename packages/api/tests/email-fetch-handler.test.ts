import { describe, expect, it, vi } from "vitest";
import { handleEmailFetch } from "../src/email-fetch.js";

describe("handleEmailFetch", () => {
  it("fetches new messages, persists, calls processInbound", async () => {
    const decryptToken = vi.fn(() => "1//refresh_xyz");
    const fetchNewMessages = vi.fn(async () => ({
      messages: [
        {
          external_id: "m1",
          external_thread_id: "t1",
          from_address: "marco@thecuina.com",
          from_name: "Marco",
          to_addresses: ["gavrilux.agent@gmail.com"],
          cc_addresses: [],
          subject: "Hi",
          body_text: "hello",
          body_html: null,
          message_id_header: "<a@b>",
          in_reply_to_header: null,
          references_header: [],
          received_at: "2026-05-25T10:00:00.000Z",
        },
      ],
      next_cursor: "999",
    }));
    const updateCursor = vi.fn(async () => undefined);
    const processInbound = vi.fn(async () => ({
      kind: "persisted" as const,
      policy: "auto" as const,
      messageId: "msg-uuid",
      contactId: "c",
      threadId: "th",
      channelType: "email" as const,
      channelId: "ch",
      channelIdentityId: "ci",
      externalChatId: "x",
      messageContent: "hello",
    }));
    const queueSend = vi.fn(async () => undefined);

    const tokenStore = {
      getByAddress: vi.fn(async () => ({
        id: "tok1",
        workspace_id: "ws1",
        channel_id: "ch1",
        email_address: "gavrilux.agent@gmail.com",
        refresh_token_encrypted: "encrypted",
        scopes: [],
        last_history_id: "100",
        watch_expiration: null,
        status: "active" as const,
        last_error: null,
        consecutive_renewal_failures: 0,
        created_at: "2026-05-25T00:00:00.000Z",
        updated_at: "2026-05-25T00:00:00.000Z",
      })),
      updateCursor,
    };

    await handleEmailFetch({
      data: { email_address: "gavrilux.agent@gmail.com", history_id: "150" },
      workspaceId: "ws1",
      tokenStore: tokenStore as never,
      driver: { fetchNewMessages } as never,
      decrypt: decryptToken,
      encryptionKey: "k",
      routerDeps: {} as never,
      processInbound: processInbound as never,
      queueSend: queueSend as never,
    });

    expect(decryptToken).toHaveBeenCalledWith("encrypted", "k");
    expect(fetchNewMessages).toHaveBeenCalledWith({
      auth: { refresh_token: "1//refresh_xyz", email_address: "gavrilux.agent@gmail.com" },
      last_cursor: "100",
    });
    expect(processInbound).toHaveBeenCalledTimes(1);
    expect(updateCursor).toHaveBeenCalledWith("tok1", "999");
    expect(queueSend).toHaveBeenCalledWith(
      "agent.respond",
      expect.objectContaining({ messageId: "msg-uuid" }),
      expect.any(Object),
    );
  });

  it("skips when token not active", async () => {
    const fetchNewMessages = vi.fn();
    const processInbound = vi.fn();
    const tokenStore = {
      getByAddress: vi.fn(async () => ({
        id: "tok1",
        workspace_id: "ws1",
        channel_id: "ch1",
        email_address: "x@x.com",
        refresh_token_encrypted: "e",
        scopes: [],
        last_history_id: null,
        watch_expiration: null,
        status: "revoked" as const,
        last_error: null,
        consecutive_renewal_failures: 0,
        created_at: "2026-05-25T00:00:00.000Z",
        updated_at: "2026-05-25T00:00:00.000Z",
      })),
      updateCursor: vi.fn(),
    };
    await handleEmailFetch({
      data: { email_address: "x@x.com", history_id: "1" },
      workspaceId: "ws1",
      tokenStore: tokenStore as never,
      driver: { fetchNewMessages } as never,
      decrypt: vi.fn(),
      encryptionKey: "k",
      routerDeps: {} as never,
      processInbound: processInbound as never,
      queueSend: vi.fn(),
    });
    expect(fetchNewMessages).not.toHaveBeenCalled();
    expect(processInbound).not.toHaveBeenCalled();
  });

  it("skips agent.respond when policy is silent", async () => {
    const processInbound = vi.fn(async () => ({
      kind: "persisted" as const,
      policy: "silent" as const,
    }));
    const queueSend = vi.fn();
    const tokenStore = {
      getByAddress: vi.fn(async () => ({
        id: "tok1",
        workspace_id: "ws1",
        channel_id: "ch1",
        email_address: "x@x.com",
        refresh_token_encrypted: "e",
        scopes: [],
        last_history_id: "1",
        watch_expiration: null,
        status: "active" as const,
        last_error: null,
        consecutive_renewal_failures: 0,
        created_at: "2026-05-25T00:00:00.000Z",
        updated_at: "2026-05-25T00:00:00.000Z",
      })),
      updateCursor: vi.fn(),
    };
    await handleEmailFetch({
      data: { email_address: "x@x.com", history_id: "2" },
      workspaceId: "ws1",
      tokenStore: tokenStore as never,
      driver: {
        fetchNewMessages: vi.fn(async () => ({
          messages: [
            {
              external_id: "m1",
              external_thread_id: "t1",
              from_address: "y@y.com",
              from_name: null,
              to_addresses: ["x@x.com"],
              cc_addresses: [],
              subject: "",
              body_text: "x",
              body_html: null,
              message_id_header: "<a>",
              in_reply_to_header: null,
              references_header: [],
              received_at: "2026-05-25T00:00:00.000Z",
            },
          ],
          next_cursor: "2",
        })),
      } as never,
      decrypt: vi.fn(() => "rt"),
      encryptionKey: "k",
      routerDeps: {} as never,
      processInbound: processInbound as never,
      queueSend: queueSend as never,
    });
    expect(processInbound).toHaveBeenCalledTimes(1);
    expect(queueSend).not.toHaveBeenCalled();
  });

  it("marks token status=error when the driver fails with invalid_grant", async () => {
    const markError = vi.fn(async () => undefined);
    const tokenStore = {
      getByAddress: vi.fn(async () => ({
        id: "tok1",
        workspace_id: "ws1",
        channel_id: "ch1",
        email_address: "gavrilux.agent@gmail.com",
        refresh_token_encrypted: "e",
        scopes: [],
        last_history_id: "1",
        watch_expiration: null,
        status: "active" as const,
        last_error: null,
        consecutive_renewal_failures: 0,
        created_at: "2026-05-25T00:00:00.000Z",
        updated_at: "2026-05-25T00:00:00.000Z",
      })),
      updateCursor: vi.fn(),
      markError,
    };
    await handleEmailFetch({
      data: { email_address: "gavrilux.agent@gmail.com", history_id: "1" },
      workspaceId: "ws1",
      tokenStore: tokenStore as never,
      driver: {
        fetchNewMessages: vi.fn(async () => {
          throw new Error("invalid_grant — refresh token revoked or expired");
        }),
      } as never,
      decrypt: vi.fn(() => "rt"),
      encryptionKey: "k",
      routerDeps: {} as never,
      processInbound: vi.fn() as never,
      queueSend: vi.fn() as never,
    });
    expect(markError).toHaveBeenCalledTimes(1);
    expect(markError).toHaveBeenCalledWith("tok1", expect.stringContaining("invalid_grant"));
  });

  it("does NOT mark error on a transient (non-invalid_grant) driver failure", async () => {
    const markError = vi.fn(async () => undefined);
    const tokenStore = {
      getByAddress: vi.fn(async () => ({
        id: "tok1",
        workspace_id: "ws1",
        channel_id: "ch1",
        email_address: "x@x.com",
        refresh_token_encrypted: "e",
        scopes: [],
        last_history_id: "1",
        watch_expiration: null,
        status: "active" as const,
        last_error: null,
        consecutive_renewal_failures: 0,
        created_at: "2026-05-25T00:00:00.000Z",
        updated_at: "2026-05-25T00:00:00.000Z",
      })),
      updateCursor: vi.fn(),
      markError,
    };
    await handleEmailFetch({
      data: { email_address: "x@x.com", history_id: "1" },
      workspaceId: "ws1",
      tokenStore: tokenStore as never,
      driver: {
        fetchNewMessages: vi.fn(async () => {
          throw new Error("ECONNRESET socket hang up");
        }),
      } as never,
      decrypt: vi.fn(() => "rt"),
      encryptionKey: "k",
      routerDeps: {} as never,
      processInbound: vi.fn() as never,
      queueSend: vi.fn() as never,
    });
    expect(markError).not.toHaveBeenCalled();
  });
});
