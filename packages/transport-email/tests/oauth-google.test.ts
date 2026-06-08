import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildAuthUrl, exchangeCodeForTokens, refreshAccessToken } from "../src/oauth/google.js";

describe("buildAuthUrl", () => {
  it("includes client_id, redirect_uri, scopes and access_type=offline", () => {
    const url = buildAuthUrl({
      clientId: "abc.apps.googleusercontent.com",
      redirectUri: "http://localhost:53682/callback",
      scopes: ["https://www.googleapis.com/auth/gmail.readonly"],
    });
    const u = new URL(url);
    expect(u.origin + u.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(u.searchParams.get("client_id")).toBe("abc.apps.googleusercontent.com");
    expect(u.searchParams.get("redirect_uri")).toBe("http://localhost:53682/callback");
    expect(u.searchParams.get("response_type")).toBe("code");
    expect(u.searchParams.get("access_type")).toBe("offline");
    expect(u.searchParams.get("prompt")).toBe("consent");
    expect(u.searchParams.get("scope")).toBe("https://www.googleapis.com/auth/gmail.readonly");
  });
});

describe("exchangeCodeForTokens", () => {
  const origFetch = globalThis.fetch;
  beforeEach(() => {
    globalThis.fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            access_token: "ya29.abc",
            refresh_token: "1//refresh_xyz",
            expires_in: 3599,
            scope: "https://www.googleapis.com/auth/gmail.readonly",
            token_type: "Bearer",
          }),
          { status: 200 },
        ),
    ) as never;
  });
  afterEach(() => {
    globalThis.fetch = origFetch;
  });

  it("posts form to token endpoint and returns parsed tokens", async () => {
    const r = await exchangeCodeForTokens({
      clientId: "abc",
      clientSecret: "shh",
      redirectUri: "http://localhost:53682/callback",
      code: "AUTH_CODE",
    });
    expect(r.access_token).toBe("ya29.abc");
    expect(r.refresh_token).toBe("1//refresh_xyz");
    expect(r.expires_in).toBe(3599);
    expect(globalThis.fetch).toHaveBeenCalledWith(
      "https://oauth2.googleapis.com/token",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("throws on non-2xx response", async () => {
    globalThis.fetch = vi.fn(async () => new Response("bad", { status: 400 })) as never;
    await expect(
      exchangeCodeForTokens({ clientId: "x", clientSecret: "x", redirectUri: "x", code: "x" }),
    ).rejects.toThrow(/code exchange failed: 400/);
  });
});

describe("refreshAccessToken", () => {
  const origFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = origFetch;
  });

  it("posts refresh_token and returns access_token", async () => {
    globalThis.fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ access_token: "ya29.new", expires_in: 3599, token_type: "Bearer" }),
          { status: 200 },
        ),
    ) as never;
    const r = await refreshAccessToken({ clientId: "c", clientSecret: "s", refreshToken: "rt" });
    expect(r.access_token).toBe("ya29.new");
    expect(r.expires_in).toBe(3599);
  });

  it("throws ExpiredRefreshTokenError on invalid_grant", async () => {
    globalThis.fetch = vi.fn(
      async () => new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 }),
    ) as never;
    await expect(
      refreshAccessToken({ clientId: "c", clientSecret: "s", refreshToken: "bad" }),
    ).rejects.toThrow(/invalid_grant/);
  });
});
