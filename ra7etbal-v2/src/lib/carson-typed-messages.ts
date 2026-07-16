import { supabase } from "./supabase";
import {
  filterRestorableTypedCarsonMessages,
  normalizeTypedCarsonMessage,
} from "./carson-typed-message-utils";

export type CarsonTypedRole = "user" | "agent";
export type CarsonTypedDeliveryStatus =
  | "pending"
  | "sent"
  | "responded"
  | "interrupted"
  | "failed";

export interface CarsonTypedMessage {
  id: string;
  session_id: string;
  client_message_id: string | null;
  reply_to_client_message_id: string | null;
  role: CarsonTypedRole;
  content: string;
  delivery_status: CarsonTypedDeliveryStatus;
  elevenlabs_conversation_id: string | null;
  elevenlabs_event_id: number | null;
  created_at: string;
  updated_at: string;
}

const MESSAGE_COLUMNS =
  "id, session_id, client_message_id, reply_to_client_message_id, role, content, delivery_status, elevenlabs_conversation_id, elevenlabs_event_id, created_at, updated_at";

export async function loadRecentTypedCarsonMessages(
  limit = 100,
): Promise<CarsonTypedMessage[]> {
  const safeLimit = Math.max(1, Math.min(limit, 200));
  const { data, error } = await supabase
    .from("carson_typed_messages")
    .select(MESSAGE_COLUMNS)
    .order("created_at", { ascending: false })
    .limit(safeLimit);

  if (error) throw new Error(error.message);
  return filterRestorableTypedCarsonMessages(((data ?? []) as CarsonTypedMessage[]).reverse());
}

/**
 * Permanently removes the authenticated owner's saved typed transcript.
 * The explicit user filter is defense in depth on top of the table's RLS
 * delete policy; tasks, memories, and voice-session records are untouched.
 */
export async function clearTypedCarsonMessages(): Promise<void> {
  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser();

  if (authError) throw new Error(authError.message);
  if (!user) throw new Error("Sign in again before clearing this conversation.");

  const { error } = await supabase
    .from("carson_typed_messages")
    .delete()
    .eq("user_id", user.id);

  if (error) throw new Error(error.message);
}

export async function createTypedUserMessage(input: {
  sessionId: string;
  clientMessageId: string;
  content: string;
}): Promise<CarsonTypedMessage> {
  const content = normalizeTypedCarsonMessage(input.content);
  if (!content) throw new Error("Type a message for Carson first.");

  const { data, error } = await supabase
    .from("carson_typed_messages")
    .insert({
      session_id: input.sessionId,
      client_message_id: input.clientMessageId,
      role: "user",
      content,
      delivery_status: "pending",
    })
    .select(MESSAGE_COLUMNS)
    .single();

  if (error) {
    if (error.code === "23505") {
      throw new Error("That message was already submitted.");
    }
    throw new Error(error.message);
  }
  return data as CarsonTypedMessage;
}

export async function updateTypedUserMessage(input: {
  clientMessageId: string;
  deliveryStatus: CarsonTypedDeliveryStatus;
  elevenlabsConversationId?: string | null;
}): Promise<void> {
  const update: Record<string, unknown> = {
    delivery_status: input.deliveryStatus,
  };
  if (input.elevenlabsConversationId !== undefined) {
    update.elevenlabs_conversation_id = input.elevenlabsConversationId;
  }

  let query = supabase
    .from("carson_typed_messages")
    .update(update)
    .eq("client_message_id", input.clientMessageId)
    .eq("role", "user");

  // A late "sent" bookkeeping response must never move a row backward from
  // responded to sent if Carson replied unusually quickly.
  query = input.deliveryStatus === "sent"
    ? query.eq("delivery_status", "pending")
    : query.in("delivery_status", ["pending", "sent"]);

  const { error } = await query;

  if (error) throw new Error(error.message);
}

export async function createTypedAgentMessage(input: {
  sessionId: string;
  replyToClientMessageId: string | null;
  content: string;
  elevenlabsConversationId?: string | null;
  elevenlabsEventId?: number | null;
}): Promise<CarsonTypedMessage> {
  const content = normalizeTypedCarsonMessage(input.content);
  if (!content) throw new Error("Carson returned an empty response.");

  const { data, error } = await supabase
    .from("carson_typed_messages")
    .insert({
      session_id: input.sessionId,
      reply_to_client_message_id: input.replyToClientMessageId,
      role: "agent",
      content,
      delivery_status: "responded",
      elevenlabs_conversation_id: input.elevenlabsConversationId ?? null,
      elevenlabs_event_id: input.elevenlabsEventId ?? null,
    })
    .select(MESSAGE_COLUMNS)
    .single();

  if (error) throw new Error(error.message);
  return data as CarsonTypedMessage;
}

/**
 * A refresh must never replay an instruction automatically. Any user turn
 * left pending/sent without a recorded Carson reply becomes interrupted and
 * remains visible so the owner can decide whether to submit it again.
 */
export async function markUnansweredTypedMessagesInterrupted(sessionId: string): Promise<void> {
  const { error } = await supabase
    .from("carson_typed_messages")
    .update({ delivery_status: "interrupted" })
    .eq("role", "user")
    .eq("session_id", sessionId)
    .in("delivery_status", ["pending", "sent"]);

  if (error) throw new Error(error.message);
}
