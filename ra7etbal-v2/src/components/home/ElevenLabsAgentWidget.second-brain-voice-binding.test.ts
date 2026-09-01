/**
 * Second Brain Slice 2 — automatic voice-boundary binding injection at the
 * real Carson conversation start. Source-inspection tests, matching this
 * file's existing convention (see ElevenLabsAgentWidget.sdk-config.test.ts)
 * since the component is not unit-rendered anywhere in this repo.
 *
 * The gate must be off by default everywhere, including Production
 * Carson, and on only where VITE_ENABLE_CARSON_SECOND_BRAIN_VOICE="true"
 * is explicitly set (the isolated non-production project, while the
 * isolated live gate is being run).
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

describe("Second Brain voice-boundary gate — off by default, one canonical session path", () => {
  it("reads an explicit env flag, defaulting to disabled — a fresh name, not the parked Stage2A flag", () => {
    expect(SOURCE).toContain('import.meta.env.VITE_ENABLE_CARSON_SECOND_BRAIN_VOICE === "true"');
    expect(SOURCE).not.toContain("VITE_ENABLE_CARSON_STAGE2A_BINDING");
  });

  it("reuses the existing binding-issuance module instead of reimplementing it", () => {
    expect(SOURCE).toContain(
      'import { issueSecondBrainVoiceBinding, getSupabaseAccessToken as getSecondBrainVoiceAccessToken } from "../../lib/carson-second-brain-voice-binding";',
    );
  });

  it("still opens exactly one Conversation.startSession path — the gate does not add a second session/auth path", () => {
    expect(countOccurrences("Conversation.startSession(")).toBe(1);
  });

  it("fetches the binding before the connect timeout is armed, so the timer only ever bounds the actual SDK handshake", () => {
    const gateIndex = SOURCE.indexOf("if (secondBrainVoiceEnabled) {");
    const timeoutIndex = SOURCE.indexOf("connectTimeoutRef.current = setTimeout(", gateIndex);
    const startSessionIndex = SOURCE.indexOf("const conv = await Conversation.startSession({", gateIndex);
    expect(gateIndex).toBeGreaterThan(-1);
    expect(timeoutIndex).toBeGreaterThan(gateIndex);
    expect(startSessionIndex).toBeGreaterThan(timeoutIndex);
  });

  it("only attaches customLlmExtraBody when a binding was actually issued — conditional spread, never unconditional", () => {
    const optionsBlock = blockBetween(
      "const conv = await Conversation.startSession({",
      "clientTools: {",
    );
    expect(optionsBlock).toContain(
      "...(secondBrainCustomLlmExtraBody ? { customLlmExtraBody: secondBrainCustomLlmExtraBody } : {}),",
    );
    expect(optionsBlock).not.toContain("overrides");
  });

  it("fails closed — refuses to start the session when the gate is on and no binding was issued", () => {
    const gateBlock = blockBetween(
      "if (secondBrainVoiceEnabled) {",
      "const conv = await Conversation.startSession({",
    );
    expect(gateBlock).toContain('if (bindingResult.status !== "ready")');
    expect(gateBlock).toContain("throw new Error(");
  });

  it("never logs the binding — the gate block itself contains no console.* call", () => {
    const gateBlock = blockBetween(
      "if (secondBrainVoiceEnabled) {",
      "secondBrainCustomLlmExtraBody = { carson_second_brain_binding: bindingResult.binding };",
    );
    expect(gateBlock).not.toMatch(/console\.(log|info|warn|error|debug)/);
  });

  it("keeps secondBrainVoiceEnabled in startCarsonSession's dependency array (React hook correctness)", () => {
    const depsLine = SOURCE.split("\n").find((line) => line.includes("}, [agentId, secondBrainVoiceEnabled,"));
    expect(depsLine).toBeDefined();
  });
});
