export interface ReminderToolInput {
  description: string;
  time_text?: string;
  due_at?: string;
}

export interface OneTimeAutomationToolInput {
  title: string;
  instruction: string;
  cadence_phrase: "once";
  first_run_text?: string;
  first_run_at?: string;
  assignee_name?: string;
}

export const ONE_TIME_ROUTING_CONTRACT_VERSION = "one-time-routing-v1" as const;

export interface OneTimeRoutingEvidence {
  contract_version: typeof ONE_TIME_ROUTING_CONTRACT_VERSION;
  destination: "owner_reminder" | "one_time_automation";
  decision_source: "fresh_user_transcript";
  client_build: string;
  operation_id: string;
}

export interface FreshRoutingTurn {
  eventId: number | null;
  message: string;
  claimed: boolean;
  operationId: string;
}

export type RoutingTurnClaim =
  | { ok: true; message: string; context: FreshRoutingTurn }
  | { ok: false; reasonCode: "fresh_transcript_unavailable" | "turn_already_claimed" };

export function claimFreshRoutingTurn(context: FreshRoutingTurn | null): RoutingTurnClaim {
  if (!context) return { ok: false, reasonCode: "fresh_transcript_unavailable" };
  if (context.claimed) return { ok: false, reasonCode: "turn_already_claimed" };
  return { ok: true, message: context.message, context: { ...context, claimed: true } };
}

export type OneTimeAutomationRoutingDecision =
  | { kind: "reminder" }
  | { kind: "automation"; params: OneTimeAutomationToolInput }
  | { kind: "blocked"; message: string };

const EXPLICIT_AUTOMATION_RE = /\bautomation\b/i;
const RECURRING_AUTOMATION_RE =
  /\b(?:daily|weekly|monthly|every\s+(?:day|week|month|morning|afternoon|evening|night|\d+\s+days?|monday|tuesday|wednesday|thursday|friday|saturday|sunday)|each\s+(?:day|morning|afternoon|evening|night)|recurring|regularly)\b/i;
const RECIPIENT_SHAPED_RE = /\b(?:send|ask|tell|have|get|assign)\s+[\p{L}][\p{L}'’.-]*/iu;
const OWNER_REMINDER_RE = /\bremind\s+me\b/i;
const IMMEDIATE_TIME_RE = /\b(?:now|right\s+now|immediately)\b/i;

export function hasExplicitNonRecurringAutomationIntent(text: string | null | undefined): boolean {
  if (!text) return false;
  return EXPLICIT_AUTOMATION_RE.test(text) && !RECURRING_AUTOMATION_RE.test(text);
}

function findKnownRecipient(text: string, knownPeopleNames: string[]): string | null {
  const normalizedText = text.normalize("NFKC");
  return (
    [...knownPeopleNames]
      .map((name) => name.trim())
      .filter(Boolean)
      .sort((a, b) => b.length - a.length)
      .find((name) => {
        const escapedName = name
          .normalize("NFKC")
          .replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        // Unicode letters, combining marks, and numbers are name-token
        // characters. Requiring a non-token boundary on both sides prevents
        // short contacts from matching inside unrelated words or longer
        // names, while still allowing punctuation such as Grace's task.
        const exactMention = new RegExp(
          `(?:^|[^\\p{L}\\p{M}\\p{N}])${escapedName}(?=$|[^\\p{L}\\p{M}\\p{N}])`,
          "iu",
        );
        return exactMention.test(normalizedText);
      }) ?? null
  );
}

export function buildOneTimeRoutingEvidence(
  destination: OneTimeRoutingEvidence["destination"],
  clientBuild: string,
  operationId: string,
): OneTimeRoutingEvidence {
  return {
    contract_version: ONE_TIME_ROUTING_CONTRACT_VERSION,
    destination,
    decision_source: "fresh_user_transcript",
    client_build: clientBuild || "unknown",
    operation_id: operationId,
  };
}

function automationTitle(description: string): string {
  const normalized = description.trim().replace(/\s+/g, " ");
  return normalized.length <= 80 ? normalized : `${normalized.slice(0, 77).trimEnd()}…`;
}

/**
 * Deterministic tool-boundary protection for a known agent-routing failure.
 *
 * ElevenLabs may choose create_reminder even when the owner's latest utterance
 * explicitly asks for a one-time automation. When that happens, route the
 * already-structured reminder fields through the canonical create_automation
 * implementation. Never create an owner reminder as a fallback.
 */
export function routeExplicitOneTimeAutomation({
  latestUserMessage,
  reminder,
  knownPeopleNames,
}: {
  latestUserMessage: string | null | undefined;
  reminder: ReminderToolInput;
  knownPeopleNames: string[];
}): OneTimeAutomationRoutingDecision {
  const instruction = reminder.description?.trim();
  if (!instruction) {
    return {
      kind: "blocked",
      message: "I could not create that automation because the task instruction was missing. Please say it again.",
    };
  }

  const firstRunText = reminder.time_text?.trim();
  const firstRunAt = reminder.due_at?.trim();
  if (!firstRunText && !firstRunAt) {
    return {
      kind: "blocked",
      message: "I could not create that automation because the run time was missing. Please say when it should run.",
    };
  }

  const utterance = latestUserMessage ?? "";
  if (RECURRING_AUTOMATION_RE.test(utterance)) {
    return { kind: "reminder" };
  }
  const assigneeName = findKnownRecipient(utterance, knownPeopleNames);
  const explicitOwnerReminder = OWNER_REMINDER_RE.test(utterance);
  const scheduledDelegation =
    !explicitOwnerReminder &&
    !IMMEDIATE_TIME_RE.test(reminder.time_text ?? "") &&
    RECIPIENT_SHAPED_RE.test(utterance) &&
    Boolean(assigneeName) &&
    Boolean(reminder.time_text?.trim() || reminder.due_at?.trim());

  if (!hasExplicitNonRecurringAutomationIntent(latestUserMessage) && !scheduledDelegation) {
    return { kind: "reminder" };
  }

  if (RECIPIENT_SHAPED_RE.test(utterance) && !assigneeName) {
    return {
      kind: "blocked",
      message: "I could not match the automation recipient to your contacts. Please check the name and try again.",
    };
  }

  return {
    kind: "automation",
    params: {
      title: automationTitle(instruction),
      instruction,
      cadence_phrase: "once",
      ...(firstRunText ? { first_run_text: firstRunText } : { first_run_at: firstRunAt }),
      ...(assigneeName ? { assignee_name: assigneeName } : {}),
    },
  };
}
