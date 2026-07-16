import type { CarsonTypedMessage } from "./carson-typed-messages";

export function normalizeTypedCarsonMessage(content: string): string {
  return content.trim().replace(/\s+/g, " ").slice(0, 12_000);
}

export function isRestorableTypedCarsonMessage(message: CarsonTypedMessage): boolean {
  return !(message.role === "agent" && message.reply_to_client_message_id === null);
}

export function filterRestorableTypedCarsonMessages(
  messages: CarsonTypedMessage[],
): CarsonTypedMessage[] {
  return messages.filter(isRestorableTypedCarsonMessage);
}

export function buildTypedHistoryContext(
  messages: CarsonTypedMessage[],
  maxMessages = 20,
): string {
  // Never feed an instruction back to Carson if it was explicitly recorded
  // as failed/interrupted. History is context only and must not become a
  // replay path after refresh.
  const recent = messages
    .filter(
      (message) =>
        message.role === "agent" ||
        (message.delivery_status !== "failed" && message.delivery_status !== "interrupted"),
    )
    .slice(-Math.max(1, maxMessages));
  if (recent.length === 0) return "";

  return recent
    .map((message) => `${message.role === "user" ? "Owner" : "Carson"}: ${message.content}`)
    .join("\n");
}
