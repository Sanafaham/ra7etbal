import { isSocialAcknowledgement } from "./carson-social";

export interface CarsonTerminalToolRejectionState {
  toolName: string;
  outcome: string;
  at: string;
}

const EXECUTION_CLAIM_PATTERN =
  /\b(?:they|[A-Z][a-z]+(?:\s+and\s+[A-Z][a-z]+)?)\s+(?:has|have)\s+it\b|\bit(?:'|’)s\s+done\b|\bi(?:'|’)?\s*(?:have|'ve|’ve)?\s*(?:sent|created|assigned|scheduled)\b|\b(?:message|task|delegation|follow-up|delivery)\s+(?:was\s+|has\s+been\s+)?(?:sent|created|assigned|scheduled|completed)\b|\bi(?:'|’)ll\s+(?:follow\s+up|task|message|send|assign|schedule)\b/i;

export class CarsonTerminalToolRejection extends Error {
  readonly toolName: string;

  constructor(toolName: string, outcome: string) {
    super(outcome);
    this.name = "CarsonTerminalToolRejection";
    this.toolName = toolName;
  }
}

/**
 * A rejected side effect is terminal for the current owner turn. If the
 * provider nevertheless generates completion language, keep the verified
 * policy outcome authoritative. The caller clears this state on the next
 * owner utterance, which may supply the missing information or start a new
 * request.
 */
export function resolveTerminalToolRejectionReply(
  agentMessage: string,
  rejection: CarsonTerminalToolRejectionState | null,
): string {
  if (!rejection || !EXECUTION_CLAIM_PATTERN.test(agentMessage)) return agentMessage;
  return rejection.outcome;
}

export function shouldClearTerminalToolRejection(ownerMessage: string): boolean {
  return !isSocialAcknowledgement(ownerMessage);
}
