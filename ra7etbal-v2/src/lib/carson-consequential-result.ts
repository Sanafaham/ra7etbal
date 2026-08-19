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
