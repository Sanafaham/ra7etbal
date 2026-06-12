export interface WhatsAppPayload {
  content: string;
  confirmationUrl?: string | null;
  phone?: string | null;
}

export interface WhatsAppCloudTaskPayload {
  to?: string | null;
  messageText: string;
  confirmationLink?: string | null;
  messageRecordId?: string | null;
  taskId?: string | null;
  recipientName?: string | null;
  /** Owner display name — becomes {{1}} in ra7etbal_task_v3 (and ra7etbal_task_image header replaces this). Falls back to "Rahet Bal" on the server if omitted. */
  ownerName?: string | null;
  /**
   * Supabase Storage path for a Reference image (e.g. "task-images/{userId}/{taskId}/photo.jpg").
   * When present the server generates a signed URL and appends it to the message text
   * so the recipient sees the reference image directly in WhatsApp before acting.
   */
  imagePath?: string | null;
}

export function buildDelegationMessage(payload: WhatsAppPayload): string {
  const content = payload.content.trim();
  const url = payload.confirmationUrl?.trim();
  if (!url) return content;
  return `${content}\n\nWhen done, tap here:\n${url}`;
}

export function buildWhatsAppUrl(payload: WhatsAppPayload): string | null {
  const text = buildDelegationMessage(payload);
  if (!text) return null;

  const encodedText = encodeURIComponent(text);
  const phone = normalizeWhatsAppPhone(payload.phone);
  if (phone) return `https://wa.me/${phone}?text=${encodedText}`;
  return `https://wa.me/?text=${encodedText}`;
}

export function openWhatsAppMessage(payload: WhatsAppPayload): boolean {
  const url = buildWhatsAppUrl(payload);
  if (!url) return false;

  const opened = window.open(url, "_blank", "noopener,noreferrer");
  if (!opened) {
    window.location.assign(url);
  }
  return true;
}

export async function sendWhatsAppTask(
  payload: WhatsAppCloudTaskPayload,
): Promise<{ success: true; messageId?: string | null; sendType?: string | null }> {
  const res = await fetch("/api/send-whatsapp-task", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      to: payload.to ?? null,
      messageText: payload.messageText,
      confirmationLink: payload.confirmationLink ?? null,
      messageRecordId: payload.messageRecordId ?? null,
      taskId: payload.taskId ?? null,
      recipientName: payload.recipientName ?? null,
      ownerName: payload.ownerName ?? null,
      imagePath: payload.imagePath ?? null,
    }),
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok || data?.success === false) {
    const detailText =
      typeof data?.errorMessage === "string" && data.errorMessage.trim()
        ? data.errorMessage.trim()
        : typeof data?.details === "string" && data.details.trim()
        ? data.details.trim()
        : typeof data?.error === "string"
          ? data.error
          : "Could not send WhatsApp message.";
    const statusText =
      typeof data?.status === "number" ? ` (status ${data.status})` : "";
    throw new Error(
      `${detailText}${statusText}`,
    );
  }

  return {
    success: true,
    messageId: typeof data?.messageId === "string" ? data.messageId : null,
    sendType: typeof data?.sendType === "string" ? data.sendType : null,
  };
}

function normalizeWhatsAppPhone(phone?: string | null): string | null {
  const raw = phone?.trim();
  if (!raw) return null;

  let digits = raw.replace(/[^\d]/g, "");
  if (digits.startsWith("00")) digits = digits.slice(2);
  return digits.length >= 7 ? digits : null;
}
