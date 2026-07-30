import type { Person } from "../types/person";
import { evaluateCarsonToolPolicy } from "./carson-tool-policy";

export interface CarsonRoutingOwner {
  utterance: string;
  intent: string;
}

/**
 * Selects the capability owner once from the owner transcript. Tool choice and
 * tool arguments are deliberately excluded: they are downstream of ownership.
 */
export function selectCarsonRoutingOwner(input: {
  utterance: string;
  people: Pick<Person, "name">[];
  hasActiveHostingClarification?: boolean;
}): CarsonRoutingOwner {
  const utterance = input.utterance.trim();
  const decision = evaluateCarsonToolPolicy({
    utterance,
    channel: "voice",
    selectedTool: "execute_instruction",
    toolArguments: { instruction: utterance },
    people: input.people,
    hasActiveHostingClarification: input.hasActiveHostingClarification,
  });
  return { utterance, intent: decision.intent };
}

export function routingOwnerAllowsPeopleAction(owner: CarsonRoutingOwner): boolean {
  return owner.intent === "direct_communication" || owner.intent === "delegation";
}

export function retainCarsonRoutingOwner(
  current: CarsonRoutingOwner | null,
  input: Parameters<typeof selectCarsonRoutingOwner>[0],
): CarsonRoutingOwner {
  const utterance = input.utterance.trim();
  return current?.utterance === utterance
    ? current
    : selectCarsonRoutingOwner({ ...input, utterance });
}
