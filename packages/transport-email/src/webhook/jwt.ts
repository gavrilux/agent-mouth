// packages/transport-email/src/webhook/jwt.ts
import { createLocalJWKSet, jwtVerify } from "jose";

const GOOGLE_JWKS_URL = "https://www.googleapis.com/oauth2/v3/certs";
const CACHE_TTL_MS = 60 * 60 * 1000; // 1h

interface JwksCache {
  keys: object;
  fetchedAt: number;
}

let jwksCache: JwksCache | null = null;

async function fetchJwks(): Promise<object> {
  if (jwksCache && Date.now() - jwksCache.fetchedAt < CACHE_TTL_MS) {
    return jwksCache.keys;
  }
  const res = await globalThis.fetch(GOOGLE_JWKS_URL);
  if (!res.ok) {
    throw new Error(`Failed to fetch Google JWKS: HTTP ${res.status}`);
  }
  const keys = (await res.json()) as object;
  jwksCache = { keys, fetchedAt: Date.now() };
  return keys;
}

export interface GooglePushJwtPayload {
  email: string; // service account email
  email_verified?: boolean;
  iss: string;
  aud: string;
  exp: number;
  iat: number;
  sub: string;
}

export async function verifyGooglePushJwt(
  token: string,
  opts: { audience: string; serviceAccountEmail: string },
): Promise<GooglePushJwtPayload> {
  const jwksJson = await fetchJwks();
  const jwks = createLocalJWKSet(jwksJson as Parameters<typeof createLocalJWKSet>[0]);
  const { payload } = await jwtVerify(token, jwks, {
    issuer: "https://accounts.google.com",
    audience: opts.audience,
  });
  const p = payload as unknown as GooglePushJwtPayload;
  if (p.email !== opts.serviceAccountEmail) {
    throw new Error(
      `service account email mismatch: expected=${opts.serviceAccountEmail} got=${p.email}`,
    );
  }
  return p;
}

/** Test-only: clear cached JWKS to force re-fetch (used in unit tests). */
export function _resetJwksCache(): void {
  jwksCache = null;
}
