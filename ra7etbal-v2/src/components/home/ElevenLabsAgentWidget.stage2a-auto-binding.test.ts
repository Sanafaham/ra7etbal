/**
 * C-03 live gate — automatic Stage 2A owner-binding injection at the real
 * Carson conversation start. Source-inspection tests, matching this file's
 * existing convention (see ElevenLabsAgentWidget.sdk-config.test.ts) since
 * the component is not unit-rendered anywhere in this repo.
 *
 * The gate must be off (no behavior change) for Production Carson by
 * default, and on only where VITE_ENABLE_CARSON_STAGE2A_BINDING="true" is
 * explicitly set (the isolated non-production project, while the C-03 live
 * acceptance gate is being run) — see ElevenLabsAgentWidget.tsx's
 * `stage2aAutoBindingEnabled` and the comment directly above it.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SOURCE = readFileSync(join(__dirname, "ElevenLabsAgentWidget.tsx"), "utf-8");

function countOccurrences(needle: string): number {
  return SOURCE.split(needle).length - 1;
}

function blockBetween(startNeedle: string, endNeedle: string): string {
  const start = SOURCE.indexOf(startNeedle);
  const end = SOURCE.indexOf(endNeedle, start);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return SOURCE.slice(start, end);
}

describe("Stage 2A auto-binding gate — off by default, one canonical session path", () => {
  it("reads an explicit env flag, defaulting to disabled (no === \"true\" means off)", () => {
    expect(SOURCE).toContain('import.meta.env.VITE_ENABLE_CARSON_STAGE2A_BINDING === "true"');
  });

  it("reuses the existing binding-issuance module instead of reimplementing it", () => {
    expect(SOURCE).toContain(
      'import { issueStage2ABinding, getSupabaseAccessToken as getStage2ASupabaseAccessToken } from "../../routes/CarsonStage2ABinding";',
    );
  });

  it("still opens exactly one Conversation.startSession path — the gate does not add a second session/auth path", () => {
    expect(countOccurrences("Conversation.startSession(")).toBe(1);
  });

  it("only attaches customLlmExtraBody when a binding was actually issued (conditional spread, never unconditional)", () => {
    const optionsBlock = blockBetween(
      "const conv = await Conversation.startSession({",
      "clientTools: {",
    );
    expect(optionsBlock).toContain(
      "...(stage2aCustomLlmExtraBody ? { customLlmExtraBody: stage2aCustomLlmExtraBody } : {}),",
    );
    // Still no experimental overrides field — the C-03 gate must not
    // reopen the "overrides can break the session handshake" regression.
    expect(optionsBlock).not.toContain("overrides");
  });

  it("fails closed — refuses to start the session when the gate is on and no binding was issued", () => {
    const gateBlock = blockBetween(
      "if (stage2aAutoBindingEnabled) {",
      "const conv = await Conversation.startSession({",
    );
    expect(gateBlock).toContain('if (bindingResult.status !== "ready")');
    expect(gateBlock).toContain("throw new Error(");
    // The failure must route into the existing catch block (proven error
    // UX), not a new bespoke error path.
    expect(SOURCE.indexOf("} catch (err) {", SOURCE.indexOf("if (stage2aAutoBindingEnabled) {"))).toBeGreaterThan(-1);
  });

  it("never logs the binding — the gate block itself contains no console.* call", () => {
    const gateBlock = blockBetween(
      "if (stage2aAutoBindingEnabled) {",
      "stage2aCustomLlmExtraBody = { carson_stage2a_binding: bindingResult.binding };",
    );
    expect(gateBlock).not.toMatch(/console\.(log|info|warn|error|debug)/);
  });

  it("keeps stage2aAutoBindingEnabled in startCarsonSession's dependency array (React hook correctness)", () => {
    const depsLine = SOURCE.split("\n").find((line) => line.includes("}, [agentId, stage2aAutoBindingEnabled,"));
    expect(depsLine).toBeDefined();
  });
});
