import type { CarsonAuditResult } from "./carson-audit";
import type { AgentPlan, CarsonPlanResult, RequiredEntity } from "./carson-planner";

const TEXT_PREVIEW_LIMIT = 120;
const SHORT_PREVIEW_LIMIT = 80;

function preview(value: unknown, limit = TEXT_PREVIEW_LIMIT): string {
  if (typeof value !== "string") return "";
  const compact = value.replace(/\s+/g, " ").trim();
  if (compact.length <= limit) return compact;
  return `${compact.slice(0, limit - 1)}…`;
}

function summarizeRequiredEntity(entity: RequiredEntity) {
  return {
    name: entity.name,
    found: entity.found,
    value_preview: preview(entity.value, SHORT_PREVIEW_LIMIT),
  };
}

function summarizeAgentPlan(plan: AgentPlan) {
  return {
    agent_name: plan.agent_name,
    intent_preview: preview(plan.intent, SHORT_PREVIEW_LIMIT),
    proposed_action_types: plan.proposed_actions.map((action) => action.type),
    required_entities: plan.required_entities.map(summarizeRequiredEntity),
    missing_entities: plan.missing_entities,
    confidence: plan.confidence,
    user_facing_summary_preview: preview(plan.user_facing_summary, TEXT_PREVIEW_LIMIT),
    safe_to_execute: plan.safe_to_execute,
    risks: plan.risks.map((risk) => preview(risk, SHORT_PREVIEW_LIMIT)),
    errors: plan.errors.map((error) => preview(error, SHORT_PREVIEW_LIMIT)),
  };
}

export function summarizeCarsonPlanDiagnostic(
  transcript: string,
  plan: CarsonPlanResult,
) {
  return {
    transcript_preview: preview(transcript),
    router_result: {
      primary_domain: plan.router_result.primary_domain,
      domains: plan.router_result.domains,
      confidence: plan.router_result.confidence,
      clarification_question_preview: preview(
        plan.router_result.clarification_question,
        TEXT_PREVIEW_LIMIT,
      ),
      reason_preview: preview(plan.router_result.reason, SHORT_PREVIEW_LIMIT),
    },
    agent_plans: plan.agent_plans.map(summarizeAgentPlan),
    combined_summary_preview: preview(plan.combined_summary, TEXT_PREVIEW_LIMIT),
    blockers: plan.blockers.map((blocker) => preview(blocker, SHORT_PREVIEW_LIMIT)),
    safe_to_execute: plan.safe_to_execute,
    requires_human_approval: plan.requires_human_approval,
  };
}

export function summarizeCarsonAuditDiagnostic(audit: CarsonAuditResult) {
  return {
    transcript_preview: preview(audit.transcript),
    router_result: {
      primary_domain: audit.router_result.primary_domain,
      domains: audit.router_result.domains,
      confidence: audit.router_result.confidence,
    },
    agent_plans: audit.agent_plans.map(summarizeAgentPlan),
    production_result_summary_preview: preview(
      audit.production_result_summary,
      TEXT_PREVIEW_LIMIT,
    ),
    production_classification: {
      action_type: audit.production_classification.action_type,
      clarification_requested:
        audit.production_classification.clarification_requested,
      failed: audit.production_classification.failed,
      raw_preview: preview(audit.production_classification.raw, TEXT_PREVIEW_LIMIT),
    },
    matched_domains: audit.matched_domains,
    missing_expected_actions: audit.missing_expected_actions,
    unexpected_actions: audit.unexpected_actions,
    clarification_mismatch: audit.clarification_mismatch,
    errors: audit.errors.map((error) => preview(error, SHORT_PREVIEW_LIMIT)),
    audit_confidence: audit.audit_confidence,
  };
}
