import { generateKeyPair, exportJWK, SignJWT } from "jose";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { verifyGooglePushJwt, _resetJwksCache } from "../src/webhook/jwt.js";

// We generate a local keypair to sign test JWTs, then mock Google JWKS to return our public key.
async function makeSignedJwt(payload: Record<string, unknown>, opts: { iss: string; aud: string; expSec?: number }) {
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const pubJwk = await exportJWK(publicKey);
  pubJwk.kid = "test-key-1";
  pubJwk.alg = "RS256";
  pubJwk.use = "sig";
  const jwt = await new SignJWT(payload)
    .setProtectedHeader({ alg: "RS256", kid: "test-key-1" })
    .setIssuer(opts.iss)
    .setAudience(opts.aud)
    .setIssuedAt()
    .setExpirationTime(Math.floor(Date.now() / 1000) + (opts.expSec ?? 600))
    .sign(privateKey);
  return { jwt, pubJwk };
}

const origFetch = globalThis.fetch;
beforeEach(() => { _resetJwksCache(); });
afterEach(() => { globalThis.fetch = origFetch; });

describe("verifyGooglePushJwt", () => {
  it("accepts a valid JWT with correct iss + aud", async () => {
    const { jwt, pubJwk } = await makeSignedJwt(
      { email: "service@p.iam.gserviceaccount.com" },
      { iss: "https://accounts.google.com", aud: "https://agent-mouth.fly.dev/email-webhook" },
    );
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({ keys: [pubJwk] }), { status: 200 })) as never;

    const payload = await verifyGooglePushJwt(jwt, {
      audience: "https://agent-mouth.fly.dev/email-webhook",
      serviceAccountEmail: "service@p.iam.gserviceaccount.com",
    });
    expect(payload.email).toBe("service@p.iam.gserviceaccount.com");
  });

  it("rejects wrong issuer", async () => {
    const { jwt, pubJwk } = await makeSignedJwt(
      { email: "service@p.iam.gserviceaccount.com" },
      { iss: "https://evil.com", aud: "https://agent-mouth.fly.dev/email-webhook" },
    );
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({ keys: [pubJwk] }), { status: 200 })) as never;

    await expect(
      verifyGooglePushJwt(jwt, {
        audience: "https://agent-mouth.fly.dev/email-webhook",
        serviceAccountEmail: "service@p.iam.gserviceaccount.com",
      }),
    ).rejects.toThrow();
  });

  it("rejects wrong audience", async () => {
    const { jwt, pubJwk } = await makeSignedJwt(
      { email: "service@p.iam.gserviceaccount.com" },
      { iss: "https://accounts.google.com", aud: "https://other.example.com" },
    );
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({ keys: [pubJwk] }), { status: 200 })) as never;

    await expect(
      verifyGooglePushJwt(jwt, {
        audience: "https://agent-mouth.fly.dev/email-webhook",
        serviceAccountEmail: "service@p.iam.gserviceaccount.com",
      }),
    ).rejects.toThrow();
  });

  it("rejects wrong service account email", async () => {
    const { jwt, pubJwk } = await makeSignedJwt(
      { email: "attacker@p.iam.gserviceaccount.com" },
      { iss: "https://accounts.google.com", aud: "https://agent-mouth.fly.dev/email-webhook" },
    );
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({ keys: [pubJwk] }), { status: 200 })) as never;

    await expect(
      verifyGooglePushJwt(jwt, {
        audience: "https://agent-mouth.fly.dev/email-webhook",
        serviceAccountEmail: "service@p.iam.gserviceaccount.com",
      }),
    ).rejects.toThrow(/service.*account/i);
  });

  it("rejects expired JWT", async () => {
    const { jwt, pubJwk } = await makeSignedJwt(
      { email: "service@p.iam.gserviceaccount.com" },
      { iss: "https://accounts.google.com", aud: "https://agent-mouth.fly.dev/email-webhook", expSec: -10 },
    );
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({ keys: [pubJwk] }), { status: 200 })) as never;

    await expect(
      verifyGooglePushJwt(jwt, {
        audience: "https://agent-mouth.fly.dev/email-webhook",
        serviceAccountEmail: "service@p.iam.gserviceaccount.com",
      }),
    ).rejects.toThrow();
  });
});
