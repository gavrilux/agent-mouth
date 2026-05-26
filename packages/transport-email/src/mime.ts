import type { SendEmailArgs } from "./types.js";

const CRLF = "\r\n";
const NON_ASCII = /[^\x00-\x7F]/;

function encodeHeaderIfNeeded(value: string): string {
  if (!NON_ASCII.test(value)) return value;
  const b64 = Buffer.from(value, "utf8").toString("base64");
  return `=?UTF-8?B?${b64}?=`;
}

export function buildMime(args: SendEmailArgs): string {
  const lines: string[] = [];
  lines.push(`From: ${args.from_address}`);
  lines.push(`To: ${args.to_addresses.join(", ")}`);
  if (args.cc_addresses?.length) {
    lines.push(`Cc: ${args.cc_addresses.join(", ")}`);
  }
  lines.push(`Subject: ${encodeHeaderIfNeeded(args.subject)}`);
  lines.push("MIME-Version: 1.0");
  lines.push('Content-Type: text/plain; charset="UTF-8"');
  lines.push("Content-Transfer-Encoding: 8bit");
  if (args.in_reply_to) {
    lines.push(`In-Reply-To: ${args.in_reply_to}`);
  }
  if (args.references?.length) {
    lines.push(`References: ${args.references.join(" ")}`);
  }
  // Date header (Gmail will set its own but RFC requires it)
  lines.push(`Date: ${new Date().toUTCString()}`);

  // Blank line separates headers from body
  lines.push("");
  lines.push(args.body_text);

  return lines.join(CRLF);
}

/** Gmail messages.send expects raw = base64url(mime). */
export function mimeToBase64Url(mime: string): string {
  return Buffer.from(mime, "utf8").toString("base64url");
}
