import { describe, expect, it } from "vitest";

import type { CarsonAuditResult } from "./carson-audit";
import type { CarsonPlanResult } from "./carson-planner";
import {
  summarizeCarsonAuditDiagnostic,
  summarizeCarsonPlanDiagnostic,
} from "./carson-planner-diagnostics";

function buildPlan(longText: string): CarsonPlanResult {
  return {
    router_result: {
      primary_domain: "delegation",
      domains: ["delegation"],
      confidence: 0.9,
      reason: longText,
      needs_clarification: false,
      clarification_question: null,
    },
    agent_plans: [
      {
        agent_name: "delegation",
        intent: longText,
        proposed_actions: [
          {
            type: "send_delegation",
            task_text: longText,
            message: longText,
          },
        ],
        required_entities: [
          {
            name: "person",
            value: longText,
            found: true,
          },
        ],
        missing_entities: [],
        confidence: 0.8,
        user_facing_summary: longText,
        safe_to_execute: true,
        risks: [longText],
        errors: [],
      },
    ],
    combined_summary: longText,
    blockers: [],
    safe_to_execute: true,
    requires_human_approval: false,
  };
}

describe("carson planner diagnostics", () => {
  it("stores a short plan summary without raw proposed action bodies", () => {
    const sensitiveText =
      "Tell Christopher the private family travel schedule with all the detailed addresses and long personal notes that should not be stored fully.";
    const summary = summarizeCarsonPlanDiagnostic(sensitiveText, buildPlan(sensitiveText));

    expect(summary.transcript_preview.length).toBeLessThanOrEqual(120);
    expect(summary.agent_plans[0].proposed_action_types).toEqual(["send_delegation"]);
    expect(JSON.stringify(summary)).not.toContain("task_text");
    expect(JSON.stringify(summary)).not.toContain("message");
  });

  it("stores a short audit summary without full production raw text", () => {
    const longText =
      "I sent Christopher a very long private message with personal context and details that should be summarized instead of stored in full.";
    const plan = buildPlan(longText);
    const audit: CarsonAuditResult = {
      transcript: longText,
      router_result: plan.router_result,
      agent_plans: plan.agent_plans,
      production_result_summary: longText,
      production_classification: {
        action_type: "delegation",
        clarification_requested: false,
        failed: false,
        raw: longText,
      },
      matched_domains: ["delegation"],
      missing_expected_actions: [],
      unexpected_actions: [],
      clarification_mismatch: false,
      errors: [],
      audit_confidence: 1,
    };

    const summary = summarizeCarsonAuditDiagnostic(audit);

    expect(summary.production_classification.raw_preview.length).toBeLessThanOrEqual(120);
    expect(summary.production_classification.action_type).toBe("delegation");
    expect(JSON.stringify(summary)).not.toContain("\"raw\"");
    expect(JSON.stringify(summary)).not.toContain("production_result_summary\"");
  });
});
