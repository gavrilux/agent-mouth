// packages/transport-email/src/normalize.ts
import type { InboundMessage, NormalizedEmail } from "@agent-mouth/core";

interface GmailHeader {
  name: string;
  value: string;
}

interface GmailBody {
  data?: string;
  size?: number;
}

interface GmailPart {
  mimeType?: string;
  headers?: GmailHeader[];
  body?: GmailBody;
  parts?: GmailPart[];
}

interface GmailMessage {
  id: string;
  threadId: string;
  internalDate?: string;
  payload: GmailPart;
}

function headerValue(
  headers: GmailHeader[] | undefined,
  name: string
): string | undefined {
  return headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value;
}

/**
 * Parse "Name <addr@dom>" or "addr@dom" into {name, address}.
 * Returns lower-cased address.
 */
function parseAddress(raw: string): { name: string | null; address: string } {
  const m = raw.match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/);
  if (m) {
    const name = (m[1] ?? "").trim();
    return {
      name: name.length ? name : null,
      address: (m[2] ?? "").trim().toLowerCase(),
    };
  }
  return { name: null, address: raw.trim().toLowerCase() };
}

function parseAddressList(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => parseAddress(s).address)
    .filter((s) => s.length > 0);
}

function findPart(part: GmailPart, mimeType: string): GmailPart | null {
  if (part.mimeType === mimeType) return part;
  for (const child of part.parts ?? []) {
    const hit = findPart(child, mimeType);
    if (hit) return hit;
  }
  return null;
}

function decodeBody(part: GmailPart | null): string | null {
  if (!part?.body?.data) return null;
  return Buffer.from(part.body.data, "base64url").toString("utf8");
}

function stripHtmlToText(html: string): string {
  return html.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
}

export function gmailMessageToNormalized(msg: GmailMessage): NormalizedEmail {
  const headers = msg.payload.headers ?? [];
  const fromRaw = headerValue(headers, "From") ?? "";
  const from = parseAddress(fromRaw);
  const subject = headerValue(headers, "Subject") ?? "";
  const date = headerValue(headers, "Date");
  const receivedAt = date
    ? new Date(date).toISOString()
    : msg.internalDate
      ? new Date(Number(msg.internalDate)).toISOString()
      : new Date().toISOString();
  const messageIdHeader =
    headerValue(headers, "Message-ID") ?? `<${msg.id}@gmail.local>`;
  const inReplyTo = headerValue(headers, "In-Reply-To") ?? null;
  const referencesRaw = headerValue(headers, "References");
  const references = referencesRaw
    ? referencesRaw.split(/\s+/).filter((s) => s.length > 0)
    : [];

  const plainPart = findPart(msg.payload, "text/plain");
  const htmlPart = findPart(msg.payload, "text/html");
  const plainText = decodeBody(plainPart);
  const htmlText = decodeBody(htmlPart);
  const bodyText = plainText ?? (htmlText ? stripHtmlToText(htmlText) : "");

  return {
    external_id: msg.id,
    external_thread_id: msg.threadId,
    from_address: from.address,
    from_name: from.name,
    to_addresses: parseAddressList(headerValue(headers, "To")),
    cc_addresses: parseAddressList(headerValue(headers, "Cc")),
    subject,
    body_text: bodyText,
    body_html: htmlText,
    message_id_header: messageIdHeader,
    in_reply_to_header: inReplyTo,
    references_header: references,
    received_at: receivedAt,
  };
}

export function gmailMessageToInbound(
  msg: GmailMessage,
  channelId: string
): InboundMessage {
  const n = gmailMessageToNormalized(msg);
  return {
    channel_type: "email",
    external_message_id: n.external_id,
    external_thread_id: n.external_thread_id,
    sender_identifier: n.from_address,
    sender_display_name: n.from_name ?? n.from_address,
    sender_handle: null,
    chat_type: "private",
    content: n.body_text || n.subject || "(empty)",
    attachments: [],
    raw_payload: {
      gmail: msg as unknown as Record<string, unknown>,
      channel_id: channelId,
      normalized: n as unknown as Record<string, unknown>,
    },
    received_at: n.received_at,
  };
}
