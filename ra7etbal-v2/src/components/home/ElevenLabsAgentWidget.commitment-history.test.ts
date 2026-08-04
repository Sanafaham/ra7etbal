import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SOURCE = readFileSync(join(__dirname, "ElevenLabsAgentWidget.tsx"), "utf8");

describe("ElevenLabsAgentWidget — Historical Lookup Phase 1 (Q4 Commitment History)", () => {
  it("registers get_commitment_history as its own tool, wired like the other read-only history tools", () => {
    expect(SOURCE).toContain("get_commitment_history:");
    expect(SOURCE).toContain('guardCurrentToolInvocation("get_commitment_history")');
    expect(SOURCE).toContain('runDirectToolWithDiagnostic("get_commitment_history"');
    expect(SOURCE).toContain("lookupCommitmentHistory(params?.keyword ?? \"\")");
  });

  it("imports the implementation from the dedicated commitment-history module, not inline logic", () => {
    expect(SOURCE).toContain(
      'import { lookupCommitmentHistory, lookupPersonHistory } from "../../lib/carson-commitment-history";',
    );
  });

  it("keeps get_task_delivery_status and get_operations_summary registrations intact", () => {
    expect(SOURCE).toContain("get_task_delivery_status:");
    expect(SOURCE).toContain("get_operations_summary:");
    expect(SOURCE).toContain("fetchTaskDeliveryStatus(params?.keyword ?? \"\")");
    expect(SOURCE).toContain("fetchOperationsSummary()");
  });
});
