/**
 * Delivery abstraction layer.
 *
 * Calls the server-side send-whatsapp-task API, which internally attempts
 * WhatsApp first and falls back to Twilio SMS if WhatsApp fails.
 * The server returns `channel: 'whatsapp' | 'sms'` indicating which succeeded.
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

export async function deliverTaskMessage(
  payload: WhatsAppCloudTaskPayload,
): Promise<DeliveryResult> {
  try {
    const result = await sendWhatsAppTask(payload);
    return {
      success: true,
      channel: result.channel ?? "whatsapp",
      messageId: result.messageId,
    };
  } catch (err) {
    const error = err instanceof Error ? err.message : "Delivery failed";
    return { success: false, channel: "failed", error };
  }
}
