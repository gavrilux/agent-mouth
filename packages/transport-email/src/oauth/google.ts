// packages/transport-email/src/oauth/google.ts

const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";

export interface OAuthTokens {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  scope?: string;
  token_type: string;
}

export function buildAuthUrl(args: {
  clientId: string;
  redirectUri: string;
  scopes: string[];
  state?: string;
}): string {
  const params = new URLSearchParams({
    client_id: args.clientId,
    redirect_uri: args.redirectUri,
    response_type: "code",
    access_type: "offline",
    prompt: "consent",
    scope: args.scopes.join(" "),
  });
  if (args.state) params.set("state", args.state);
  return `${AUTH_URL}?${params.toString()}`;
}

export async function exchangeCodeForTokens(args: {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  code: string;
}): Promise<OAuthTokens> {
  const form = new URLSearchParams({
    client_id: args.clientId,
    client_secret: args.clientSecret,
    redirect_uri: args.redirectUri,
    code: args.code,
    grant_type: "authorization_code",
  });
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: form.toString(),
  });
  if (!res.ok) {
    throw new Error(`code exchange failed: ${res.status} ${await res.text()}`);
  }
  return (await res.json()) as OAuthTokens;
}

export async function refreshAccessToken(args: {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}): Promise<OAuthTokens> {
  const form = new URLSearchParams({
    client_id: args.clientId,
    client_secret: args.clientSecret,
    refresh_token: args.refreshToken,
    grant_type: "refresh_token",
  });
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: form.toString(),
  });
  if (!res.ok) {
    const body = await res.text();
    if (body.includes("invalid_grant")) {
      throw new Error(`invalid_grant — refresh token revoked or expired: ${body}`);
    }
    throw new Error(`token refresh failed: ${res.status} ${body}`);
  }
  return (await res.json()) as OAuthTokens;
}
