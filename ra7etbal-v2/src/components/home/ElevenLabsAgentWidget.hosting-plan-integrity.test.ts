import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SOURCE = readFileSync(join(__dirname, "ElevenLabsAgentWidget.tsx"), "utf-8");

describe("ElevenLabsAgentWidget — canonical hosting continuation integrity", () => {
  it("runs the leading-confirmation integrity guard before fresh hosting orchestration", () => {
    const guardIndex = SOURCE.indexOf("hasLeadingConfirmationLanguage(rawInstruction)");
    const continuationIndex = SOURCE.indexOf(
      "const hostingContinuation = await runHostingContinuation(rawInstruction, people)",
      guardIndex,
    );
    expect(guardIndex).toBeGreaterThan(-1);
    expect(continuationIndex).toBeGreaterThan(guardIndex);
  });

  it("has one adapter helper that selects and applies the registry result", () => {
    const start = SOURCE.indexOf("const runHostingContinuation = useCallback(async (");
    const end = SOURCE.indexOf("/** Last executed weekly plan", start);
    const block = SOURCE.slice(start, end);
    expect(block).toContain("runActionContinuation({");
    expect(block).toContain("pendingHostingContinuationRef.current = result.state");
    expect(block).toContain('result.state?.kind === "clarification"');
    expect(block).toContain('result.state?.kind === "approval"');
  });

  it("routes execute_instruction approval through the canonical helper and records its actual result", () => {
    const start = SOURCE.indexOf("if (activePlan) {");
    const end = SOURCE.indexOf("// ── Carson Weekly Planning V1", start);
    const block = SOURCE.slice(start, end);
    expect(block).toContain('pendingHostingContinuationRef.current = { kind: "approval", plan: activePlan }');
    expect(block).toContain("await runHostingContinuation(");
    expect(block).toContain('continuation.status === "completed"');
    expect(block).toContain('continuation.status === "cancelled"');
    expect(block).toContain("resultText: continuation.message");
  });

  it("contains no adapter-local hosting parser or plan builder", () => {
    expect(SOURCE).not.toContain("evaluateHostingPlanningGate(");
    expect(SOURCE).not.toContain("buildOperationalPlanFromOutcome(");
  });
});
