import { deliverTaskMessage, type DeliveryResult } from "./delivery";
import { preserveDirectMessageReplyIntent } from "./direct-message-reply-intent";
import { isOwnerPerspectiveError, ownerPerspectiveClarification, resolveOwnerPerspective, OwnerPerspectiveError, type DeclaredOwnerPerspective } from "./direct-message-owner-normalization";
import type { Message } from "../types/message";
import type { MessageDraft } from "../types/message";

export type DirectMessageStage = "create_message" | "deliver_message";

export class DirectMessageBoundaryError extends Error {
  stage: DirectMessageStage;
  /** The original error, kept so callers can recognise its kind. */
  override cause: unknown;

  constructor(stage: DirectMessageStage, cause: unknown) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    super(detail || "Direct message failed.");
    this.name = "DirectMessageBoundaryError";
    this.stage = stage;
    this.cause = cause;
  }
}

/**
 * The owner-facing reply when a direct message was not sent. When the
 * owner-perspective boundary refused to word the message (it could not tell
 * safely who "I", "me" or "her" would mean to the recipient), the owner is
 * asked to rephrase instead of being told to "try again" with the same words.
 */
export function directMessageFailureResponse(err: unknown, recipientName: string): string {
  const cause = err instanceof DirectMessageBoundaryError ? err.cause : err;
  if (isOwnerPerspectiveError(cause)) return ownerPerspectiveClarification(recipientName);
  return `I couldn't send ${recipientName} the message. Please try again.`;
}

export interface CreateDirectMessageInput {
  source: string;
  userId: string;
  recipient: string;
  /**
   * The recipient's real people.id, when the caller already resolved one
   * before calling (e.g. an exact-name match against the people table).
   * Never invented from `recipient` text — left null/undefined when the
   * caller only has free text.
   */
  recipientPersonId?: string | null;
  messageText: string;
  /**
   * The message's actual author. When present, messageText's owner-relative
   * wording ("me", "I", "my") is normalized to this name before the record
   * is created — see direct-message-owner-normalization.ts.
   */
  ownerName?: string | null;
  /**
   * The owner's verbatim instruction, when available. This lets the shared
   * delivery boundary preserve reply-request semantics even if the model
   * supplied only the quoted reply text as messageText.
   */
  ownerInstruction?: string | null;
  /**
   * Set only when messageText was composed by the extraction model call with
   * a declared perspective status; it is then verified in the boundary's
   * "composed" voice (never rewritten). Absent = the owner's own words.
   */
  declaredPerspective?: DeclaredOwnerPerspective;
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
  recipientPersonId,
  messageText,
  ownerName,
  ownerInstruction,
  declaredPerspective,
  createMessageFn,
}: CreateDirectMessageInput): Promise<Message> {
  void source;
  const cleanRecipient = recipient.trim();
  // Owner perspective is resolved here, at the one boundary every
  // direct-message path (Talk's send_direct_whatsapp_message tool and
  // sendDelegation's communication reroute; Type's
  // executeDirectMessageFastPath and the same reroute; Clear My Head's save)
  // converges on before a message row is ever created — through the single
  // authoritative owner-perspective contract (shared/owner-perspective.js).
  // The text is the owner's words to the recipient: first person is the
  // owner, second person is the recipient.
  // Ordering invariant: reconstruct explicit reply requests AFTER owner
  // perspective. The verbatim owner instruction is authoritative, so this
  // repairs either a raw first-person tool payload or one the model has
  // already rewritten, while ordinary direct messages keep the resolved text.
  const perspective = resolveOwnerPerspective(messageText, declaredPerspective === undefined
    ? { ownerName, recipientName: cleanRecipient, voice: "owner_to_recipient" }
    : { ownerName, recipientName: cleanRecipient, voice: "composed", declared: declaredPerspective });
  let cleanMessage: string;
  if (perspective.status === "needs_composition") {
    // Fail closed: nothing is created or sent — unless the owner's own
    // "ask <recipient> to reply …" instruction replaces this text entirely.
    const replyRequest = preserveDirectMessageReplyIntent(ownerInstruction, cleanRecipient, messageText.trim()).trim();
    if (replyRequest === messageText.trim() || !replyRequest.startsWith("Please reply:")) {
      throw new OwnerPerspectiveError(perspective.reason, cleanRecipient);
    }
    cleanMessage = replyRequest;
  } else {
    cleanMessage = preserveDirectMessageReplyIntent(ownerInstruction, cleanRecipient, perspective.text.trim()).trim();
  }
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
    person_id: recipientPersonId ?? null,
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
  recipientPersonId,
  messageText,
  phone,
  ownerName = null,
  ownerInstruction = null,
  createMessageFn,
  deliverTaskMessageFn = deliverTaskMessage,
}: CreateAndSendDirectMessageInput): Promise<{ message: Message; delivery: DeliveryResult }> {
  let message: Message;
  try {
    message = await createDirectMessageRecord({
      source,
      userId,
      recipient,
      recipientPersonId,
      messageText,
      ownerName,
      ownerInstruction,
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
