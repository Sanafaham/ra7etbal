/**
 * Delivery abstraction layer — Option B.
 *
 * Tries WhatsApp first. If WhatsApp fails and SMS_FALLBACK_ENABLED is true,
 * falls back to SMS via /api/send-sms-task. Returns which channel succeeded.
 *
 * Callers (text-carson, ops-intelligence) use deliverTaskMessage instead of
 * sendWhatsAppTask directly. The consent gate lives upstream of this layer —
 * only pre-approved recipients reach deliverTaskMessage.
 */

import { sendWhatsAppTask } from "./whatsapp";
import type { WhatsAppCloudTaskPayload } from "./whatsapp";

export type DeliveryChannel = "whatsapp" | "sms" | "failed";

export interface DeliveryResult {
  success: boolean;
  channel: DeliveryChannel;
  messageId?: string | null;
  error?: string;
}

export interface SmsPayload {
  to: string;
  body: string;
  recipientName?: string | null;
}

async function sendSmsTask(payload: SmsPayload): Promise<{ success: true }> {
  const res = await fetch("/api/send-sms-task", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      to: payload.to,
      body: payload.body,
      recipientName: payload.recipientName ?? null,
    }),
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok || data?.success === false) {
    const detail =
      typeof data?.error === "string" ? data.error : "SMS send failed";
    throw new Error(detail);
  }
  return { success: true };
}

function buildSmsBody(payload: WhatsAppCloudTaskPayload): string {
  const parts: string[] = [];
  if (payload.ownerName) parts.push(`From ${payload.ownerName}:`);
  parts.push(payload.messageText.trim());
  if (payload.confirmationLink) {
    parts.push(`\nWhen done, tap here:\n${payload.confirmationLink}`);
  }
  return parts.join("\n");
}

export async function deliverTaskMessage(
  payload: WhatsAppCloudTaskPayload,
): Promise<DeliveryResult> {
  // Always try WhatsApp first.
  try {
    const result = await sendWhatsAppTask(payload);
    return { success: true, channel: "whatsapp", messageId: result.messageId };
  } catch (whatsappErr) {
    const whatsappError =
      whatsappErr instanceof Error ? whatsappErr.message : "WhatsApp send failed";

    // SMS fallback — only if env flag is set AND we have a phone number.
    const smsFallbackEnabled =
      (import.meta.env.VITE_SMS_FALLBACK_ENABLED ?? "false") === "true";

    if (smsFallbackEnabled && payload.to) {
      try {
        await sendSmsTask({
          to: payload.to,
          body: buildSmsBody(payload),
          recipientName: payload.recipientName,
        });
        return { success: true, channel: "sms" };
      } catch (smsErr) {
        const smsError =
          smsErr instanceof Error ? smsErr.message : "SMS send failed";
        return {
          success: false,
          channel: "failed",
          error: `WhatsApp: ${whatsappError} | SMS: ${smsError}`,
        };
      }
    }

    return { success: false, channel: "failed", error: whatsappError };
  }
}
