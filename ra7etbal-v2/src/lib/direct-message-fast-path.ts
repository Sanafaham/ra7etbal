import { createAndSendDirectMessage, DirectMessageBoundaryError } from "./direct-messages";
import { deliverTaskMessage } from "./delivery";
import { createMessage } from "./messages";
import { normalizeFirstPersonForOwner } from "./direct-message-owner-normalization";
import type { Person } from "../types/person";

export type DirectMessageFastPathResult =
  | { handled: false; reason: "no_match" }
  | {
      handled: true;
      status: "sent" | "blocked" | "failed";
      response: string;
      recipientName?: string;
      messageText?: string;
      reason?: "missing_person" | "missing_phone" | "missing_consent" | "delivery_failed";
    };

interface DirectMessageFastPathContext {
  userId: string;
  displayName?: string | null;
  people: Person[];
  /**
   * Typed-only: rewrite a leading first-person subject in the message body
   * to the owner's name before sending, so typed and voice produce the same
   * worker-facing text. Voice composes its own message text via the
   * ElevenLabs model and must not opt in — this defaults to off so any
   * caller that doesn't explicitly request it (including voice, if it ever
   * reaches this path) keeps the exact current, unnormalized behavior.
   */
  normalizeOwnerReference?: boolean;
}

interface DirectMessageFastPathDeps {
  createMessageFn?: typeof createMessage;
  deliverTaskMessageFn?: typeof deliverTaskMessage;
}

interface ParsedDirectMessage {
  recipientName: string;
  messageText: string;
}

const COMMAND_PREFIX =
  /^(?:\s*(?:please|can you|could you|would you|hey carson,?|carson,?)\s+)*(send|message|tell|text|whatsapp)\s+/i;

const BODY_MARKER = /\b(?:saying|say|that says|to say)\b\s*:?\s*/i;

const UNSAFE_OPERATIONAL_LANGUAGE =
  /\b(?:ask|assign|delegate|task|to[-\s]?do|remind|reminder|calendar|schedule|appointment|event|follow\s*up|followup|check\s+back|when\s+done|confirm|confirmation|complete|mark\s+done|due|deadline|by\s+\d{1,2}(?::\d{2})?\s*(?:am|pm)?|tomorrow|tonight|today|next\s+(?:week|month|monday|tuesday|wednesday|thursday|friday|saturday|sunday)|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i;

const DELEGATION_BODY_START =
  /^(?:to|please\s+)?(?:call|send|bring|take|pick\s+up|drop|check|clean|wash|buy|book|arrange|schedule|confirm|complete|finish|prepare|replace|fix|pay|file|order)\b/i;

export async function executeDirectMessageFastPath(
  input: string,
  context: DirectMessageFastPathContext,
  deps: DirectMessageFastPathDeps = {},
): Promise<DirectMessageFastPathResult> {
  const parsed = parseSimpleDirectMessage(input, context.people);
  if (!parsed) return { handled: false, reason: "no_match" };

  // Typed-only (see DirectMessageFastPathContext.normalizeOwnerReference):
  // rewrite a leading first-person subject to the owner's name so typed and
  // voice produce the same worker-facing message. The parser's own output
  // contract is unchanged — this happens after parsing, before the send.
  const messageText = context.normalizeOwnerReference
    ? normalizeFirstPersonForOwner(parsed.messageText, context.displayName)
    : parsed.messageText;

  console.info("[fast_path_direct_message_detected]", {
    recipientName: parsed.recipientName,
    messageLength: messageText.length,
  });

  const person = findPersonByName(parsed.recipientName, context.people);
  if (!person) {
    console.warn("[fast_path_direct_message_blocked]", {
      recipientName: parsed.recipientName,
      reason: "missing_person",
    });
    return {
      handled: true,
      status: "blocked",
      reason: "missing_person",
      recipientName: parsed.recipientName,
      messageText,
      response: `I don't have ${parsed.recipientName} in People yet.`,
    };
  }

  if (!person.phone?.trim()) {
    console.warn("[fast_path_direct_message_blocked]", {
      recipientName: person.name,
      reason: "missing_phone",
    });
    return {
      handled: true,
      status: "blocked",
      reason: "missing_phone",
      recipientName: person.name,
      messageText,
      response: `I don't have a phone number for ${person.name}.`,
    };
  }

  if (person.whatsapp_opted_in !== true) {
    console.warn("[fast_path_direct_message_blocked]", {
      recipientName: person.name,
      reason: "missing_consent",
    });
    return {
      handled: true,
      status: "blocked",
      reason: "missing_consent",
      recipientName: person.name,
      messageText,
      response: `WhatsApp consent is not recorded for ${person.name}.`,
    };
  }

  const createMessageFn = deps.createMessageFn ?? createMessage;
  const deliverTaskMessageFn = deps.deliverTaskMessageFn ?? deliverTaskMessage;

  try {
    const { message, delivery } = await createAndSendDirectMessage({
      source: "direct-message-fast-path",
      userId: context.userId,
      recipient: person.name,
      messageText,
      phone: person.phone,
      ownerName: context.displayName ?? null,
      createMessageFn,
      deliverTaskMessageFn,
    });

    console.info("[fast_path_direct_message_sent]", {
      recipientName: person.name,
      messageRecordId: message.id,
      deliveryId: delivery.deliveryId ?? null,
      messageId: delivery.messageId ?? null,
    });

    return {
      handled: true,
      status: "sent",
      recipientName: person.name,
      messageText,
      response: `It's with ${person.name}. I'll watch for the reply.`,
    };
  } catch (err) {
    console.error("[fast_path_direct_message_failed]", {
      recipientName: person.name,
      stage: err instanceof DirectMessageBoundaryError ? err.stage : "deliver_message",
      error: err instanceof Error ? err.message : String(err),
    });
    return {
      handled: true,
      status: "failed",
      reason: "delivery_failed",
      recipientName: person.name,
      messageText,
      response: `I couldn't send ${person.name} the message. Please try again.`,
    };
  }
}

export function parseSimpleDirectMessage(
  input: string,
  people: Person[],
): ParsedDirectMessage | null {
  const normalized = normalizeSpeechText(input);
  const prefixMatch = normalized.match(COMMAND_PREFIX);
  if (!prefixMatch) return null;

  const verb = prefixMatch[1];
  const afterCommand = normalized.slice(prefixMatch[0].length).trim();
  if (!afterCommand || UNSAFE_OPERATIONAL_LANGUAGE.test(afterCommand)) return null;

  // Fast path: person name directly after verb ("send Sana ...", "tell Sana ...")
  const personAtStart = findPersonAtStart(afterCommand, people);
  if (personAtStart) {
    const body = extractMessageBody(afterCommand.slice(personAtStart.name.length).trim(), verb);
    if (!body || isUnsafeBody(body)) return null;
    return { recipientName: personAtStart.name, messageText: body };
  }

  // "send a WhatsApp message to Sana saying X" — person comes after "to"
  const toResult = findPersonAfterToWithIndex(afterCommand, people);
  if (toResult) {
    const body = extractMessageBody(afterCommand.slice(toResult.afterNameIndex).trim(), verb);
    if (body && !isUnsafeBody(body)) {
      return { recipientName: toResult.person.name, messageText: body };
    }
  }

  // Unknown recipient path — fires for both "Sana X" (at start) and
  // "send a WhatsApp message to Sana saying X" (after "to") when the name
  // is not found in People, so the fast path can return the "not in People" error.
  const unknownResult = extractUnknownRecipientName(afterCommand);
  if (!unknownResult) return null;
  const bodyText = afterCommand.slice(unknownResult.endIndex).trim();
  const body = extractMessageBody(bodyText, verb);
  if (!body || isUnsafeBody(body)) return null;
  return { recipientName: unknownResult.name, messageText: body };
}

function extractMessageBody(restAfterRecipient: string, verb: string): string | null {
  let rest = restAfterRecipient
    .replace(/^(?:a\s+)?(?:whatsapp\s+)?(?:test\s+)?message(?:\s+now)?(?:\s*[\.\-—:]\s*)?/i, "")
    .trim();

  const marker = rest.match(BODY_MARKER);
  if (marker) {
    rest = rest.slice((marker.index ?? 0) + marker[0].length).trim();
  } else if (/^(send|message|text|whatsapp)$/i.test(verb)) {
    rest = rest.replace(/^(?:saying|say)\s*:?\s*/i, "").trim();
  } else {
    rest = rest.replace(/^(?:that\s+)?/i, "").trim();
  }

  rest = stripWrappingQuotes(rest)
    .replace(/\s+/g, " ")
    .trim();

  if (!rest || rest.length > 500) return null;
  return rest;
}

function isUnsafeBody(body: string): boolean {
  return UNSAFE_OPERATIONAL_LANGUAGE.test(body) || DELEGATION_BODY_START.test(body);
}

function findPersonAtStart(text: string, people: Person[]): Person | null {
  const sorted = [...people].sort((a, b) => b.name.length - a.name.length);
  return sorted.find((person) => {
    const name = person.name.trim();
    if (!name) return false;
    const pattern = new RegExp(`^${escapeRegExp(name)}(?:\\b|\\s|,|:|\\.)`, "i");
    return pattern.test(text);
  }) ?? null;
}

function findPersonByName(name: string, people: Person[]): Person | null {
  const key = name.trim().toLowerCase();
  return people.find((person) => person.name.trim().toLowerCase() === key) ?? null;
}

function findPersonAfterToWithIndex(
  text: string,
  people: Person[],
): { person: Person; afterNameIndex: number } | null {
  const sorted = [...people].sort((a, b) => b.name.length - a.name.length);
  for (const person of sorted) {
    const name = person.name.trim();
    if (!name) continue;
    const pattern = new RegExp(`\\bto\\s+${escapeRegExp(name)}(?=\\b|\\s|,|:|\\.|$)`, "i");
    const match = text.match(pattern);
    if (match && match.index !== undefined) {
      return { person, afterNameIndex: match.index + match[0].length };
    }
  }
  return null;
}

function extractUnknownRecipientName(
  text: string,
): { name: string; endIndex: number } | null {
  // "to NAME" pattern — "send a WhatsApp message to John saying X"
  // where John is not (yet) in People.
  const toNameMatch = text.match(/\bto\s+([A-Za-z][a-zA-Z]*)(?:\b|$)/i);
  if (toNameMatch && toNameMatch.index !== undefined) {
    const candidate = toNameMatch[1].replace(/[,:.]+$/, "").trim();
    // Skip body-marker words that look like "to say" / "to saying"
    if (candidate && !/^(?:say|saying|that|the|a|an)$/i.test(candidate)) {
      return {
        name: titleCase(candidate),
        endIndex: toNameMatch.index + toNameMatch[0].length,
      };
    }
  }

  // Original logic: name before body marker, or just the first word
  const marker = text.match(BODY_MARKER);
  const beforeMarker = marker
    ? text.slice(0, marker.index).trim()
    : text.trim().split(/\s+/).slice(0, 1).join(" ");
  const cleaned = beforeMarker
    .replace(/^(?:a\s+)?(?:whatsapp\s+)?(?:test\s+)?message\b.*$/i, "")
    .replace(/[,:.]+$/g, "")
    .trim();
  if (!cleaned || cleaned.split(/\s+/).length > 2) return null;
  return { name: titleCase(cleaned), endIndex: cleaned.length };
}

function normalizeSpeechText(input: string): string {
  return input
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function stripWrappingQuotes(text: string): string {
  return text.replace(/^["']+/, "").replace(/["']+$/, "").trim();
}

function titleCase(text: string): string {
  return text
    .split(/\s+/)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
