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
  toolName: "execute_instruction" | "send_delegation" | "send_direct_whatsapp_message";
  kind: CanonicalConsequentialKind;
  resultText: string;
  outcome: "success" | "failure";
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
