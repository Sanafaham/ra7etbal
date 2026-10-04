import { buildFollowUpMessageText } from "../../shared/follow-up-message.js";
import { ownerPerspectiveDetail, resolveOwnerPerspective } from "./direct-message-owner-normalization";

/**
 * App-side callers of the single owner-perspective boundary
 * (shared/owner-perspective.js) for two Talk/Tasks sends that previously
 * reached the recipient unchecked. These functions only choose the boundary
 * voice and the owner-facing refusal; they never rewrite pronouns themselves.
 */

export type RecipientTextResult = { ok: true; text: string } | { ok: false; response: string };

/**
 * Talk's send_followup. A follow-up text the voice model supplied is the
 * owner's words to the recipient ("owner_to_recipient"): rendered, or refused
 * — never trusted because the model wrote it. With no model text, the stored
 * task record is quoted through the same builder the escalation cron uses,
 * which falls back to the neutral line instead of reinterpreting it.
 */
export function resolveFollowUpRecipientText({
  modelMessage,
  storedDescription,
  ownerName,
  recipientName,
}: {
  modelMessage?: string | null;
  storedDescription?: string | null;
  ownerName?: string | null;
  recipientName: string;
}): RecipientTextResult {
  const owner = ownerName?.trim() || "the sender";
  const text = modelMessage?.trim() ?? "";
  if (!text) {
    return { ok: true, text: buildFollowUpMessageText({ description: storedDescription ?? "", ownerName: owner, assignedTo: recipientName }) };
  }
  const resolved = resolveOwnerPerspective(text, { ownerName: owner, recipientName, voice: "owner_to_recipient" });
  if (resolved.status === "needs_composition") {
    return { ok: false, response: `I didn't send the follow-up to ${recipientName}. ${ownerPerspectiveDetail()}` };
  }
  return { ok: true, text: resolved.text };
}

/**
 * TaskCard re-send of a stored `messages.content` row. The row is text
 * addressed to its recipient, but rows written before the boundary existed
 * may carry raw "I/me/my", the recipient named as a third party, or
 * unverifiable Arabic/Turkish. Resolved at send time ("owner_to_recipient");
 * the stored row is never rewritten. Refused → nothing is sent through
 * Ra7etBal, and the owner is told why.
 */
export function resolveStoredMessageForResend({
  content,
  ownerName,
  recipientName,
}: {
  content: string;
  ownerName?: string | null;
  recipientName?: string | null;
}): RecipientTextResult {
  const who = recipientName?.trim() || "them";
  const resolved = resolveOwnerPerspective(content, {
    ownerName: ownerName?.trim() || "the sender",
    recipientName: recipientName ?? null,
    voice: "owner_to_recipient",
  });
  if (resolved.status === "needs_composition") {
    // Arabic/Turkish rows cannot be re-checked on this no-model path: say so
    // truthfully instead of claiming an "I"/"me"/"her" problem.
    if (resolved.reason === "unverifiable_language" || resolved.reason?.startsWith("arabic_") || resolved.reason?.startsWith("turkish_")) {
      return {
        ok: false,
        response: `Not sent: I can't re-check an Arabic or Turkish saved message to ${who} before sending it again. `
          + "Message them yourself, or ask Carson to send it again.",
      };
    }
    return {
      ok: false,
      response: `Not sent: I couldn't safely tell who "I", "me" or "her" refers to in this saved message to ${who}. `
        + "Message them yourself, or ask Carson to send it again using names.",
    };
  }
  return { ok: true, text: resolved.text };
}
