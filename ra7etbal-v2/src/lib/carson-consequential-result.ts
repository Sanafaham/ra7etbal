/**
 * Canonical owner-facing result for a consequential Carson turn.
 *
 * ElevenLabs may still produce normal conversational text, but once a covered
 * tool has returned a validated consequential result, the owner-facing action
 * claim is this exact text. Binding it to the current owner turn prevents a
 * late/reconnected callback from presenting an older operation as current.
 */
export type CanonicalConsequentialKind =
  | "clarification"
  | "proposal"
  | "executed"
  | "cancelled"
  | "rejected"
  | "delegation"
  | "direct_message";

export interface CanonicalConsequentialResult {
  turnOperationId: string;
  domainOperationId?: string | null;
  toolName:
    | "execute_instruction"
    | "send_delegation"
    | "send_direct_whatsapp_message"
    | "create_calendar_event"
    | "update_calendar_event"
    | "delete_calendar_event";
  kind: CanonicalConsequentialKind;
  resultText: string;
  /**
   * "unclear" covers a genuine exception/timeout where the client never
   * learned whether the underlying mutation succeeded (e.g. execute_instruction's
   * network catch) — distinct from "failure", a verified non-mutation. Both
   * outcomes are treated identically by the resolvers below (neither is ever
   * success-shaped): the distinction exists so the owner-facing text can say
   * "I couldn't confirm that" rather than falsely implying a known failure.
   */
  outcome: "success" | "failure" | "unclear";
  at: string;
}

/**
 * Client-tool payload for a covered consequential voice turn. ElevenLabs
 * receives this after the validated tool completes. The owner result remains a
 * separate JSON value so the conversational model has no authority to
 * reinterpret recipients, state, delivery, failures, or clarification facts.
 */
export function buildCanonicalConsequentialSpeechPayload(resultText: string): string {
  return JSON.stringify({
    response_contract: "speak_owner_result_exactly_without_additions_or_changes",
    owner_result: resultText.trim(),
  });
}

export function resolveConsequentialInstructionSource(input: {
  capturedOwnerMessage: string | null | undefined;
  lastUserMessage: string | null | undefined;
  toolInstruction: string | null | undefined;
  lastUserIsVague: boolean;
  isHostingTurn: boolean;
}): string {
  const captured = input.capturedOwnerMessage?.trim() || input.lastUserMessage?.trim() || "";
  if (input.isHostingTurn) return captured;
  if (input.lastUserIsVague) return input.toolInstruction?.trim() || captured;
  return captured;
}

export function createCanonicalConsequentialResult(
  input: Omit<CanonicalConsequentialResult, "at"> & { at?: string },
): CanonicalConsequentialResult {
  return {
    ...input,
    resultText: input.resultText.trim(),
    at: input.at ?? new Date().toISOString(),
  };
}

export function resolveCanonicalConsequentialResult(
  result: CanonicalConsequentialResult | null,
  currentTurnOperationId: string | null,
): string | null {
  if (!result || !currentTurnOperationId) return null;
  if (result.turnOperationId !== currentTurnOperationId) return null;
  return result.resultText || null;
}

export function resolveConsequentialOwnerMessage(
  agentMessage: string,
  result: CanonicalConsequentialResult | null,
  currentTurnOperationId: string | null,
): string {
  return resolveCanonicalConsequentialResult(result, currentTurnOperationId) ?? agentMessage;
}

/**
 * A covered consequential tool can race ElevenLabs' own pre-tool-speech
 * utterance: that provisional segment lands as an earlier "agent" event in
 * the same turn, before the tool's real outcome is known and recorded here.
 * Once it is, this turn's second "agent" event must REPLACE the provisional
 * segment outright rather than being appended after it — appending would
 * either duplicate a success claim ("Grace has it. Grace has it.") or leave
 * a false claim sitting next to the truthful one ("Grace has it. I couldn't
 * send that message."). Returns true at most once per distinct recorded
 * result (tracked by `at`, the caller's job to persist and pass back as
 * `lastReplacedResultAt`) — this is what guarantees one execution produces
 * exactly one final owner-facing confirmation.
 *
 * Deliberately keyed on result identity, never on the text itself — the
 * decision holds regardless of what language the model happens to speak in.
 */
export function shouldReplaceProvisionalConsequentialSegment(
  result: CanonicalConsequentialResult | null,
  currentTurnOperationId: string | null,
  lastReplacedResultAt: string | null,
): boolean {
  if (!result || !currentTurnOperationId) return false;
  if (result.turnOperationId !== currentTurnOperationId) return false;
  return lastReplacedResultAt !== result.at;
}
