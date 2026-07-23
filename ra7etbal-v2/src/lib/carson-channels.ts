/**
 * Carson channel destinations — WhatsApp and phone call.
 * Each channel is shown only when its destination AND its visibility switch
 * are both configured, so a broken/missing destination never renders a
 * dead-end button.
 */

function normalizePhoneDigits(raw: string | undefined): string | null {
  const trimmed = raw?.trim();
  if (!trimmed) return null;
  const digits = trimmed.replace(/[^\d]/g, "");
  return digits.length >= 7 ? digits : null;
}

export function getCarsonWhatsAppUrl(): string | null {
  const enabled = import.meta.env.VITE_ENABLE_CARSON_WHATSAPP === "true";
  if (!enabled) return null;
  const digits = normalizePhoneDigits(import.meta.env.VITE_CARSON_WHATSAPP_NUMBER);
  if (!digits) return null;
  return `https://wa.me/${digits}`;
}

export function getCarsonCallUrl(): string | null {
  const enabled = import.meta.env.VITE_ENABLE_CARSON_CALL === "true";
  if (!enabled) return null;
  const digits = normalizePhoneDigits(import.meta.env.VITE_CARSON_PHONE_NUMBER);
  if (!digits) return null;
  return `tel:+${digits}`;
}
