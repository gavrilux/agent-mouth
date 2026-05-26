// packages/transport-email/src/webhook/pubsub-payload.ts
import { z } from "zod";

const PubSubEnvelopeSchema = z.object({
  message: z.object({
    data: z.string().min(1),
    messageId: z.string().optional(),
    publishTime: z.string().optional(),
  }),
  subscription: z.string().optional(),
});

const GmailNotificationSchema = z.object({
  emailAddress: z.string().email(),
  historyId: z.union([z.string(), z.number()]).transform((v) => String(v)),
});

export interface ParsedPubSubPayload {
  email_address: string;
  history_id: string;
  pubsub_message_id: string | null;
  publish_time: string | null;
  subscription: string | null;
}

export function parsePubSubEnvelope(envelope: unknown): ParsedPubSubPayload {
  const env = PubSubEnvelopeSchema.parse(envelope);
  let decoded: string;
  try {
    decoded = Buffer.from(env.message.data, "base64").toString("utf8");
    // Reject if it doesn't look like JSON
    if (!decoded.trim().startsWith("{")) {
      throw new Error("decoded data is not JSON");
    }
  } catch (err) {
    throw new Error(`invalid base64 data: ${(err as Error).message}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(decoded);
  } catch {
    throw new Error("data is not valid JSON");
  }
  const notif = GmailNotificationSchema.parse(parsed);
  return {
    email_address: notif.emailAddress.toLowerCase(),
    history_id: notif.historyId,
    pubsub_message_id: env.message.messageId ?? null,
    publish_time: env.message.publishTime ?? null,
    subscription: env.subscription ?? null,
  };
}
