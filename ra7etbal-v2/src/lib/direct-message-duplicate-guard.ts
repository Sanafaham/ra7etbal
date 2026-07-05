export const DIRECT_WHATSAPP_DUPLICATE_WINDOW_MS = 30_000;

export function normalizeDirectWhatsappDuplicateText(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

export function directWhatsappDuplicateKey(
  recipientName: string,
  messageText: string,
): string {
  return [
    recipientName.trim().toLowerCase(),
    normalizeDirectWhatsappDuplicateText(messageText),
  ].join("::");
}

export function isRecentDirectWhatsappDuplicate(
  sentAtByKey: Map<string, number>,
  recipientName: string,
  messageText: string,
  now = Date.now(),
  windowMs = DIRECT_WHATSAPP_DUPLICATE_WINDOW_MS,
): boolean {
  for (const [key, sentAt] of sentAtByKey.entries()) {
    if (now - sentAt >= windowMs) {
      sentAtByKey.delete(key);
    }
  }

  const key = directWhatsappDuplicateKey(recipientName, messageText);
  const lastSentAt = sentAtByKey.get(key);
  if (!lastSentAt) return false;
  return now - lastSentAt < windowMs;
}

export function recordDirectWhatsappSent(
  sentAtByKey: Map<string, number>,
  recipientName: string,
  messageText: string,
  now = Date.now(),
): void {
  sentAtByKey.set(directWhatsappDuplicateKey(recipientName, messageText), now);
}
