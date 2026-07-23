import { deliverTaskMessage, type DeliveryResult } from "./delivery";
import { normalizeFirstPersonForOwner } from "./direct-message-owner-normalization";
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
  /**
   * The message's actual author. When present, messageText's owner-relative
   * wording ("me", "I", "my") is normalized to this name before the record
   * is created — see direct-message-owner-normalization.ts.
   */
  ownerName?: string | null;
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
  deliverTaskMessageFn?: typeof deliverTaskMessage;
}

export async function createDirectMessageRecord({
  source,
  userId,
  recipient,
  messageText,
  ownerName,
  createMessageFn,
}: CreateDirectMessageInput): Promise<Message> {
  void source;
  const cleanRecipient = recipient.trim();
  // Owner-reference normalization ("me"/"I"/"my" -> the owner's name)
  // happens here, at the one boundary every direct-message path (Talk's
  // send_direct_whatsapp_message tool and sendDelegation's communication
  // reroute; Type's executeDirectMessageFastPath and the same sendDelegation
  // reroute) converges on before a message row is ever created — see
  // direct-message-owner-normalization.ts.
  const cleanMessage = normalizeFirstPersonForOwner(messageText, ownerName).trim();
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
      ownerName,
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
