import type { AgentPlan, CarsonPlanResult } from "./carson-planner";
import type { CarsonRoutingResult } from "./carson-router";

// ── Types ─────────────────────────────────────────────────────────────────────

export type ProductionActionType =
  | "delegation"
  | "whatsapp"
  | "reminder"
  | "calendar_query"
  | "calendar_create"
  | "calendar_update"
  | "calendar_delete"
  | "automation"
  | "memory"
  | "task"
  | "ops_plan"
  | "general_answer"
  | "social_ack"
  | "clarification"
  | "error"
  | "diagnostic"
  | "unknown";

export interface ProductionClassification {
  action_type: ProductionActionType;
  clarification_requested: boolean;
  failed: boolean;
  raw: string;
}

export interface CarsonAuditInput {
  transcript: string;
  plan: CarsonPlanResult;
  productionResult: string;
}

export interface CarsonAuditResult {
  transcript: string;
  router_result: CarsonRoutingResult;
  agent_plans: AgentPlan[];
  production_result_summary: string;
  production_classification: ProductionClassification;
  matched_domains: string[];
  missing_expected_actions: string[];
  unexpected_actions: string[];
  clarification_mismatch: boolean;
  errors: string[];
  audit_confidence: number;
}

// ── Production result inference ───────────────────────────────────────────────

const CLARIFICATION_PATTERNS: RegExp[] = [
  /I did not receive/i,
  /Ask the user/i,
  /Please ask/i,
  /Please say/i,
  /Please tell/i,
  /I need (both|the|your)/i,
  /need (to know|more|a )/i,
  /what (do|did|would) (you|they)/i,
  /could not find a person/i,
];

const ERROR_PATTERNS: RegExp[] = [
  /Could not process that\./i,
  /Please sign in/i,
  /not signed in/i,
  /You are not signed in/i,
  /could not reach the server/i,
  /couldn't verify your identity/i,
  /Please try again/i,
];

export function classifyProductionResult(result: string): ProductionClassification {
  const r = result.trim();

  const clarification_requested = CLARIFICATION_PATTERNS.some((p) => p.test(r));
  const failed = ERROR_PATTERNS.some((p) => p.test(r));

  let action_type: ProductionActionType = "unknown";

  if (failed && !clarification_requested) {
    action_type = "error";
  } else if (clarification_requested) {
    action_type = "clarification";
  } else if (/Diagnostic captured/i.test(r)) {
    action_type = "diagnostic";
  } else if (/CREATED:.*automation|automation is set|got that running|First check is/i.test(r)) {
    action_type = "automation";
  } else if (/CREATED: Reminder|Reminder saved|I'll remind you/i.test(r)) {
    action_type = "reminder";
  } else if (/Sent delegation|will ask|delegation to|has it\. I'll follow up|has the follow-up/i.test(r)) {
    action_type = "delegation";
  } else if (/Sent follow-up to/i.test(r)) {
    action_type = "delegation";
  } else if (/sent.*message|WhatsApp.*sent|message.*sent|It's with .*I'll watch for the reply/i.test(r) || /^Sent\b.*\bto\b/i.test(r)) {
    action_type = "whatsapp";
  } else if (/I'll send.*WhatsApp|send.*WhatsApp/i.test(r)) {
    action_type = "whatsapp";
  } else if (/added.*calendar|added.*event|Event added|event to your calendar/i.test(r)) {
    action_type = "calendar_create";
  } else if (/updated.*event|event.*updated/i.test(r)) {
    action_type = "calendar_update";
  } else if (/deleted.*event|event.*deleted|removed.*calendar|off your calendar/i.test(r)) {
    action_type = "calendar_delete";
  } else if (/No (calendar events|events found)|events? (found|for|in)/i.test(r) || /on your calendar/i.test(r) || /calendar events/i.test(r)) {
    action_type = "calendar_query";
  } else if (/Saved\.$|saved that|I('ll| will) remember|saved.*note|note saved/i.test(r)) {
    action_type = "memory";
  } else if (/Proposed plan|operations plan|I propose (to|a|that)/i.test(r)) {
    action_type = "ops_plan";
  } else if (/^(You're welcome\.?|Of course\.?|Anytime\.?)$/i.test(r)) {
    action_type = "social_ack";
  } else if (r.length > 40) {
    // Long result with no match → likely a general answer
    action_type = "general_answer";
  }

  return { action_type, clarification_requested, failed, raw: r.slice(0, 200) };
}

// ── Domain → expected production types ────────────────────────────────────────

const DOMAIN_TO_PRODUCTION: Record<string, ProductionActionType[]> = {
  delegation: ["delegation"],
  whatsapp: ["whatsapp"],
  reminder: ["reminder"],
  calendar: ["calendar_query", "calendar_create", "calendar_update", "calendar_delete"],
  memory: ["memory"],
  general_answer: ["general_answer"],
  social_ack: ["social_ack"],
  task: ["task", "delegation"],
  unknown: [],
};

// ── Audit orchestrator ─────────────────────────────────────────────────────────

/**
 * Compares what planCarsonInstruction expected vs what production actually did.
 * Pure function — no network I/O, no side effects.
 * Call site is responsible for catching errors and ensuring this never blocks production.
 */
export function auditCarsonExecution(input: CarsonAuditInput): CarsonAuditResult {
  const { transcript, plan, productionResult } = input;
  const { router_result, agent_plans, safe_to_execute, blockers } = plan;

  const production = classifyProductionResult(productionResult);
  const errors: string[] = [...(blockers.length > 0 ? [`planner_blockers: ${blockers.join(", ")}`] : [])];

  // Which planner domains matched the production action?
  const matchedDomains: string[] = [];
  for (const domain of router_result.domains) {
    const expected = DOMAIN_TO_PRODUCTION[domain] ?? [];
    if (expected.includes(production.action_type)) {
      matchedDomains.push(domain);
    }
  }

  // Missing expected actions: planner proposed action types that didn't happen
  const missingExpectedActions: string[] = [];
  for (const agentPlan of agent_plans) {
    if (agentPlan.safe_to_execute) {
      for (const action of agentPlan.proposed_actions) {
        const domainExpected = DOMAIN_TO_PRODUCTION[agentPlan.agent_name.replace("Agent", "")] ?? [];
        if (domainExpected.length > 0 && !domainExpected.includes(production.action_type)) {
          missingExpectedActions.push(`${agentPlan.agent_name}:${action.type}`);
        }
      }
    }
  }

  // Unexpected actions: production did something outside all planner domains
  const unexpectedActions: string[] = [];
  if (production.action_type !== "unknown" &&
      production.action_type !== "clarification" &&
      production.action_type !== "error" &&
      production.action_type !== "diagnostic") {
    const allExpected = router_result.domains.flatMap(
      (d) => DOMAIN_TO_PRODUCTION[d] ?? [],
    );
    if (!allExpected.includes(production.action_type)) {
      unexpectedActions.push(production.action_type);
    }
  }

  // Clarification mismatch:
  // - Planner said safe but production asked for clarification
  // - Planner said not safe (blockers) but production succeeded
  const clarificationMismatch =
    (safe_to_execute && production.clarification_requested) ||
    (!safe_to_execute && !production.clarification_requested && !production.failed &&
     production.action_type !== "unknown" &&
     production.action_type !== "social_ack");

  if (production.failed) {
    errors.push(`production_error: ${production.raw.slice(0, 80)}`);
  }

  // Audit confidence: how well do we understand what happened?
  let auditConfidence = 0.5;
  if (production.action_type !== "unknown") auditConfidence += 0.2;
  if (matchedDomains.length > 0) auditConfidence += 0.2;
  if (!clarificationMismatch) auditConfidence += 0.1;
  auditConfidence = Math.min(1.0, auditConfidence);

  return {
    transcript,
    router_result,
    agent_plans,
    production_result_summary: productionResult.slice(0, 120),
    production_classification: production,
    matched_domains: matchedDomains,
    missing_expected_actions: missingExpectedActions,
    unexpected_actions: unexpectedActions,
    clarification_mismatch: clarificationMismatch,
    errors,
    audit_confidence: auditConfidence,
  };
}
