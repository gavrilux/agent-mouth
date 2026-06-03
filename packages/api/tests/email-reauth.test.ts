import { describe, expect, it } from "vitest";
import { EMAIL_OAUTH_SCOPES, buildEmailReauthUrl, createStateStore } from "../src/email-reauth.js";

describe("createStateStore (CSRF state)", () => {
  it("accepts an issued state exactly once (single-use)", () => {
    const store = createStateStore(1000);
    store.issue("abc", 0);
    expect(store.consume("abc", 100)).toBe(true);
    expect(store.consume("abc", 100)).toBe(false); // already consumed
  });

  it("rejects an unknown state", () => {
    const store = createStateStore(1000);
    expect(store.consume("never-issued", 0)).toBe(false);
  });

  it("rejects an expired state", () => {
    const store = createStateStore(1000);
    store.issue("abc", 0);
    expect(store.consume("abc", 2000)).toBe(false); // past TTL
  });
});

describe("buildEmailReauthUrl", () => {
  it("builds a Google consent URL with state, public redirect, offline+consent and gmail scopes", () => {
    const url = new URL(
      buildEmailReauthUrl({
        clientId: "cid",
        redirectUri: "https://agent-mouth.fly.dev/email-oauth-callback",
        state: "st8",
      }),
    );
    expect(url.searchParams.get("client_id")).toBe("cid");
    expect(url.searchParams.get("redirect_uri")).toBe(
      "https://agent-mouth.fly.dev/email-oauth-callback",
    );
    expect(url.searchParams.get("state")).toBe("st8");
    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(url.searchParams.get("prompt")).toBe("consent");
    expect(url.searchParams.get("scope")).toContain("gmail.modify");
  });

  it("requests all three gmail scopes the agent needs", () => {
    expect(EMAIL_OAUTH_SCOPES).toEqual([
      "https://www.googleapis.com/auth/gmail.readonly",
      "https://www.googleapis.com/auth/gmail.send",
      "https://www.googleapis.com/auth/gmail.modify",
    ]);
  });
});
