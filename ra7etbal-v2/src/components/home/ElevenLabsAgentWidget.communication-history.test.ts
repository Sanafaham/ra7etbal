import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SOURCE = readFileSync(join(__dirname, "ElevenLabsAgentWidget.tsx"), "utf8");

describe("ElevenLabsAgentWidget — Workstream 4 Phase 1 (Unified Communication History)", () => {
  it("registers get_communication_history as its own tool, wired like the other read-only history tools", () => {
    expect(SOURCE).toContain("get_communication_history:");
    expect(SOURCE).toContain('guardCurrentToolInvocation("get_communication_history")');
    expect(SOURCE).toContain('runDirectToolWithDiagnostic("get_communication_history"');
    expect(SOURCE).toContain('lookupCommunicationHistory(params?.person_name ?? "")');
  });

  it("imports lookupCommunicationHistory from its own dedicated module, not the commitment-history module", () => {
    expect(SOURCE).toContain(
      'import { lookupCommunicationHistory } from "../../lib/carson-communication-history";',
    );
  });

  it("is absent from TYPED_BLOCKED_TOOL_MESSAGES — a read-only lookup must remain usable in typed mode", () => {
    const blockMapStart = SOURCE.indexOf("const TYPED_BLOCKED_TOOL_MESSAGES");
    const blockMapEnd = SOURCE.indexOf("};", blockMapStart);
    const blockMap = SOURCE.slice(blockMapStart, blockMapEnd);
    expect(blockMap).not.toContain("get_communication_history");
  });

  it("keeps get_commitment_history and get_person_history registered and unmodified alongside the new tool", () => {
    expect(SOURCE).toContain("get_commitment_history:");
    expect(SOURCE).toContain('lookupCommitmentHistory(params?.keyword ?? "")');
    expect(SOURCE).toContain("get_person_history:");
    expect(SOURCE).toContain('lookupPersonHistory(params?.person_name ?? "")');
    expect(SOURCE).toContain(
      'import { lookupCommitmentHistory, lookupPersonHistory } from "../../lib/carson-commitment-history";',
    );
  });
});
