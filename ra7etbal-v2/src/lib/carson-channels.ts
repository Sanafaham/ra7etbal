/**
 * Carson channel destinations — WhatsApp and phone call.
 * Each channel is shown only when its destination AND its visibility switch
 * are both configured, so a broken/missing destination never renders a
 * dead-end button.
 */

/**
 * Validates and normalizes an E.164 phone number (e.g. "+971 50 123 4567")
 * down to bare digits (no leading "+"). Rejects anything that isn't a
 * plausible E.164 number: missing "+", stray characters, a leading zero
 * after the country code, or a digit count outside the valid 8–15 range.
 */
function normalizePhoneDigits(raw: string | undefined): string | null {
  const trimmed = raw?.trim();
  if (!trimmed) return null;
  if (!/^\+[\d\s().-]+$/.test(trimmed)) return null;
  const digits = trimmed.slice(1).replace(/[^\d]/g, "");
  if (digits.length < 8 || digits.length > 15) return null;
  if (digits.startsWith("0")) return null;
  return digits;
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
