/**
 * carson-people-action.ts
 *
 * Semantic entry point for person-directed requests (communication and
 * delegation), replacing regex-based intent re-derivation for this
 * capability class.
 *
 * Architectural background (2026-07-30 Carson intent-architecture review):
 * confirmed production incidents this session (PR #110, PR #122) traced to
 * a client-side deterministic gate that RE-DERIVED intent from raw
 * utterance text via regex, independently of whatever tool the ElevenLabs
 * model had already selected, and rejected the model's (correct) tool
 * choice whenever the regex disagreed. The fix is not "better regex" — it
 * is removing raw-text re-derivation from this decision entirely.
 *
 * The ElevenLabs model no longer selects between send_direct_whatsapp_message
 * and send_delegation directly for new requests. It calls a single semantic
 * tool, route_people_action, describing the intended outcome as structured
 * fields. This module is the deterministic layer that reads those fields —
 * never the raw utterance — and decides which existing, unchanged handler
 * to invoke.
 *
 * Critical design point: the routing decision is NOT taken from the
 * model's top-level `actionType` alone (that would just be the model
 * agreeing with itself, the exact self-consistency defect this replaces).
 * It is derived from three independent boolean fields — trackedCompletionExpected,
 * followUpOrEscalationExpected, actualWorkRequired — which the model must
 * set from the complete meaning of the request, not from spotting specific
 * words. A mismatch between `actionType` and what those booleans imply is
 * treated as genuine ambiguity, not resolved by any vocabulary check
 * (earlier drafts of this module used a "reply/confirm/respond" word-based
 * default — deliberately removed; the same word can appear in requests
 * that must route differently, e.g. "confirm whether she can come" is
 * communication, "confirm completion and keep following up" is delegation
 * — the distinction must come from the structured fields, never the word).
 *
 * This module does not resolve the recipient against the People roster or
 * check WhatsApp opt-in — send_direct_whatsapp_message / send_delegation
 * already do that, unchanged, and remain the source of truth for entity
 * safety. This module's only job is deciding WHICH of those two to call.
 */

export type CarsonPeopleActionType = "interpersonal_communication" | "tracked_delegation";

export interface CarsonPeopleActionEnvelope {
  intendedOutcome: string;
  actionType: CarsonPeopleActionType;
  recipient: string;
  content: string;
  replyExpected: boolean;
  trackedCompletionExpected: boolean;
  followUpOrEscalationExpected: boolean;
  actualWorkRequired: boolean;
  timing?: string;
  constraints?: string;
  ambiguityReason?: string;
}

export type CarsonPeopleActionDecision =
  | {
      status: "authorized";
      tool: "send_direct_whatsapp_message";
      params: { recipient_name: string; message: string };
    }
  | {
      status: "authorized";
      tool: "send_delegation";
      params: { name: string; task: string; message?: string };
    }
  | { status: "clarify"; question: string; reason: string };

function derivedTypeFromEvidence(envelope: CarsonPeopleActionEnvelope): CarsonPeopleActionType {
  const impliesTrackedWork =
    envelope.trackedCompletionExpected || envelope.followUpOrEscalationExpected || envelope.actualWorkRequired;
  return impliesTrackedWork ? "tracked_delegation" : "interpersonal_communication";
}

export function resolveCarsonPeopleAction(
  envelope: CarsonPeopleActionEnvelope,
): CarsonPeopleActionDecision {
  const recipient = envelope.recipient?.trim() ?? "";
  const content = envelope.content?.trim() ?? "";

  if (!recipient) {
    return {
      status: "clarify",
      question: "Who should this go to?",
      reason: "missing_recipient",
    };
  }

  if (!content) {
    return {
      status: "clarify",
      question:
        envelope.actionType === "tracked_delegation"
          ? `What should ${recipient} do?`
          : `What would you like me to tell ${recipient}?`,
      reason: "missing_content",
    };
  }

  // The model's own admission of uncertainty is authoritative — never
  // silently overridden by a derived guess.
  if (envelope.ambiguityReason?.trim()) {
    return {
      status: "clarify",
      question: `Do you want me to message ${recipient}, or assign this to them as a tracked task?`,
      reason: envelope.ambiguityReason.trim(),
    };
  }

  // The three evidence booleans — never word presence — are the source of
  // truth for routing. A mismatch against the model's own actionType is
  // genuine ambiguity, not something to silently resolve either direction.
  const derivedType = derivedTypeFromEvidence(envelope);
  if (derivedType !== envelope.actionType) {
    return {
      status: "clarify",
      question: `Do you want me to just message ${recipient}, or track this until it's done?`,
      reason: "actionType_evidence_mismatch",
    };
  }

  if (envelope.actionType === "interpersonal_communication") {
    return {
      status: "authorized",
      tool: "send_direct_whatsapp_message",
      params: { recipient_name: recipient, message: content },
    };
  }

  return {
    status: "authorized",
    tool: "send_delegation",
    params: { name: recipient, task: content },
  };
}
