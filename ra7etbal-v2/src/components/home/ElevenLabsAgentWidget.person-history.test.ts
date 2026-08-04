import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SOURCE = readFileSync(join(__dirname, "ElevenLabsAgentWidget.tsx"), "utf8");

describe("ElevenLabsAgentWidget — Historical Lookup Phase 2 (Person History)", () => {
  it("registers get_person_history as its own tool, wired like the other read-only history tools", () => {
    expect(SOURCE).toContain("get_person_history:");
    expect(SOURCE).toContain('guardCurrentToolInvocation("get_person_history")');
    expect(SOURCE).toContain('runDirectToolWithDiagnostic("get_person_history"');
    expect(SOURCE).toContain('lookupPersonHistory(params?.person_name ?? "")');
  });

  it("imports lookupPersonHistory from the same dedicated commitment-history module as Phase 1", () => {
    expect(SOURCE).toContain(
      'import { lookupCommitmentHistory, lookupPersonHistory } from "../../lib/carson-commitment-history";',
    );
  });

  it("keeps get_commitment_history registered and unmodified alongside the new tool", () => {
    expect(SOURCE).toContain("get_commitment_history:");
    expect(SOURCE).toContain('lookupCommitmentHistory(params?.keyword ?? "")');
  });
});
