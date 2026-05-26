export type { EmailDriver } from "./drivers/driver.js";
export type {
  EmailDriverAuthCtx,
  FetchResult,
  SendEmailArgs,
  SendEmailResult,
  WatchResult,
} from "./types.js";
export { GmailDriver } from "./drivers/gmail-driver.js";
export type { GmailDriverConfig } from "./drivers/gmail-driver.js";
export { buildAuthUrl, exchangeCodeForTokens, refreshAccessToken } from "./oauth/google.js";
export type { OAuthTokens } from "./oauth/google.js";
export { encryptToken, decryptToken } from "./oauth/crypto.js";
export { gmailMessageToInbound, gmailMessageToNormalized } from "./normalize.js";
export { buildMime, mimeToBase64Url } from "./mime.js";
export { EmailTransport } from "./email-transport.js";
export type { EmailTransportOptions } from "./email-transport.js";
