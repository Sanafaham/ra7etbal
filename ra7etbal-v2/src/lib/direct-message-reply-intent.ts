function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function stripMatchingQuotes(value: string): string {
  const trimmed = value.trim();
  const pairs: Array<[string, string]> = [
    ['"', '"'],
    ["'", "'"],
    ["“", "”"],
    ["‘", "’"],
  ];
  for (const [open, close] of pairs) {
    if (trimmed.startsWith(open) && trimmed.endsWith(close) && trimmed.length > 1) {
      return trimmed.slice(open.length, -close.length).trim();
    }
  }
  return trimmed;
}

/**
 * Restores reply-request meaning when the voice model supplies only the
 * quoted reply text to send_direct_whatsapp_message.
 *
 * Example:
 *   transcript: Ask Christopher to reply, "I'll be there in five minutes."
 *   tool text:  I'll be there in five minutes.
 *   result:     Please reply: "I'll be there in five minutes."
 *
 * The match is deliberately narrow: it only applies to an explicit
 * owner-authored "ask <this recipient> to reply" command. Ordinary direct
 * messages and other communication/delegation forms are returned unchanged.
 */
export function preserveDirectMessageReplyIntent(
  transcript: string | null | undefined,
  recipientName: string,
  toolMessage: string,
): string {
  const source = transcript?.trim();
  const recipient = recipientName.trim();
  const message = toolMessage.trim();
  if (!source || !recipient || !message) return message;

  const pattern = new RegExp(
    `^\\s*(?:please\\s+)?ask\\s+${escapeRegExp(recipient)}\\s+to\\s+reply\\b\\s*(?:with\\s+|that\\s+|[:,]\\s*)?(.*)\\s*$`,
    "i",
  );
  const match = source.match(pattern);
  if (!match) return message;

  // If the tool already preserved the request, do not wrap it again.
  if (/^\s*(?:please\s+)?reply\b/i.test(message)) return message;

  const requestedReply = stripMatchingQuotes(match[1] || message);
  if (!requestedReply) return message;
  return `Please reply: "${requestedReply}"`;
}
