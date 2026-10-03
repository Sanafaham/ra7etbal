/**
 * EVIDENCE ONLY — the C-02 product policy (owner ruling 2026-09-30/10-01),
 * as a pure, versioned function.
 *
 * Inputs are ONLY the extracted natures and the explicit Carson instruction
 * types. By construction it cannot read wording, grammar, Ask vs Tell, or
 * relationship: none of those are parameters.
 *
 * Carson retains custody when the owner assigns an operational outcome for
 * Carson to get accomplished through another person, or explicitly asks
 * Carson to track, follow up, make sure, confirm or report back. Carson's
 * responsibility ends at truthful delivery for information, a personal
 * message/wish/invitation/request, or presence coordination with no
 * operational outcome. Unsupported Carson instructions hold the whole action.
 */
import type { InstructionType, Nature } from "./skill";

export const POLICY_VERSION = "c02-policy-2026-10-01";

export const CUSTODY_INSTRUCTIONS: ReadonlySet<InstructionType> = new Set(["track", "follow_up", "make_sure", "confirm", "report_back"]);
export const UNSUPPORTED_INSTRUCTIONS: ReadonlySet<InstructionType> = new Set(["remind_owner", "act_on_condition", "contact_other_person", "change_calendar", "other"]);

export type Route = "tracked" | "direct";

export interface PolicyDecision {
  version: string;
  route: Route;
  hold: boolean;
  unsupported: InstructionType[];
}

export function decideCustody(natures: readonly Nature[], instructions: readonly InstructionType[]): PolicyDecision {
  const operational = natures.includes("operational_outcome");
  const explicitCustody = instructions.some((t) => CUSTODY_INSTRUCTIONS.has(t));
  const unsupported = instructions.filter((t) => UNSUPPORTED_INSTRUCTIONS.has(t));
  return {
    version: POLICY_VERSION,
    route: operational || explicitCustody ? "tracked" : "direct",
    hold: unsupported.length > 0,
    unsupported,
  };
}
