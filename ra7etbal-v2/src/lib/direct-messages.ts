import { deliverTaskMessage, type DeliveryResult } from "./delivery";
import type { Message } from "../types/message";
import type { MessageDraft } from "../types/message";

export type DirectMessageStage = "create_message" | "deliver_message";

export class DirectMessageBoundaryError extends Error {
  stage: DirectMessageStage;

  constructor(stage: DirectMessageStage, cause: unknown) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    super(detail || "Direct message failed.");
    this.name = "DirectMessageBoundaryError";
    this.stage = stage;
  }
}

export interface CreateDirectMessageInput {
  source: string;
  userId: string;
  recipient: string;
  messageText: string;
  createMessageFn?: CreateMessageFn;
}

export interface SendDirectMessageRecordInput {
  source: string;
  message: Message;
  messageText?: string | null;
  phone?: string | null;
  ownerName?: string | null;
  deliverTaskMessageFn?: typeof deliverTaskMessage;
}

type CreateMessageFn = (draft: MessageDraft) => Promise<Message>;

export interface CreateAndSendDirectMessageInput extends CreateDirectMessageInput {
  phone?: string | null;
  ownerName?: string | null;
  deliverTaskMessageFn?: typeof deliverTaskMessage;
}

export async function createDirectMessageRecord({
  source,
  userId,
  recipient,
  messageText,
  createMessageFn,
}: CreateDirectMessageInput): Promise<Message> {
  void source;
  const cleanRecipient = recipient.trim();
  const cleanMessage = messageText.trim();
  if (!userId) throw new Error("Not signed in.");
  if (!cleanRecipient) throw new Error("Direct message recipient is required.");
  if (!cleanMessage) throw new Error("Direct message text is required.");
  if (!createMessageFn) throw new Error("Direct message createMessageFn is required.");

  return createMessageFn({
    user_id: userId,
    task_id: null,
    recipient: cleanRecipient,
    content: cleanMessage,
    confirmation_url: null,
  });
}

export async function sendDirectMessageRecord({
  source,
  message,
  messageText,
  phone,
  ownerName = null,
  deliverTaskMessageFn = deliverTaskMessage,
}: SendDirectMessageRecordInput): Promise<DeliveryResult> {
  void source;
  return deliverTaskMessageFn({
    to: phone ?? null,
    messageText: messageText?.trim() || message.content,
    confirmationLink: null,
    messageRecordId: message.id,
    taskId: null,
    sendMode: "direct_message",
    recipientName: message.recipient,
    ownerName,
  });
}

export async function createAndSendDirectMessage({
  source,
  userId,
  recipient,
  messageText,
  phone,
  ownerName = null,
  createMessageFn,
  deliverTaskMessageFn = deliverTaskMessage,
}: CreateAndSendDirectMessageInput): Promise<{ message: Message; delivery: DeliveryResult }> {
  let message: Message;
  try {
    message = await createDirectMessageRecord({
      source,
      userId,
      recipient,
      messageText,
      createMessageFn,
    });
  } catch (err) {
    throw new DirectMessageBoundaryError("create_message", err);
  }

  const delivery = await sendDirectMessageRecord({
    source,
    message,
    phone,
    ownerName,
    deliverTaskMessageFn,
  });

  if (!delivery.success) {
    throw new DirectMessageBoundaryError("deliver_message", delivery.error ?? "Delivery failed");
  }

  return { message, delivery };
}
