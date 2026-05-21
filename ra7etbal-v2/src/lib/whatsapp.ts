export interface WhatsAppPayload {
  content: string;
  confirmationUrl?: string | null;
  phone?: string | null;
}

export function buildDelegationMessage(payload: WhatsAppPayload): string {
  const content = payload.content.trim();
  const url = payload.confirmationUrl?.trim();
  if (!url) return content;
  return `${content}\n\nTap Done when finished:\n${url}`;
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

function normalizeWhatsAppPhone(phone?: string | null): string | null {
  const raw = phone?.trim();
  if (!raw) return null;

  let digits = raw.replace(/[^\d]/g, "");
  if (digits.startsWith("00")) digits = digits.slice(2);
  return digits.length >= 7 ? digits : null;
}
